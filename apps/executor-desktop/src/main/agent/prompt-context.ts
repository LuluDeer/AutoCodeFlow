/**
 * P7a 续（2026-10-28）：规划/诊断上下文的**预算化构建**。
 *
 * ## 修的是什么
 * 此前 `runtime.ts` 里是这么做的：
 *
 * ```ts
 * JSON.stringify({ sop, environment, workspaceFiles, ... }, null, 1).slice(0, 96 * 1024)
 * ```
 *
 * 三处后果，都不是"理论上"的：
 *   ① **JSON 被切断**。96KB 处正好落在某个字符串/对象中间时，模型收到的是一份
 *      **语法不完整的 JSON**——它要么解析失败后在正文里瞎猜，要么把尾巴当成
 *      新指令。上下文是我们唯一的"事实输入"，给它半份事实比不给更糟。
 *   ② **截断顺序反了**。`sop` 排在最前、`permissions` 排在最后：SOP 正文一长，
 *      被切掉的恰恰是**权限档位**（能跑什么解释器、能开哪个网站、GUI 白名单）。
 *      模型据此产出的实现会被平台拒绝，白烧一轮试跑。
 *   ③ **预算不可见**。模型不知道自己看到的是残缺上下文，于是把"没看到"当成
 *      "不存在"（例如以为没有 workspace 文件，重复创建）。
 *
 * ## 做法
 * 先按**字段**截断（每段都留 `…（已截断 N 字符）` 标记），再整体校验总量；
 * 超了就用一套固定的收紧序列重算（SOP 正文 → 观察 → 澄清历史 → 文件列表），
 * **永不对序列化后的字符串动刀**——输出永远是合法 JSON。
 *
 * 优先级（谁先被牺牲）按"模型下一步能不能干活"排：
 *   SOP 的 title/version/frontMatter（含 acceptance、capabilities）**永不截断**
 *   → 权限档位（截断就会产出必被平台拒绝的实现）→ 环境探测 → SOP 正文
 *   → 目录列表 → 观察输出 → 澄清历史（最旧先丢）。
 *
 * 与本仓中台侧 `agent-context.ts` 的分工：那边折的是**多轮消息**（会话内），
 * 这边压的是**单轮上下文载荷**（一次请求）。两者都是"请求侧纯计算"，都不改写
 * 任何落库事实。
 */

/** 单轮上下文预算（字符数）。中台 qwen 默认 4096 输出令牌，这里给输入留足空间。 */
export interface ContextBudget {
  /** 序列化后的总长度上限。 */
  totalChars: number;
  /** SOP 正文上限。 */
  sopBodyChars: number;
  /** 目录列表最多列几条。 */
  workspaceFiles: number;
  /** 浏览器/GUI 观察各自的上限。 */
  observationChars: number;
  /** 澄清历史最多保留几轮（最旧先丢）。 */
  clarificationRounds: number;
  /** 单条澄清答复上限。 */
  clarificationAnswerChars: number;
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  totalChars: 48 * 1024,
  sopBodyChars: 20 * 1024,
  workspaceFiles: 80,
  observationChars: 6 * 1024,
  clarificationRounds: 4,
  clarificationAnswerChars: 2 * 1024,
};

/**
 * 收紧序列：总量超限时按序降档，取第一个装得下的。
 *
 * 为什么是**固定序列**而不是"按比例缩放"：比例缩放会让同一份 SOP 在不同
 * 机器上被截成不同长度（环境探测体积不同），排查时"为什么这次没看到那段
 * SOP"变成不可复现的问题。固定档位 + `contextTruncated` 标记，结论可复现。
 *
 * 以**传入预算为基准**逐档收紧（而不是写死 48KB 那套），这样自定义预算
 * （测试/未来按模型窗口调档）也能走同一条降档路径。
 */
