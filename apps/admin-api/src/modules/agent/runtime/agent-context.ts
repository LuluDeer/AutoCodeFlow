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
  /**
   * provider 上一次真实返回的 prompt token 数（`usage.prompt_tokens`）。
   *
   * 第 6 轮审计 P2：纯启发式估算会与真实分词漂移（工具 schema、CJK 混排、
   * 特殊 token）；有实测值时取 max(估算, 实测)，避免「估算说没超、provider
   * 说超」→ 400 直接把会话打成 failed。
   */
  measuredTokens?: number;
  /**
   * 窗口里必须留出的**非消息**预算：工具 schema（首次调用尚无 usage 时）+
   * 输出预留（max_tokens 也占窗口）。不计入会让「消息刚好不超、加上工具
   * schema 就超」的会话反复 400。
   */
  reservedTokens?: number;
  /**
   * N6 提前收敛开关（`agent.context.preemptUnrecoverable`，**默认关**）。
   *
   * 打开时：若「provider 上一轮实测 prompt + 预留已越过 `maxTokens`」且本轮
   * `foldedMessages === 0`（折叠折不动），则不再发出这次注定被拒的 provider
   * 调用，直接以 `failed` + `context_unrecoverable` 收敛——省一次付费调用，
   * 且不让运维把「超窗」误读成链路故障（计数
   * `autoflow_agent_context_unrecoverable_total`）。
   *
   * ## 为什么默认关（这是安全前提，不是保守）
   * 该判据把 `maxTokens` 当作窗口边界，而它只是**我们自己的保守折叠线**：
   * 默认 24k 保守于 32k 档模型的真实窗口。只有 `maxTokens ≤ 模型真实窗口` 时，
   * 「实测越 `maxTokens` ⇒ provider 必然 400」才严格成立；在 `maxTokens <`
   * 真窗口的会话上（如 128k 模型配默认 24k），打开开关会把**本可跑完**的会话
   * 判失败。风险不对称：多付一次调用的代价 << 误杀一个真实会话。模型窗口推导
   * （S2-A3）落地、能把 `maxTokens` 钉到真实窗口之前，本开关不应默认打开。
   */
  preemptUnrecoverable?: boolean;
}

/**
 * 默认值。
 *
 * `maxTokens = 24k`：保守对齐 32k 窗口的模型（qwen 系列），给输出与
 * 估算误差留出空间。宁可早折叠，不可撞 400——一次 400 就是一整个会话作废。
 * `minRecentMessages = 12`：约「3 轮完整 tool-calling」，够模型接着干活。
 *
 * ## N5（R6-a，2026-11-01）实测校准：为什么**保持** 24k
 *
 * 取值依据不是拍脑袋，而是 `scripts/agent-context-token-audit.mjs` 的判据输出：
 * 该只读脚本比对**同一轮**的 provider 实测（`agent_steps.tokensIn`）与本地
 * 估算（本文件的 `estimateTokens`，按会话首轮残差抵消 system/schema 常量）的
 * 比值分布，四选一给结论：调系数 / 降默认 maxTokens / 保持默认+兜底 / 样本不足。
 *
 * 本机实测结果：**零可用样本**——库连通，但 139 条 `agent_steps` 的 `tokensIn`
 * 全为 0（provider=disabled 的空响应会话，没有真实 usage 可校准），脚本如实
 * 报出并给跑法（退出码 4）。判据因此输出 `insufficient`：**不调系数、不降默认**。
 *
 * 为什么在无样本时也**不该**动这个值（两条代码事实，比估计更硬）：
 *   ① 窗口判定取的是 `max(估算, 实测) + 预留`（`planContextWindow` 的
 *      `tokensBefore`）——只要上一轮有实测，估算偏低就已经被挡住，调系数换来的
 *      是「更早折叠」而不是「少撞 400」；
 *   ② 剩下真会撞 400 的是「实测本身越窗且折叠折不动」那一类，它由 N6 的
 *      `context_unrecoverable` 提前收敛处理（省掉那次注定 400 的付费调用），
 *      与阈值高低无关。**注意 N6 默认关**（`agent.context.preemptUnrecoverable`）：
 *      它把 `maxTokens` 当窗口边界，而 24k 保守于真窗口，打开会误杀
 *      「越 24k 但仍在真窗口内」的会话——在 S2-A3 把窗口钉到真实值之前不开。
 * 结论：系数与 24k 都保持不动；等库里攒够 ≥30 个真实实测轮后重跑该脚本，
 * 再按它给出的四个结论之一调整（现场调 `AGENT_CONTEXT_MAX_TOKENS` 即可，
 * 本值只是缺省回落）。
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
  /**
   * 被折叠、且**摘要里仍留着 `#id` 句柄**的 tool_call id（顺序同摘要）。
   *
   * ## 为什么只记「摘要里还在的」
   * 账本要回答的问题是「这一轮模型到底握有哪些可回读句柄」（S2-A2）。
   * `digestMaxChars` 从尾部截断，越靠后的调用行越可能整行消失（连同 id）——
   * 若账本照抄「所有被折的 id」，排查时会拿着一个模型从没见过的 id 去对账，
   * 结论必然错误。故这里是**交集**：被折的 id ∩ 摘要文本里出现 `#<id>` 的。
   *
   * 空数组 = 没有折任何带 id 的调用（纯文本折叠 / 无 id 的历史脏数据）。
   */
  foldedToolCallIds: string[];
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
 * 一个「调用组」压成一行：`调用 #c1 list_executors({"status":"online"}) → 3 台在线`。
 * 这样模型能读到「早前查过什么、结论是什么」，也能判断「要不要再查一次」——
 * 这正是折叠后仍然可继续工作的最低信息量。
 *
 * ## 为什么调用行必须带 `toolCallId`（A1，2026-10）
 * 摘要只留 ≤160 字符的应答预览，原文（最长 32KB）只在库里；而回读工具
 * `get_tool_call_result` 的**唯一入参就是 `toolCallId`**。摘要不写 id 时，
 * 模型看得到「调用过 list_executors」，却拿不到任何可指认的身份——回读通道
 * 存在但实际不可用，只剩「重跑工具」一条路，而有副作用的工具（trigger_task /
 * approve_deployment）重跑就是重复执行。id 是**当时就落库的既有事实**，把它
 * 写进摘要只是让摘要能指认自己记录的那次调用，不属于「编造」。
 * `get_session_steps` 同样要被点名：digestMaxChars 截断从尾部开始，越早的调用
 * 行越可能整行消失（连同它的 id），按 seq 翻时间线是唯一不依赖「摘要里恰好留下
 * 某行」的召回通道。
 *
 * ## 为什么仍然是纯函数（不能改成状态化）
 * 折叠计划每轮基于**完整历史**重算（崩溃重启 / 审批恢复 / 重复入队都走同一条
 * 路径），所以摘要只能由入参决定：不得读取「上一轮折过哪些 id」这类进程内状态，
 * 也不得写回任何东西。下面的 id 拼接是纯字符串运算——同输入必然同输出，
 * 单测可逐字钉住。
 */
