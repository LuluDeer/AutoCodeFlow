import type { MultimodalMessage, MultimodalPart } from "../../ai/ai.service";

/**
 * 推理质量轮（2026-10）：上下文窗口管理（设计文档 02 §4.3 的**滑动窗口**一格）。
 *
 * ## 缺口是什么
 * 02 §4.3 列了三种手段：工具结果截断（已实现，2000 字符）、滑动窗口
 * （**此前只有读侧没有写侧**）、会话隔离（parentSessionId）。读侧指的是
 * `stepToMessages` 认识 `step.summary`（折叠步用摘要替身），写侧指的是
 * 「谁把早期步折叠掉」——这一半一直没人做。
 *
 * 后果不是"理论上会出错"，而是**长会话必然死在半路**：多轮 tool-calling 的
 * 消息按「轮次 × 工具结果」线性增长，20 轮的上限配上 2000 字符的结果上限，
 * 最坏可达数万 token。一旦越过模型窗口，上游直接 400（`context length
 * exceeded`），会话收敛为 failed——而失败原因看起来像"链路坏"，实际是
 * **我们自己的上下文没管**。而 400 恰恰是**不可重试**的（见 agent-llm-retry.ts）。
 *
 * ## 为什么在**请求侧**折叠，而不是改写 DB 的 steps
 * 折叠只影响「这一次请求给模型看什么」，不影响「台账记了什么」：
 *   · steps 是审计与复盘的事实（会话详情页、`resume` 重建的唯一数据源），
 *     为了省窗口去改写它，等于把历史删掉；
 *   · 折叠必须是**无副作用、可重复**的纯计算——每次进入循环都从同一份
 *     steps 重建 + 折叠，结果一致；这样崩溃重启、审批恢复、重复入队都走
 *     同一条路径（与 run() 的可重入纪律同源）。
 *
 * ## 折叠内容为什么是**确定性摘要**，而不是再调一次模型
 * 参考实现（langchain `SummarizationMiddleware`）用一个「摘要模型」生成
 * 摘要。本实现刻意**不**这样做，三条理由：
 *   ① 成本与延迟：摘要本身就是一次 LLM 调用，而它每次折叠都要重算——
 *      在"会话已经很长"的时刻再插一次长调用，正好是最容易再失败的时刻；
 *   ② 递归风险：摘要调用自己也可能超窗口（参考实现为此额外写了
 *      `_trim_messages_for_summary` 与"溢出重试"两段逻辑），复杂度陡增；
 *   ③ 可测性：确定性摘要能被单测逐字钉住。
 * 模型真正需要的是「早前发生过什么、结论是什么」，而不是优美的行文——
 * 逐条事件的行式摘要足够，且**不编造**（参考实现的摘要模型有幻觉风险：
 * 把没发生的工具调用写进历史，会把后续推理带到错误的起点上）。
 * 需要原文时，模型可以用 `get_tool_call_result` 回读（结果落库一直在）。
 *
 * ## 配对安全（这是最容易被忽略的一条）
 * OpenAI 兼容协议要求：assistant 的每个 `tool_calls[].id` 都必须有对应的
 * `role=tool` 应答，且 tool 消息不得脱离其 assistant。因此折叠的切割点
 * **只能落在"组"边界**上——一个组 = 「带 tool_calls 的 assistant + 它的全部
 * tool 应答」。切在组内会让保留下来的 tool 消息悬空，上游同样 400。
 * 参考实现 `_find_safe_cutoff_point` 用回退搜索解决同一问题；本模块按组
 * 切割是更强的保证（组内永远不会被拆开），代价是折叠粒度略粗——可接受。
 */

/** 一条消息的估算 token 开销（协议包装开销，与 langchain 同量级）。 */
const PER_MESSAGE_OVERHEAD_TOKENS = 4;

/**
 * 图片估算 token。
 *
 * qwen-vl 对一张图的实际计费在千级 token 量级（与分辨率相关）。这里取常数
 * 而不是解析尺寸：上下文闸门只需要**量级正确**，估小会漏折叠、估大只是多
 * 折叠一点历史——两个方向的代价都不对称，故取偏大的常数。
 */
const PER_IMAGE_TOKENS = 1_024;

/** 折叠摘要里单条事件的最大字符数（超过即截断，防摘要自己膨胀）。 */
const DIGEST_LINE_MAX_CHARS = 160;

/** 上下文窗口策略。 */
export interface ContextWindowOptions {
  /** 估算 token 上限：超过即折叠早期消息（含 system 的预算）。 */
  maxTokens: number;
  /**
   * 折叠时必须保留的最近消息条数（下限）。
   *
   * 为什么要有下限而不是"塞到刚好不超"：模型对**最近几轮**的依赖远大于
   * 早期轮次，而 `maxTokens` 是估算值（有误差）。宁可略微超过估算上限，
   * 也不要因为估算偏差把「刚刚看到的工具结果」折掉——那会让模型在下一步
   * 重复调用同一个工具。
   */
  minRecentMessages: number;
  /** 折叠摘要的总字符上限。 */
  digestMaxChars: number;
}