function shrinkSchedule(budget: ContextBudget): ContextBudget[] {
  const cap = (v: number, max: number): number => Math.min(v, max);
  return [
    budget,
    {
      ...budget,
      sopBodyChars: cap(budget.sopBodyChars, 8 * 1024),
      observationChars: cap(budget.observationChars, 4 * 1024),
    },
    {
      ...budget,
      sopBodyChars: cap(budget.sopBodyChars, 4 * 1024),
      observationChars: cap(budget.observationChars, 2 * 1024),
      clarificationRounds: cap(budget.clarificationRounds, 2),
    },
    {
      ...budget,
      sopBodyChars: cap(budget.sopBodyChars, 2 * 1024),
      observationChars: 0,
      clarificationRounds: cap(budget.clarificationRounds, 1),
      workspaceFiles: cap(budget.workspaceFiles, 40),
    },
    {
      ...budget,
      sopBodyChars: cap(budget.sopBodyChars, 1024),
      observationChars: 0,
      clarificationRounds: 0,
      workspaceFiles: cap(budget.workspaceFiles, 20),
    },
    {
      ...budget,
      sopBodyChars: cap(budget.sopBodyChars, 512),
      observationChars: 0,
      clarificationRounds: 0,
      workspaceFiles: cap(budget.workspaceFiles, 10),
    },
  ];
}

/** 构建上下文的输入（与 `RuntimeDeps` 同形，但只取需要进 prompt 的部分）。 */
export interface AgentContextInput {
  sop: {
    slug: string;
    title: string;
    version: string;
    contentHash: string;
    frontMatter: Record<string, unknown>;
    bodyMarkdown: string;
  };
  environment: unknown;
  workspaceFiles: string[];
  lastBrowserOutputs?: string;
  lastGuiOutputs?: string;
  lastGuiImages?: string[];
  clarificationHistory?: Array<{
    round: number;
    question: string;
    answer: string;
    resolution: string;
    newSopVersion?: string | null;
  }>;
  permissions: {
    /** 档位原值：'off' | 'sandbox' | 'host'（模型据此决定要不要写可执行代码）。 */
    codeExecution: string;
    browserAllowed: boolean;
    allowedDomains: string[];
    guiAllowed: boolean;
    allowedApps: string[];
    note?: string;
  };
}

/** 截断标记（模型必须知道"材料被截过"，否则会把"没看到"当成"不存在"）。 */
function marker(omitted: number): string {
  return `…（已截断 ${omitted} 字符）`;
}

function cut(
  value: string | null | undefined,
  max: number,
  field: string,
  truncated: string[],
): string {
  const s = typeof value === "string" ? value : "";
  if (s.length <= max) return s;
  truncated.push(field);
  return s.slice(0, Math.max(0, max)) + marker(s.length - max);
}

/**
 * 递归压任意结构里的字符串与数组长度（用于 frontMatter / environment 这类
 * 形状不固定的段）。
 *
 * 为什么需要它：SOP frontMatter 由**中台发布者**撰写，acceptance 里塞几十条
 * 长命令是现实存在的；不递归压，单靠顶层字段预算仍然会被一条长字符串顶爆。
 */
export function deepCap(
  value: unknown,
  opts: { maxString: number; maxItems: number },
  depth = 0,
  truncated?: string[],
  path = "",
): unknown {
  if (depth > 8) return null;
  if (typeof value === "string") {
    if (value.length <= opts.maxString) return value;
    truncated?.push(path || "value");
    return value.slice(0, opts.maxString) + marker(value.length - opts.maxString);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, opts.maxItems)
      .map((v, i) => deepCap(v, opts, depth + 1, truncated, `${path}[${i}]`));
    return items;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepCap(v, opts, depth + 1, truncated, path ? `${path}.${k}` : k);
    }
    return out;
  }
  return null;
}