function buildDigest(
  groups: readonly MessageGroup[],
  foldedCount: number,
  maxChars: number,
): { text: string; toolCallIds: string[] } {
  const lines: string[] = [
    // 措辞纪律：摘要承诺的每个动作都必须真实存在。P4 起运行时**有**
    // `get_tool_call_result`（按 toolCallId 回读已存结果，见 tool-binder），
    // 因此可以明确给出这条路径；另一种可行动作是按 id 重新查询资源。
    // 两者都不要求模型凭摘要猜测。
    `【早期对话摘要（确定性压缩，已省略 ${foldedCount} 条消息；细节已不在当前上下文，需要时可用 get_session_steps 按 seq 翻本会话时间线，或用 get_tool_call_result 按 toolCallId 回读下列 #<id> 标记的调用原文，或按 id 重新调用相应工具，不要凭摘要猜测）】`,
  ];

  /** 被折进摘要、且带 id 的 tool_call（按摘要出现顺序；去重保序）。 */
  const renderedIds: string[] = [];

  for (const group of groups) {
    const head = group.messages[0];
    const calls =
      head.role === "assistant" && head.tool_calls?.length
        ? head.tool_calls
        : null;

    if (calls) {
      // 每条调用单独渲染成 `#<id> name(args)`：id 与 name/args **成对**输出，
      // 而不是先列一批 id 再列一批名字——多个调用时两列一旦错位，模型会拿着
      // A 的 id 去回读 B 的结果，比没有 id 更糟。缺 id 时只写 `name(args)`，
      // 不留空 `#`（历史脏数据 / 人工构造的消息本就没有 id，空字段只是噪声）。
      const rendered = calls.map((c) => {
        const rawId = typeof c?.id === "string" ? c.id.trim() : "";
        const name = c?.function?.name ?? "unknown";
        const rawArgs = (c?.function?.arguments ?? "").replace(/\s+/g, " ");
        const args = rawArgs.length > 80 ? `${rawArgs.slice(0, 80)}…` : rawArgs;
        if (rawId && !renderedIds.includes(rawId)) renderedIds.push(rawId);
        return `${rawId ? `#${rawId} ` : ""}${name}(${args})`;
      });
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
        `· 调用 ${rendered.join("、")}` +
          (answer ? ` → ${answer}` : " → （无应答记录）"),
      );
      continue;
    }

    lines.push(`· ${renderLine(head)}`);
  }

  let digest = lines.join("\n");
  if (digest.length > maxChars) {
    let cut = digest.slice(0, Math.max(0, maxChars - 1));
    // A1 后续硬化（2026-10-31）：不要把 `#<toolCallId>` 切成半截。
    //
    // 摘要里的 `#id` 是模型回读原文的**唯一句柄**。`#call_abc123` 被尾部截断
    // 切成 `#call_abc1` 时，模型会拿一个「看起来合法、但必然查不到」的 id 去调
    // `get_tool_call_result`——这比完全没有 id 更贵，因为它把一次「知道查不到、
    // 改用 get_session_steps」的推理，换成一次必然失败的往返 + 一次纠错。
    //
    // 判据只看切点附近的最后一个 `#`：若它出现在最后一个分隔符（换行/空格）
    // **之后**，说明切点落在一个 `#` 开头的令牌内部，就把切点退回到 `#` 之前。
    // 这不是「对齐行边界」（那会改掉既有截断语义、丢掉更多真实内容），只是
    // 在一次截断里最多少留 ≤1 个令牌的残片。仍然纯字符串运算，不引入状态。
    const lastSeparator = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(" "));
    const lastHash = cut.lastIndexOf("#");
    if (lastHash > lastSeparator) cut = cut.slice(0, lastHash);
    digest = `${cut}…`;
  }
  // 账本口径：只回**摘要里还在的** id（截断会连同 id 切掉整行，见
  // ContextWindowPlan.foldedToolCallIds）。这是账本行与摘要文本的结构性一致，
  // 由 `agent-context.spec.ts` 用独立正则复算钉住。
  return {
    text: digest,
    toolCallIds: renderedIds.filter((id) => digest.includes(`#${id}`)),
  };
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
  const estimated = estimateTokens(messages);
  const reserved = Math.max(0, opts.reservedTokens ?? 0);
  const measured = Math.max(0, opts.measuredTokens ?? 0);
  // 有效占用 = max(启发式, 实测) + 预留（工具 schema/输出）。
  const tokensBefore = Math.max(estimated, measured) + reserved;

  const unchanged: ContextWindowPlan = {
    messages: [...messages],
    foldedMessages: 0,
    tokensBefore,
    tokensAfter: tokensBefore,
    digest: null,
    foldedToolCallIds: [],
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
  // 摘要与**预留**（工具 schema/输出）同样挤占消息预算。
  const budget = Math.max(0, opts.maxTokens - headTokens - reserve - reserved);

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
  const { text: digest, toolCallIds } = buildDigest(
    folded,
    foldedCount,
    opts.digestMaxChars,
  );

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
    tokensAfter: estimateTokens(next) + reserved,
    digest,
    foldedToolCallIds: toolCallIds,
  };
}