/**
 * 默认值。
 *
 * `maxTokens = 24k`：保守对齐 32k 窗口的模型（qwen 系列），给输出与
 * 估算误差留出空间。宁可早折叠，不可撞 400——一次 400 就是一整个会话作废。
 * `minRecentMessages = 12`：约「3 轮完整 tool-calling」，够模型接着干活。
 */
export const DEFAULT_CONTEXT_WINDOW: ContextWindowOptions = {
  maxTokens: 24_000,
  minRecentMessages: 12,
  digestMaxChars: 4_000,
};

/** 折叠计划（纯数据，便于日志与断言）。 */
export interface ContextWindowPlan {
  /** 实际要发给模型的 messages。 */
  messages: MultimodalMessage[];
  /** 被折叠进摘要的消息条数（0 = 未折叠）。 */
  foldedMessages: number;
  /** 折叠前的估算 token。 */
  tokensBefore: number;
  /** 折叠后的估算 token。 */
  tokensAfter: number;
  /** 生成的摘要文本（未折叠时为 null）。 */
  digest: string | null;
}

/**
 * 估算一个片段的 token。
 *
 * 为什么用启发式而不是 tokenizer：本项目要支持的 provider 不止一家
 * （qwen / openai / ollama），各自 tokenizer 不同且都要额外依赖。闸门需要的
 * 是「量级正确 + 单调」，不是精确计费——精确计费由 provider 返回的 usage
 * 承担（那才是账单依据，见 `safeTokenCount`）。
 *
 * 系数：CJK 约 1 token/字（qwen 中文分词的实测口径），其余约 4 字符/token。
 */
export function estimateContentTokens(
  content: string | MultimodalPart[] | null | undefined,
): number {
  if (content === null || content === undefined) return 0;
  if (typeof content === "string") return estimateTextTokens(content);

  let total = 0;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text") total += estimateTextTokens(part.text);
    else total += PER_IMAGE_TOKENS;
  }
  return total;
}

/** 纯文本估算（导出便于单测与日志）。 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    // CJK 统一表意文字 + 全角标点 + 假名/谚文：按 1 字 1 token 计
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef) ||
      code >= 0x1f300 // emoji 区
    ) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return cjk + Math.ceil(other / 4);
}

/** 单条消息的估算 token（含 tool_calls 的 JSON 体积）。 */
export function estimateMessageTokens(message: MultimodalMessage): number {
  let total = PER_MESSAGE_OVERHEAD_TOKENS;
  total += estimateContentTokens(message.content);
  if (message.tool_calls?.length) {
    for (const call of message.tool_calls) {
      total += estimateTextTokens(
        `${call?.function?.name ?? ""}${call?.function?.arguments ?? ""}`,
      );
    }
  }
  return total;
}

/** 一组消息的估算 token 之和。 */
export function estimateTokens(messages: readonly MultimodalMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

/**
 * 把消息按「不可拆分的组」切分。
 *
 * 组 = 带 tool_calls 的 assistant + 紧随其后的**全部** tool 应答；
 * 其余角色各自成组。孤立的 tool 消息（历史脏数据/人工构造）单独成组并标记
 * `orphan`——它不能作为保留段的第一条（否则就是悬空的 tool 应答）。
 */
interface MessageGroup {
  messages: MultimodalMessage[];
  orphanTool: boolean;
}

function groupMessages(messages: readonly MultimodalMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    const hasCalls =
      msg.role === "assistant" &&
      Array.isArray(msg.tool_calls) &&
      msg.tool_calls.length > 0;
    if (hasCalls) {
      const group: MultimodalMessage[] = [msg];
      let j = i + 1;
      while (j < messages.length && messages[j].role === "tool") {
        group.push(messages[j]);
        j += 1;
      }
      groups.push({ messages: group, orphanTool: false });
      i = j;
      continue;
    }
    groups.push({ messages: [msg], orphanTool: msg.role === "tool" });
    i += 1;
  }
  return groups;
}

/** 把一条消息压成摘要里的一行（确定性、不编造）。 */
function renderLine(message: MultimodalMessage): string {
  const text = contentToText(message.content);
  const clipped =
    text.length > DIGEST_LINE_MAX_CHARS
      ? `${text.slice(0, DIGEST_LINE_MAX_CHARS)}…`
      : text;
  const role =
    message.role === "assistant"
      ? "助手"
      : message.role === "user"
        ? "用户"
        : message.role === "system"
          ? "系统"
          : "工具结果";
  return `${role}：${clipped}`;
}

function contentToText(
  content: string | MultimodalPart[] | null | undefined,
): string {
  if (typeof content === "string") return content.replace(/\s+/g, " ").trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((p) =>
      p.type === "text" ? p.text.replace(/\s+/g, " ").trim() : "[图片]",
    )
    .filter((s) => s.length > 0)
    .join(" ");
}

/**
 * 把被折叠的组渲染成确定性摘要。
 *
 * 一个「调用组」压成一行：`调用 list_executors({"status":"online"}) → 3 台在线`。
 * 这样模型能读到「早前查过什么、结论是什么」，也能判断「要不要再查一次」——
 * 这正是折叠后仍然可继续工作的最低信息量。
 */