/** 按一份预算构建（内部：单次尝试）。 */
function buildWithBudget(
  input: AgentContextInput,
  budget: ContextBudget,
): { json: string; truncated: string[]; dropped: string[] } {
  const truncated: string[] = [];
  const dropped: string[] = [];

  // SOP：title/version/contentHash/frontMatter 是**执行依据**（acceptance、
  // capabilities），永不整体丢弃；正文是"指导"，最该被压。
  const sop = {
    slug: cut(input.sop.slug, 200, "sop.slug", truncated),
    title: cut(input.sop.title, 300, "sop.title", truncated),
    version: cut(input.sop.version, 100, "sop.version", truncated),
    contentHash: cut(input.sop.contentHash, 100, "sop.contentHash", truncated),
    frontMatter: deepCap(
      input.sop.frontMatter ?? {},
      { maxString: 1_000, maxItems: 40 },
      0,
      truncated,
      "sop.frontMatter",
    ),
  } as Record<string, unknown>;

  if (budget.sopBodyChars > 0) {
    sop.body = cut(
      input.sop.bodyMarkdown,
      budget.sopBodyChars,
      "sop.body",
      truncated,
    );
  } else {
    dropped.push("sop.body");
  }

  const workspaceFiles = input.workspaceFiles.slice(0, budget.workspaceFiles);
  if (input.workspaceFiles.length > workspaceFiles.length) {
    dropped.push(
      `workspaceFiles(${input.workspaceFiles.length - workspaceFiles.length} 条)`,
    );
  }

  const observations: Record<string, unknown> = {};
  if (budget.observationChars > 0) {
    if (input.lastBrowserOutputs) {
      observations.lastBrowserOutputs = cut(
        input.lastBrowserOutputs,
        budget.observationChars,
        "lastBrowserOutputs",
        truncated,
      );
    }
    if (input.lastGuiOutputs) {
      observations.lastGuiOutputs = cut(
        input.lastGuiOutputs,
        budget.observationChars,
        "lastGuiOutputs",
        truncated,
      );
    }
  } else if (input.lastBrowserOutputs || input.lastGuiOutputs) {
    dropped.push("lastBrowserOutputs", "lastGuiOutputs");
  }
  if (input.lastGuiImages?.length) {
    observations.lastGuiImages = input.lastGuiImages.slice(0, 4);
    if (input.lastGuiImages.length > 4) dropped.push("lastGuiImages(超出 4 张)");
  }

  // 澄清历史：最旧的先丢（最近的问答才是"刚补的信息"）
  let history: unknown;
  if (budget.clarificationRounds > 0 && input.clarificationHistory?.length) {
    const kept = input.clarificationHistory.slice(-budget.clarificationRounds);
    if (kept.length < input.clarificationHistory.length) {
      dropped.push(
        `clarificationHistory(${input.clarificationHistory.length - kept.length} 轮较旧)`,
      );
    }
    history = kept.map((h) => ({
      round: h.round,
      question: cut(h.question, budget.clarificationAnswerChars, "clarification.question", truncated),
      answer: cut(h.answer, budget.clarificationAnswerChars, "clarification.answer", truncated),
      resolution: cut(h.resolution, 200, "clarification.resolution", truncated),
      newSopVersion: h.newSopVersion ?? null,
    }));
  } else if (input.clarificationHistory?.length) {
    dropped.push("clarificationHistory");
  }

  const doc: Record<string, unknown> = {
    sop,
    environment: deepCap(
      input.environment ?? {},
      { maxString: 400, maxItems: 30 },
      0,
      truncated,
      "environment",
    ),
    workspaceFiles,
    ...(Object.keys(observations).length ? observations : {}),
    ...(history ? { clarificationHistory: history } : {}),
    permissions: {
      codeExecution: input.permissions.codeExecution,
      browserAllowed: input.permissions.browserAllowed,
      allowedDomains: input.permissions.allowedDomains.slice(0, 30),
      guiAllowed: input.permissions.guiAllowed,
      allowedApps: input.permissions.guiAllowed
        ? input.permissions.allowedApps.slice(0, 30)
        : [],
      note:
        input.permissions.note ??
        "host 档未实现；工作区外路径与非白名单解释器会被平台拒绝",
    },
    // 让模型知道哪几段不完整——"没看到"不等于"不存在"
    ...(truncated.length || dropped.length
      ? {
          contextTruncated: {
            truncatedFields: truncated,
            droppedSections: dropped,
            note: "以上字段/段落在送入模型前被截断或省略（体积预算），不代表它们不存在。",
          },
        }
      : {}),
  };

  return { json: JSON.stringify(doc, null, 1), truncated, dropped };
}

/**
 * 构建进 prompt 的上下文 JSON（**保证合法 JSON**，长度受 `budget` 约束）。
 *
 * 收紧是**确定性的**：同一份输入 + 同一份预算总是产出同一段文本（排查可复现）。
 * 极端超大输入会一路收到最后一档，此时仍然返回合法 JSON——宁可少给材料，
 * 也不给一份断掉的文档。
 */
export function buildAgentContext(
  input: AgentContextInput,
  budget: ContextBudget = DEFAULT_CONTEXT_BUDGET,
): string {
  let last = "";
  for (const step of shrinkSchedule(budget)) {
    const { json } = buildWithBudget(input, step);
    last = json;
    if (json.length <= step.totalChars) return json;
  }
  // 最紧一档仍超限：返回它（合法 JSON，只是材料更少）。
  // **绝不**对序列化结果做 slice —— 那会产出断掉的 JSON，比"材料少"糟得多。
  return last;
}