/**
 * S2-A2（R5/R18）：这一轮折叠**折了但没收敛**吗？
 *
 * 判据（与登记册 §1.2 逐字一致，缺一不可）：
 *   · `foldedMessages > 0`——确实折掉了东西（`=== 0` 是**另一件事**，见下）；
 *   · `tokensAfter > maxTokens`——折完仍在窗口之上，也就是说这次折叠没有把
 *     prompt 带回可用区间，下一轮只会更大（每轮只追加 assistant/tool 消息）。
 *
 * ## 与 N6 的分工（R18：判据互补，不得互相吞掉）
 *   · **N6** = 折叠**折不动**（`foldedMessages === 0`）时提前收敛
 *     （`context_unrecoverable`，默认关，见 ContextWindowOptions.preemptUnrecoverable）；
 *   · **本函数** = 折了但**不收敛**（`foldedMessages > 0` 且折完还超）。
 * 两者判据互斥（一个要求 0、一个要求 > 0），所以既不会双重收敛，也不会互相
 * 掩盖：把本判据写成「`tokensAfter > maxTokens` 就收敛」会吞掉 N6 的语义
 * （折不动与折了没用是两种运维动作：前者要换窗口/清历史，后者要查「保留段
 * 为什么这么胖」），反之亦然。
 *
 * 纯函数：不读上轮状态、不写任何东西，`prev streak` 由调用方从库里取来。
 */
export function isContextFoldNonConverging(
  plan: Pick<ContextWindowPlan, "foldedMessages" | "tokensAfter">,
  maxTokens: number,
): boolean {
  if (maxTokens <= 0) return false;
  return plan.foldedMessages > 0 && plan.tokensAfter > maxTokens;
}

/**
 * S2-A2：连续不收敛的**下一格**（+1 或清零）。
 *
 * 「连续」必须是**逐轮**判定的：中间只要有一轮折收敛（或压根没折），计数就
 * 归零——否则「第 1 轮折不动、第 9 轮折不动」会被累加成一个假的连续不收敛，
 * 把一次偶发当成趋势。计数本身**不在这里**存：它落在 `agent_sessions.
 * contextFoldStreak`（多副本 + 重启下进程内状态必然错，见 agent-context.ts
 * 头注「不得读上一轮状态」）。
 *
 * @param prevStreak 上一轮落库的计数（0 = 无历史）
 */
export function nextContextFoldStreak(
  prevStreak: number,
  plan: Pick<ContextWindowPlan, "foldedMessages" | "tokensAfter">,
  maxTokens: number,
): number {
  if (!isContextFoldNonConverging(plan, maxTokens)) return 0;
  const prev = Number.isFinite(prevStreak)
    ? Math.max(0, Math.trunc(prevStreak))
    : 0;
  return prev + 1;
}