function buildDigest(
  groups: readonly MessageGroup[],
  foldedCount: number,
  maxChars: number,
): string {
  const lines: string[] = [
    // 措辞纪律：摘要承诺的每个动作都必须真实存在。P4 起运行时**有**
    // `get_tool_call_result`（按 toolCallId 回读已存结果，见 tool-binder），
    // 因此可以明确给出这条路径；另一种可行动作是按 id 重新查询资源。
    // 两者都不要求模型凭摘要猜测。
    `【早期对话摘要（确定性压缩，已省略 ${foldedCount} 条消息；细节已不在当前上下文，需要时可用 get_tool_call_result 按 toolCallId 回读，或按 id 重新调用相应工具，不要凭摘要猜测）】`,
  ];

  for (const group of groups) {
    const head = group.messages[0];
    const calls =
      head.role === "assistant" && head.tool_calls?.length
        ? head.tool_calls
        : null;

    if (calls) {
      const names = calls.map((c) => c?.function?.name ?? "unknown").join("、");
      const args = calls
        .map((c) => (c?.function?.arguments ?? "").replace(/\s+/g, " "))
        .join("；");
      const answers = group.messages
        .slice(1)
        .map((m) => contentToText(m.content))
        .filter((s) => s.length > 0)
        .join(" | ");
      const answer =
        answers.length > DIGEST_LINE_MAX_CHARS
          ? `${answers.slice(0, DIGEST_LINE_MAX_CHARS)}…`
          : answers;
      lines.push(
        `· 调用 ${names}(${args.length > 80 ? `${args.slice(0, 80)}…` : args})` +
          (answer ? ` → ${answer}` : " → （无应答记录）"),
      );
      continue;
    }

    lines.push(`· ${renderLine(head)}`);
  }

  let digest = lines.join("\n");
  if (digest.length > maxChars) {
    digest = `${digest.slice(0, Math.max(0, maxChars - 1))}…`;
  }
  return digest;
}

/**
 * 生成上下文窗口计划。
 *
 * 行为：估算总量未超 `maxTokens` → 原样返回（**零成本**，这是绝大多数会话
 * 的路径）；超了 → 保留 system + 一个摘要消息 + 最近的若干组消息。
 */
export function planContextWindow(
  messages: readonly MultimodalMessage[],
  options: Partial<ContextWindowOptions> = {},
): ContextWindowPlan {
  const opts: ContextWindowOptions = { ...DEFAULT_CONTEXT_WINDOW, ...options };
  const tokensBefore = estimateTokens(messages);

  const unchanged: ContextWindowPlan = {
    messages: [...messages],
    foldedMessages: 0,
    tokensBefore,
    tokensAfter: tokensBefore,
    digest: null,
  };

  if (messages.length === 0 || opts.maxTokens <= 0) return unchanged;
  if (tokensBefore <= opts.maxTokens) return unchanged;

  // system 恒保留：它承载角色与纪律，折掉它等于换了一个 Agent
  const hasSystem = messages[0]?.role === "system";
  const head = hasSystem ? messages[0] : null;
  const rest = hasSystem ? messages.slice(1) : [...messages];
  const groups = groupMessages(rest);

  if (groups.length === 0) return unchanged;

  const headTokens = head ? estimateMessageTokens(head) : 0;
  // 摘要自身也占窗口：先按上限预留，折叠后再按实际大小记账
  const reserve = Math.min(opts.digestMaxChars, 2_000);
  const budget = Math.max(0, opts.maxTokens - headTokens - reserve);

  let keptTokens = 0;
  let keptMessages = 0;
  let start = groups.length;
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const group = groups[i];
    const groupTokens = estimateTokens(group.messages);
    const enoughRecent = keptMessages >= opts.minRecentMessages;
    if (enoughRecent && keptTokens + groupTokens > budget) break;
    keptTokens += groupTokens;
    keptMessages += group.messages.length;
    start = i;
  }

  // 至少留最后一组：全折掉等于让模型「失忆后自问自答」
  if (start >= groups.length) start = groups.length - 1;

  // 悬空的 tool 组不能作为保留段的第一条（协议要求 tool 必须紧跟其 assistant）
  while (start < groups.length - 1 && groups[start].orphanTool) start += 1;

  if (start <= 0) return unchanged;

  const folded = groups.slice(0, start);
  const kept = groups.slice(start).flatMap((g) => g.messages);
  const foldedCount = folded.reduce((n, g) => n + g.messages.length, 0);
  const digest = buildDigest(folded, foldedCount, opts.digestMaxChars);

  const digestMessage: MultimodalMessage = { role: "user", content: digest };
  const next: MultimodalMessage[] = [
    ...(head ? [head] : []),
    digestMessage,
    ...kept,
  ];

  return {
    messages: next,
    foldedMessages: foldedCount,
    tokensBefore,
    tokensAfter: estimateTokens(next),
    digest,
  };
}
