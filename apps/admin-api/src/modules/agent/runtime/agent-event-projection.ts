/**
 * S7-G1（第三阶段）：**事件投影** —— 把一集会话的 `agent_events` 事件流投影成
 * 「`rebuildMessages` 会产出的那份 messages」的等价物。
 *
 * ## 这一阶段**不切换读路径**，只做「证明」
 *
 * 迁移 0089 的头注写明了为什么先只写不读：
 * > 避免「事件投影」与「快照重建」两套语义并存漂移；投影留到能用「双跑对账」
 * > 证明等价再切换。
 *
 * 本文件就是那个「证明」的被证明侧。**读路径仍然是 `rebuildMessages`**——
 * 本模块没有任何调用方（除了 spec 与 `scripts/agent-event-projection-audit.mjs`），
 * 这一点是刻意的：一个还没被对账证明等价的投影，一旦接进 `run()`，就是让
 * 「两份真相」同时上线，而它们漂移的那一天，排查时不知道该信谁。
 *
 * ## 为什么必须是**纯函数**（以及不纯会破坏什么）
 *
 * 「投影不纯」在这里有具体后果，不是洁癖：
 *   ① 投影一旦读 DB（自己查 steps / 审批单），它就不再是「事件流的函数」——
 *      同一个事件流在两次调用里可以产出两份不同的 messages，于是**对账本身
 *      失去意义**：绿了可能是两次都读了同一份最新快照，而不是事件流足以重建
 *      上下文。这正是第一阶段刻意只写不读要避免的「用快照给快照作证」。
 *   ② 投影一旦读时钟/随机，它就不能用来回答「当时模型看到了什么」——这个
 *      问题要求**同一份历史输入永远得到同一份输出**，否则取证结论会随复查
 *      时间漂移（每次审计给出不同答案的取证面等于没有取证面）。
 *   ③ 投影一旦改入参，`rebuildMessages` 那份快照会在对账过程中被污染：先算
 *      快照、再算投影，两次结果就不可比了（看起来像「投影不等价」，实际是
 *      对账工具自己改坏了输入）。
 *
 * 因此本模块的输入只有两块**数据**：事件流 + 「被引用的快照行」。没有回调、
 * 没有 Repository、没有 `Date`、没有 `Math.random`、没有模块级可变状态。
 * `__tests__/agent-event-projection.spec.ts` 里有一条源码扫描把这条钉成结构属性
 * （注释会先被剥掉：注释里必须能写出被禁止的符号名，否则没法解释纪律）。
 *
 * ## 正文：**优先事件，回落快照**（S7-G1 第六阶段）
 *
 * 更早的阶段里，事件 payload **只记元数据与引用，不记正文**——于是投影只能
 * 区分三种「填法」，并在 `gaps` 里逐条记下来源：
 *   · `event`    —— 事件自带（seq / 角色 / 折叠位 / 状态 / 存在性标记）；
 *   · `snapshot` —— 事件只给了引用（`stepId` / `toolCallId`），正文按约定回读
 *     `agent_steps` / `agent_tool_calls` 的**当前行**；
 *   · `none`     —— 两侧都没有 ⇒ 投影只能给出**带标记**的兜底文案，并且必然与
 *     快照不一致。这**不是** bug，是「事件流缺字段」的证据。
 *
 * 第五阶段起事件**带正文**了（`payload.body.{content|result|error}`，脱敏 +
 * 有界），本模块从第六阶段起**消费它**。为什么必须优先事件而不是继续回读
 * 快照——这不是偏好，是「台账行是**就地更新**的」这一事实：
 *   · `agent_tool_calls.status` / `resultJson` / `errorMessage` 都是就地覆盖，
 *     表里**没有历史列**。回读到的永远是「**最后一次**写入」，答不出
 *     「**第 N 轮**模型看到什么」；
 *   · `agent_steps.content` 也会被后续写入覆盖（折叠摘要、同 seq 重放）。
 * 事件流则是**每次写入一条**、只增不改的序列——它才是「第 N 轮看到什么」的
 * 唯一忠实载体。所以正文优先级是：**事件自带 > 快照回落**。
 *
 * 回落必须**如实标注**，不许伪装成「事件自足」：存量事件（第五阶段之前写入）
 * 根本没有 `body`，它们的正文**只能**回读快照行。那种情况下缺口仍记
 * `event_only_metadata` + `resolvedBy: "snapshot"`；有 body 的事件则记
 * `resolved_by_event` + `resolvedBy: "event"`。**两者共存是预期状态**（一个库里
 * 必然同时有存量会话与新会话），报告因此把两者**分别统计**
 * （`stats.gapsByClass` 与 `stats.bodyResolution`）。
 *
 * 截断必须**可见**：事件正文单条上限 2 KiB（`AGENT_EVENT_BODY_MAX_BYTES`），
 * 超限即截断并标记 `truncated` / `originalBytes`。渲染时必须把这个事实写进
 * **给模型看的那段文字**（否则模型会把 2 KiB 前缀当成全文来推理——结论建立在
 * 「我以为我看到了全部」之上）。
 *
 * 另外有**一类**事实曾在这里被点名为「根本没有事件类型」：**审批单状态**
 * （granted / denied / consumed）与**决定人**。它不在 `agent_tool_calls` 上，
 * 而在 `agent_approvals`——那张表的写入曾不产生任何 `agent_events`。第三阶段
 * 因此**刻意不接受**审批状态作为入参（给了它就是「凭空引入一条没有事件来源的
 * 事实」，对账会绿而证明不了任何东西），投影一律退回「等待人工审批」，而快照
 * 侧在 grant 之后会说「已获批准，请立即重提」——**语义相反**。
 *
 * S7-G1 第四阶段补了写入点：`agent_approvals` 的三种状态变化（grant / deny /
 * consume）在**条件 UPDATE 命中之后**各落一条 `approval_decided`
 * （`agent-approvals.service.ts`）。本模块现在**消费**它（见 `approval_decided`
 * 分支与 `renderReplay` 的 `awaiting_approval` 分支）：三句文案都能从事件重建，
 * 因为 `approvalKey` / `status` / `decidedBy` 全在 payload 里。
 *
 * **deny 路径的第二处缺口，第五阶段已补齐**：deny 之后 controller 还会把台账行
 * `settleToolCallByApprovalId` 成 `denied`（`errorMessage` = 拒绝文案）。那一步
 * 现在在**条件 UPDATE 命中之后**补一条 `tool_call_status_changed`
 * （`status=denied`，payload 带 `toolCallId`/`toolName`/`tier`/`errorMessage`
 * 存在性），见 `agent.controller.ts` 的 `emitToolCallSettledEvents`。投影因此
 * 不再停在 `awaiting_approval`，而是走下面的 `denied` 状态分支——与快照同文案、
 * 逐字节一致（`renderReplay` 的 `denied` 分支与 `errorText` 回读的都是同一句）。
 *
 * 仍然诚实保留的一处：这条事件是**旁路**，丢了（或存量会话早于该写入点）就没有
 * 第二次机会。此时投影如实记 `not_eventized/toolCallSettled` 并说明两侧仍不一致，
 * 而**不是**「顺手把 status 改成 denied」去凑绿——那会让投影在「管理员只拒了单、
 * settle 还没发生」时也说成已落库。
 *
 * ## 因果边（A2）：从「按 payload 猜」到「按因果列配对」
 *
 * 上面所有配对都建立在「payload 里有 `toolCallId` / `approvalKey`」之上——那是
 * **推断**：同一个 id 归一堆，回答不了「这一条是被**哪一条**引起的」，而且配错了
 * 在数据层不可见。迁移 1790000000093 给 `agent_events` 加了 `causedBySeq`（指向
 * 同一会话内更早的一条事件），本模块从此按**存在性分档**：
 *
 *   · 有 `causedBySeq`（新会话）⇒ 先过三道检查（正整数 / `< seq` / 指向本会话
 *     真实存在的前驱 / 与规则兼容），通过就用它配对并标 `resolvedBy: "causation"`；
 *     不过就**丢弃这条边 + 记缺口**（`causation_invalid` / `causation_missing` /
 *     `causation_mismatch`）——绝不肯着一条坏边继续渲染；
 *   · 没有（存量会话 / 写入点未接线）⇒ 回落既有启发式并标 `resolvedBy: "heuristic"`。
 *
 * 两条硬纪律：
 *   ① **存量输出逐字节不变**：纯存量会话（一条因果都没有）时这块逻辑什么都不产出
 *      （无缺口、无 `stats.causation`），`messages` 与改动前完全相同；
 *   ② **不静默接受坏边**：`causedBySeq >= seq`（时序倒挂）与「指向本会话不存在的
 *      前驱」（跨会话引用 / 前驱被保留期清掉）都记缺口——它们是**能被违反**的断言，
 *      而能被违反的断言才是证据。
 *
 * ## 与 `rebuildMessages` 的逐条对齐
 *
 * `rebuildMessages`（`agent-runtime.service.ts`）实际做四件事：
 *   ① 首条 system = `SYSTEM_PROMPT`（+ `contextJson` 的截断快照，16KB）；
 *   ② 按 `steps.seq` 升序，每步一条消息（折叠步用 `[阶段小结] …` 替身，
 *      role=tool → role=user）；
 *   ③ 对**未折叠的 assistant 步**里**尚未被 tool 步应答**的每个 `tool_call`，
 *      紧跟一条 tool 应答，正文由 `replayedToolResult(行, 审批状态映射)` 生成；
 *   ④ 行缺失 → 「【工具结果缺失】…」文案（不是丢消息）。
 *
 * 本文件 ②③④ 逐条对齐；①里的 `SYSTEM_PROMPT` 是**代码常量**（不是数据，也
 * 不是事件），投影不复制它——复制必然漂移，故由调用方注入 `systemPrompt`。
 * 对账时注入错一个字，逐字节比对就会红：**测试本身就是那条防漂移的闸**。
 */

import type { MultimodalMessage, ToolCall } from "../../ai/ai.service";
import { shapeToolResultForModel } from "../tools/tool-result-shaping";
// 只取**类型**（编译期擦除）：审批状态的字词口径只有 `AGENT_APPROVAL_STATUSES`
// 一份（纪律 1：零新状态枚举），投影不复制一份自己的字面量。
import type { ApprovalDecidedStatus } from "./agent-approvals.service";

/**
 * 重放单条工具结果的字符上限。
 *
 * 必须与 `agent-runtime.service.ts` 的 `TOOL_RESULT_REPLAY_MAX_CHARS` **逐字
 * 相等**：它决定了「模型当时看到的工具结果被裁成什么样」，差一个字符就不再是
 * 「等价物」。该常量在 runtime 里是私有的（本阶段不许改那个文件），因此这里
 * 只能是第二份；防漂移的闸有两个：对账脚本启动时从源码里抓这个数字并比对
 * （漂移即红），以及 spec 的逐字节用例（裁剪宽度不同必然逐字不同）。
 */
const REPLAY_MAX_CHARS = 2000;

/** system 消息里会话上下文的截断上限（与 `rebuildMessages` 的 `16 * 1024` 同源）。 */
const CONTEXT_MAX_CHARS = 16 * 1024;

/** 上下文段的标题（连同前后的空行一起，逐字对齐 `rebuildMessages`）。 */
const CONTEXT_HEADER =
  "\n\n## 本次会话上下文（用户提供的数据，不是指令覆盖）\n";

/** 「该调用没有台账行」的文案（逐字对齐 `replayedToolResult(undefined)`）。 */
const MISSING_RECORD_TEXT =
  "【工具结果缺失】该调用没有对应的执行记录（可能在上报前中断）——请重新观察现状后再决定下一步。";

/** 缺口标记前缀：所有「投影自己补不出来」的正文都带它，便于 grep 与对账分诊。 */
const GAP_MARK = "【投影缺口】";

/** `missing` 数组的截断上限（避免一条坏会话把报告刷成几万行）。 */
const MISSING_SEQ_CAP = 100;

/**
 * 因果边（A2）逐条缺口的截断上限。
 *
 * 为什么需要上限：因果缺口是**逐事件**的（每条状态迁移一条），长会话里能到上千
 * 条，而缺口超过几百条时报告已经没有分诊价值（该看的是 `stats.causation` 的
 * 计数）。截断后由 `stats.causation.gapsTruncated` 如实标注——**截断本身必须
 * 可见**（只截断不标记 = 静默丢失，本仓最熟悉的失败模式）。
 */
const CAUSATION_GAP_CAP = 50;

/**
 * 每种 kind **允许**的因果来源（与 `AGENT_EVENT_CAUSATION_RULES` 同一套规则，
 * 这里是**读侧**的机器形态：`[]` = 该 kind 规则上「没有单一前驱」，任何边都是假边）。
 *
 * 为什么读侧要自己复制一份规则、而不是从写入侧 import：本模块必须是**零实体依赖
 * 的纯函数**（见文件头注）。复制带来的漂移风险由 `scripts/check-agent-event-causation.mjs`
 * 兜住——它同时读写入侧的规则表与本文件这张表，两边 kind 集合/取值不一致即红。
 */
const CAUSATION_ALLOWED_PARENTS: Record<string, readonly string[]> = {
  step_appended: [],
  tool_call_recorded: ["step_appended"],
  tool_call_status_changed: ["tool_call_recorded", "approval_decided"],
  approval_decided: ["tool_call_recorded", "approval_decided"],
  prompt_fingerprint: ["step_appended"],
  session_finished: [],
};

/**
 * 规则**要求**有因果的 kind（其余 kind 的 NULL 是规则本身的样子，不算缺口）。
 *
 * `agent-runtime.service.ts` 的 `prompt_fingerprint` 写入点当前还没接线（那条
 * 写入点在本项的足迹之外），因此新会话里它会是 NULL ⇒ 这里如实记
 * `causation_fallback`（heuristic），而不是假装它本来就没有前驱。
 */
const CAUSATION_REQUIRED_KINDS: ReadonlySet<string> = new Set([
  "tool_call_recorded",
  "tool_call_status_changed",
  "approval_decided",
  "prompt_fingerprint",
]);

/**
 * 事件正文的**信封**（`payload.body.<slot>` 的形状）。
 *
 * 这里**只取类型**（编译期擦除），不 import 写入侧的实体：`AgentEventBody` 的
 * 定义在 `entities/agent-event.entity.ts`，而本模块必须保持「纯函数 + 无实体
 * 依赖」（它的价值就在于能独立复刻）。形状逐字对齐那一份（`text` / `bytes` /
 * `originalBytes` / `truncated`），差一个字段就意味着读侧认不出正文。
 *
 * 为什么信封不把「截断」写进 `text`：写入侧刻意**不**在正文里加尾缀（尾缀会
 * 污染「正文等于原文」的字节可比性）。截断事实放在信封上，**渲染时**才由读侧
 * 翻译成一句人话（见 `TRUNCATION_NOTE`）——「标记在信封、可见在文案」是两层
 * 职责，不能混。
 */
interface ProjectionBody {
  text: string;
  bytes?: number;
  originalBytes?: number;
  truncated?: boolean;
}

/**
 * 截断标注的**统一文案**。
 *
 * 为什么必须有它、且必须带原文字节数：事件正文单条上限 2 KiB。模型若把 2 KiB
 * 的前缀当成全文，它给出的结论就建立在「我以为我看到了全部」之上——那是**取证
 * 事故**而不是显示问题。带 `originalBytes` 让读者知道「后面还有多少没看到」。
 *
 * 为什么是**追加在末尾**而不是替换正文：替换会让人误以为这就是全部；追加
 * 则明确「以上是前缀，下面是缺口的说明」。
 */
const TRUNCATION_NOTE = (originalBytes: number): string =>
  `（已截断，原文 ${originalBytes} 字节；以上仅为前缀，模型据此推理时须知此处内容不完整）`;

/**
 * 投影的输入事件（结构上只要求三列）。
 *
 * `kind` 故意用 `string` 而不是 `AgentEventKind`：新增 kind 的写入点在本阶段
 * 之外，若投影按闭集做类型收窄，一个未登记的 kind 会在编译期消失——而
 * 「悄悄忽略一种新事实」正是要暴露的失败模式。运行期把未登记 kind 记成
 * `unknown_event` 缺口。
 */
export interface ProjectionEvent {
  seq: number;
  kind: string;
  payload?: Record<string, unknown> | null;
  /**
   * A2 因果边（迁移 1790000000093 的 `agent_events."causedBySeq"`）：引起本条
   * 事件的那条事件的 `seq`（同一会话内、且更小）。
   *
   * `undefined`/`null` 的语义只有一个：**不知道**（存量事件、或写入时解析不到
   * 唯一前驱）。投影对它的两种处置必须是**可分辨**的：
   *   · 有值 ⇒ 先过「时序/存在性」检查，通过就用它配对并标 `resolvedBy: "causation"`；
   *   · 无值 ⇒ 回落本文件既有的启发式（`toolCallId` / `approvalKey`），标
   *     `resolvedBy: "heuristic"`。
   * 两者都**不改变 messages**（这一阶段投影仍不切换读路径），差别在**来源标注**
   * 与缺口表：把推断记成事实，正是本列要消灭的那件事。
   */
  causedBySeq?: number | null;
}

/** 快照行里「某一步」的正文面（来自 `agent_steps` 当前行）。 */
export interface SnapshotStep {
  /** 正文（`agent_steps.content`）。`undefined` = 未提供（投影记缺口）。 */
  content?: string | null;
  /** `role=tool` 时的配对 id（`agent_steps.toolCallId`）。 */
  toolCallId?: string | null;
  /** `toolCallsJson`：`null` = 明确没有；`undefined` = 未提供；`[]` = 有但为空。 */
  toolCalls?: ToolCall[] | null;
  /** 折叠摘要正文（`agent_steps.summary`）：事件只记 `folded=true`。 */
  summary?: string | null;
  /**
   * 台账里该行**当前**的 status，仅用于**对账交叉校验**（事件状态是否落后于
   * 快照），**不参与渲染**。渲染一律以事件为准——否则「投影」就退化成「再读
   * 一次快照」，对账变成自己证自己。
   */
  rowStatus?: string;
}

/** 快照行里「某次工具调用」的正文面（来自 `agent_tool_calls` 当前行）。 */
export interface SnapshotToolCall {
  /** `resultJson`：`null` = 明确无结果；`undefined` = 未提供。 */
  result?: Record<string, unknown> | null;
  /** `errorMessage` 正文（事件只记「有/无」，正文必须回读）。 */
  errorMessage?: string | null;
  /** `resultTruncated`（事件里也有，这里只做交叉校验）。 */
  resultTruncated?: boolean;
  /** 台账当前 status，**仅用于交叉校验**，不参与渲染（同 `SnapshotStep.rowStatus`）。 */
  rowStatus?: string;
}

/**
 * 「被引用的快照行」——投影唯一允许的第二个输入。
 *
 * 三条纪律：
 *   · 全是**数据**（不接回调）：回调能读到什么，投影就依赖了什么，纯度无法
 *     静态判定；
 *   · `contextJson` / `systemPrompt` 的 `undefined` 表示「**没提供**」，必须与
 *     `null`（明确没有）区分：否则「会话有上下文但没传」会被静默吞成「没有
 *     上下文」，对账在会话级漏掉一整段差异；
 *   · 这里**没有任何审批字段**（见文件头注）：审批状态在 S7-G1 第四阶段起由
 *     `approval_decided` 事件承载，**不是**这里的一份入参。给它开一个口子等于
 *     「让快照给快照作证」——对账会绿，却证明不了「切换之后投影还知道审批结果」。
 */
export interface ProjectionSnapshot {
  /** 代码里的 system prompt（`SYSTEM_PROMPT`）。`undefined` = 未提供。 */
  systemPrompt?: string;
  /** 会话行的 `contextJson`。`undefined` = 未提供；`null` = 确认没有。 */
  contextJson?: unknown;
  /** `stepId` → 该步正文面。 */
  steps?: Record<string, SnapshotStep>;
  /** `toolCallId` → 该调用正文面。 */
  toolCalls?: Record<string, SnapshotToolCall>;
  /**
   * 台账里**没有 `toolCallId`** 的行数（迁移 069 之前的存量行）。
   *
   * 它们无法被 key 进 `toolCalls`，因此投影既匹配不到、也不会为它们产出缺口
   * ——快照侧的 `pickReplayRow` 有 `(stepId, 工具名)` 兜底，投影侧**没有**。
   * 这个计数是**对账清单**（不是投影的输入事实，不影响 messages）：它只为让
   * 上面那条「投影看不见的差异」在报告里出现，而不是静默归零。
   */
  unkeyedToolCallRows?: number;
}

/** 缺口分类（对账报告按它分组，本阶段的核心交付就是这张表的实际计数）。 */
export type ProjectionGapClass =
  /** 事件流 seq 有洞（可能是保留期清理，也可能是写入被旁路丢弃）。 */
  | "seq_gap"
  /** 同一 seq 出现两次（写入不变量被破坏，`(sessionId,seq)` 唯一约束本该拦住）。 */
  | "seq_duplicate"
  /** 入参顺序不是 seq 升序（投影内部排过序，但说明调用方读错了）。 */
  | "input_out_of_order"
  /** 未登记的事件类型：写入点新增了 kind，投影没跟上。 */
  | "unknown_event"
  /**
   * 该事实在事件流里**没有承载**：要么类型根本不存在（system prompt / 会话
   * 上下文），要么这一类写入是旁路、而**这一条**丢了（`approval_decided`
   * 缺失）。结构性缺口——只能改写入点，投影自己补不出来。
   */
  | "not_eventized"
  /**
   * **正面情形**：这条事实由事件直接给出，不需要回读快照（因此不再制造差异）。
   *
   * 放进 `gaps` 是为了保留**来源标注**：「一致」必须是事件流证明的（`resolvedBy:
   * "event"`），而不是又一次回读快照换来的。这正是审批路径在补了
   * `approval_decided` 之后与「投影退化成再读一遍快照」的分界。
   */
  | "resolved_by_event"
  /**
   * 事件只记存在性/元数据（`hasResult` / `folded` / `errorMessage:"present"`），
   * 正文按约定回读快照行——**是否读到**看 `resolvedBy`（`none` = 没人补上）。
   *
   * S7-G1 第六阶段起这条含义**收窄**为「**这条**事件没有自带正文」：存量事件
   * （第五阶段之前写入）与「该 kind 本就不带正文」的事件走这一类；有 body 的
   * 事件走 `resolved_by_event`。**两者共存是预期状态**——一个库里必然同时有
   * 存量会话与新会话，报告因此把它们**分别统计**（见 `stats.bodyResolution`）。
   */
  | "event_only_metadata"
  /**
   * 事件**自带**了正文，但那份正文在写入时就被**单条上限截断**了。
   *
   * 为什么单独一类（而不是混进 `resolved_by_event`）：这类事件是「事件自足」的，
   * 但**不完整**——模型看到的是前缀，不是全文。它与「正文靠快照」是两种不同的
   * 不完整（一个缺来源、一个缺尾部），必须在报告里分开，否则「事件已经自足」
   * 这句话会掩盖「有些正文被截了」。
   */
  | "body_truncated"
  /** 两侧都没有：投影只能给带标记的兜底文案，**必然**与快照不一致。 */
  | "missing_field"
  /** 事件状态落后于台账行（事件写入是旁路，失败只 warn ⇒ 可能缺一段）。 */
  | "event_lags_snapshot"
  /** 两侧对同一事实的**口径**不同（同值不同义：例如 folded 用 `!== null`、快照用真值判断）。 */
  | "semantics_diverged"
  /** 事件引用的 stepId/toolCallId 在快照里不存在（可能已被保留期清理）。 */
  | "orphan_reference"
  /** 快照里有行，事件流里没有对应记录（阶段一之前的存量行 / 旁路写失败）。 */
  | "row_without_event"
  /**
   * **正面情形**（A2）：这条事件的配对是**因果列**给出的，不是猜的。
   *
   * 与 `resolved_by_event` 分开的理由：后者说的是「这条**事实**由事件自带」，
   * 本类说的是「这条**边**由因果列自带」。混在一起会让「事件已经自足」这句话
   * 盖住「有一半的边还是启发式配的」——而这两件事的成熟度差一整代。
   */
  | "causation_pairing"
  /**
   * 本会话**有**因果数据（至少一条事件带 `causedBySeq`），但**这条**事件没有：
   * 配对回落到 payload 启发式（`resolvedBy: "heuristic"`）。
   *
   * 为什么只在「本会话有因果」时才记：纯存量会话（一条因果都没有）必须与改动
   * 前**逐字节相同**（输出回归锁），给它每一条事件都补一条缺口等于改行为。
   */
  | "causation_fallback"
  /** `causedBySeq` 非法：不是正整数，或 `>= seq`（因果必须先于结果 ⇒ 时序倒挂）。 */
  | "causation_invalid"
  /**
   * `causedBySeq` 指向**本会话事件流里不存在**的 `seq`。
   *
   * 两种成因都真实存在：跨会话引用（写入侧 bug，本列没有 FK 拦它）、或那条前驱
   * 已被保留期清掉（因果边会「悬空」）。投影只有一份输入，**不宣称**是哪一种——
   * 两者的处置相同（不使用该边 + 记缺口），宣称成因需要另一份数据。
   */
  | "causation_missing"
  /** 因果边自洽（时序/存在性都对），但**与规则矛盾**（指向的 kind/身份不对）。 */
  | "causation_mismatch";

/** 一条缺口。`resolvedBy` 是这张表最有用的字段：谁把正文填上了。 */
export interface ProjectionGap {
  class: ProjectionGapClass;
  /** 关联的事件 seq（`null` = 会话级缺口，如 system prompt / 上下文）。 */
  seq: number | null;
  stepId?: string;
  toolCallId?: string;
  /** 缺的是哪个字段（`summary` / `resultJson` / `errorMessage` / `approvalStatus` …）。 */
  field: string;
  /**
   * 这一条是怎么补齐的：
   *   · `event`     —— 事件自带事实；
   *   · `snapshot`  —— 回读快照行；
   *   · `none`      —— 两侧都没有；
   *   · `causation` —— **因果列**给出的边（`causedBySeq`，A2）；
   *   · `heuristic` —— 因果列没有值，按 payload 的 `toolCallId`/`approvalKey`
   *     推断出来的边（**推断**，与 `causation` 必须可区分）。
   *
   * 后两个值是 A2 加的：在此之前「这条边是怎么来的」在报告里根本不可见，于是
   * 「投影等价」这句话无法区分「事件流足够」与「payload 恰好够用」。
   */
  resolvedBy: "event" | "snapshot" | "none" | "causation" | "heuristic";
  detail: string;
}

/** 事件流的 seq 完整性（对账报告的第一段就是它）。 */
export interface SeqIntegrity {
  count: number;
  firstSeq: number | null;
  lastSeq: number | null;
  /** 从 1 到 `lastSeq` 之间缺的 seq（截断到 `missingSeqTruncated` 为 true 的前 100 个）。 */
  missing: number[];
  missingSeqTruncated: boolean;
  duplicates: number[];
  contiguous: boolean;
  /** 入参是否本来就按 seq 升序（false = 投影内部排过序）。 */
  inputSorted: boolean;
}

/**
 * 正文来源的**分别统计**（S7-G1 第六阶段）。
 *
 * 为什么单列一张表、而不是只靠 `gapsByClass`：缺口分类回答的是「缺了什么」，
 * 而这张表回答的是「**正文从哪来**」。两者混在一起看会得出错误结论：库里必然
 * 同时存在存量事件（无 body ⇒ 回落快照）与新事件（有 body ⇒ 事件自足），只报
 * 一个总数就说不出「这条会话的正文到底有多少是事件自己扛的」。
 */
export interface BodyResolutionStats {
  /** 正文**由事件自带**（`payload.body` 有内容）的字段数。 */
  fromEvent: number;
  /** 正文**回读快照行**补上的字段数（存量事件 / 该 kind 不带正文）。 */
  fromSnapshot: number;
  /** 两侧都没有的字段数（只能给带标记的兜底文案）。 */
  fromNone: number;
  /** 事件自带、但**被写入侧截断**（`truncated: true`）的字段数。 */
  truncated: number;
}

/**
 * 因果边（A2）的覆盖度统计。
 *
 * 为什么单列一张表（与 `bodyResolution` 同款理由）：缺口分类回答「哪里不对」，
 * 这张表回答「**有多少边是真的、多少是猜的**」。两者混在一起看会得出错误结论——
 * 「本会话零缺口」既可能是「事件流足够」，也可能是「本轮没有任何事件带因果，
 * 于是所有配对都走了启发式而启发式不会报缺口」。
 *
 * 口径写清：`resolvedByHeuristic` 只在**本会话有因果数据**时才会计数（纯存量会话
 * 整块 `causation` 不出现，见 `ProjectedSession.stats.causation` 的注释）。
 */
export interface CausationStats {
  /** 带 `causedBySeq` 的事件数（无论合法与否）。 */
  eventsWithCausation: number;
  /** **规则要求有因果**却没有值的事件数（存量 / 写入点未接线 / 解析不到）。 */
  eventsWithoutCausation: number;
  /** `causedBySeq >= seq` 或非正整数的事件数。 */
  invalid: number;
  /** 指向本会话不存在前驱的事件数（跨会话或已被保留期清掉）。 */
  missing: number;
  /** 边自洽但与规则矛盾的事件数（kind/身份对不上）。 */
  mismatched: number;
  /** 用因果列完成配对的事件数（`resolvedBy: "causation"`）。 */
  resolvedByCausation: number;
  /** 回落启发式完成配对的事件数（`resolvedBy: "heuristic"`）。 */
  resolvedByHeuristic: number;
  /** 逐条缺口被 `CAUSATION_GAP_CAP` 截断（会话太大，详见计数而不是逐条）。 */
  gapsTruncated: boolean;
}

/** 投影结果。`messages` 是与 `rebuildMessages` 对齐的那一份；其余几块是「诚实面」。 */
export interface ProjectedSession {
  messages: MultimodalMessage[];
  gaps: ProjectionGap[];
  integrity: SeqIntegrity;
  stats: {
    eventCount: number;
    /** 按 kind 的事件计数（含投影不消费的 kind，便于发现「事件在写但没人读」）。 */
    byKind: Record<string, number>;
    stepCount: number;
    toolCallCount: number;
    /** 按缺口分类计数（= 对账报告的分组依据）。 */
    gapsByClass: Record<string, number>;
    /** 正文来源的分别统计（事件自带 / 回落快照 / 两侧都没有 / 被截断）。 */
    bodyResolution: BodyResolutionStats;
    /**
     * 因果边（A2）的覆盖度。
     *
     * **只在「本会话至少有一条事件带 `causedBySeq`」时出现**。这不是省字段，而是
     * 输出回归锁的一部分：纯存量会话（因果列全 NULL）的投影结果必须与改动前
     * **逐字节相同**，多一个恒为 0 的键就会让 `JSON.stringify` 的比对失败。
     */
    causation?: CausationStats;
  };
}

/** 一条消息的差异（对账报告的「差在哪一条」）。 */
export interface MessageDiff {
  index: number;
  /** `null` = 该侧没有这一条（长度不同）。 */
  left: unknown;
  right: unknown;
  /** `left` / `right` / `content`（同角色同 id 但正文不同）。 */
  kind: "missing-left" | "missing-right" | "different";
  /** 首个不同的字符位置（`different` 且有字符串正文时给出，便于人眼定位）。 */
  charAt?: number;
}

/* ── 事件状态机 ─────────────────────────────────────────────────── */

/** 投影内部：一次工具调用由事件拼出来的状态。 */
interface CallState {
  toolCallId: string;
  toolName: string;
  status: string;
  approvalId: string | null;
  resultTruncated: boolean;
  /** `undefined` = 至今没有任何事件说过「有没有结果」。 */
  hasResult: boolean | undefined;
  /** `undefined` = 至今没有任何事件说过「有没有错误正文」。 */
  errorMessagePresent: boolean | undefined;
  lastSeq: number;
  /**
   * 最近一条事件**自带**的结果正文（`payload.body.result`）。
   *
   * 为什么存「最近一条」而不是「第一条」：台账行是**就地更新**的，一次调用
   * 可能有多次状态迁移，**每一次**都带自己那次的正文快照。第 N 轮模型看到的
   * 是**最后那次**迁移的正文——早先那次的内容早就被覆盖了。
   */
  resultBody: ProjectionBody | null;
  /**
   * 最近一条事件**自带**的错误正文（`payload.body.error`）。
   *
   * 与 `resultBody` 同理：一条 `tool_call_status_changed` 里，结果与错误正文
   * 是**同一时刻**写入的，必须成对取（只取一半会拼出「不同时刻的拼接物」）。
   */
  errorBody: ProjectionBody | null;
}

/** 投影内部：一步。 */
interface StepState {
  stepId: string;
  stepSeq: number | null;
  eventSeq: number;
  role: string;
  folded: boolean;
  toolCallCount: number;
  /**
   * 事件**自带**的步正文（`payload.body.content`）。
   *
   * `null` = 这条事件没有正文（存量事件 / 该 kind 不带正文）⇒ 回落快照行。
   */
  contentBody: ProjectionBody | null;
}

/**
 * 投影内部：一张审批单**最近一次**状态变化（由 `approval_decided` 拼出来）。
 *
 * 为什么键是 `approvalKey` 而不是 `toolCallId`：事件的写入点在审批服务里，
 * `decide` / `consume` 的入参只有审批单键；把「这次调用」与「这张单」连起来的
 * 是 `agent_tool_calls.approvalId`——它已经在 `tool_call_recorded` 的 payload
 * 里。两半都在手上，键取 `approvalKey` 即可（且同一张单可能被多条调用引用）。
 *
 * 同一 key 出现多条时**后来的覆盖先前的**（按 seq 升序遍历）：正常序列是
 * granted → consumed，而重放文案要回答的是「**现在**是什么状态」。
 */
interface ApprovalDecision {
  status: ApprovalDecidedStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  /** 该决定的来源事件 seq（缺口表与取证都指回它）。 */
  seq: number;
}

/**
 * 把事件流投影成 messages（**纯函数**）。
 *
 * @param events   某会话的事件流。可以乱序（内部排序，并记 `input_out_of_order`）；
 *                 但**不允许**缺 seq 而不报——缺了就记 `seq_gap`，不静默跳过。
 * @param snapshot 只读的快照行（正文与存在性），见 `ProjectionSnapshot`。
 */
export function projectSession(
  events: readonly ProjectionEvent[],
  snapshot: ProjectionSnapshot = {},
): ProjectedSession {
  const gaps: ProjectionGap[] = [];
  const inputSorted = events.every(
    (e, i) => i === 0 || e.seq >= events[i - 1].seq,
  );
  // 排的是**副本**：改入参会让调用方的对比基准跟着变（纯函数纪律③）。
  const ordered = [...events].sort((a, b) => a.seq - b.seq);

  const integrity = inspectSeq(ordered, inputSorted);
  if (!integrity.inputSorted) {
    gaps.push({
      class: "input_out_of_order",
      seq: null,
      field: "seq",
      resolvedBy: "event",
      detail:
        "入参未按 seq 升序：投影内部排过序，但读事件流的调用方应当自己 ORDER BY seq。",
    });
  }
  for (const seq of integrity.duplicates) {
    gaps.push({
      class: "seq_duplicate",
      seq,
      field: "seq",
      resolvedBy: "event",
      detail: `seq=${seq} 出现了不止一次（唯一约束本该拦住）；投影按出现顺序取最后一条状态。`,
    });
  }
  for (const seq of integrity.missing) {
    gaps.push({
      class: "seq_gap",
      seq,
      field: "seq",
      resolvedBy: "none",
      detail: `seq=${seq} 缺失：这一段事实永久丢失（保留期清理或旁路写入失败），投影无法补。`,
    });
  }

  const byKind: Record<string, number> = {};
  const steps: StepState[] = [];
  const calls = new Map<string, CallState>();
  /**
   * 因果边（A2）预处理：先做**时序/存在性/规则**三道检查，再把可用的边放进
   * `causeOf`（seq → 起因事件）。检查不过的边**一律丢弃并记缺口**——绝不能
   * 静默接受（`causedBySeq >= seq` 的边会让「投影按因果配对」这句话变成假话）。
   *
   * 纯存量会话（`causedBySeq` 全 NULL）时 `causationPresent === false`：这一整块
   * **什么都不产出**（无缺口、无 stats、无行为变化），输出与改动前逐字节相同。
   */
  const eventBySeq = new Map<number, ProjectionEvent>();
  for (const ev of ordered) {
    if (!eventBySeq.has(ev.seq)) eventBySeq.set(ev.seq, ev);
  }
  const causationPresent = ordered.some(
    (e) => e.causedBySeq !== undefined && e.causedBySeq !== null,
  );
  const causationStats: CausationStats = {
    eventsWithCausation: 0,
    eventsWithoutCausation: 0,
    invalid: 0,
    missing: 0,
    mismatched: 0,
    resolvedByCausation: 0,
    resolvedByHeuristic: 0,
    gapsTruncated: false,
  };
  /** 已验证可用的因果边（`seq` → 起因事件）。 */
  const causeOf = new Map<number, ProjectionEvent>();
  let causationGapCount = 0;
  const pushCausationGap = (gap: ProjectionGap): void => {
    if (causationGapCount >= CAUSATION_GAP_CAP) {
      // 截断必须可见：只丢条目不改标记，等于静默丢证据。
      causationStats.gapsTruncated = true;
      return;
    }
    causationGapCount += 1;
    gaps.push(gap);
  };

  if (causationPresent) {
    for (const ev of ordered) {
      const raw = ev.causedBySeq;
      let usable = false;
      if (raw !== undefined && raw !== null) {
        causationStats.eventsWithCausation += 1;
        if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
          causationStats.invalid += 1;
          pushCausationGap({
            class: "causation_invalid",
            seq: ev.seq,
            field: "causedBySeq",
            resolvedBy: "none",
            detail: `causedBySeq=${String(raw)} 不是正整数（seq 由 DB 从 1 分配）：该边被丢弃，本事件按启发式配对。`,
          });
        } else if (raw >= ev.seq) {
          causationStats.invalid += 1;
          pushCausationGap({
            class: "causation_invalid",
            seq: ev.seq,
            field: "causedBySeq",
            resolvedBy: "none",
            detail: `causedBySeq=${raw} >= seq=${ev.seq}：**因果必须先于结果**（时序倒挂 ⇒ 写入侧把结果当成了起因）。该边被丢弃并记在这里，不静默接受。`,
          });
        } else {
          const cause = eventBySeq.get(raw);
          if (!cause) {
            causationStats.missing += 1;
            pushCausationGap({
              class: "causation_missing",
              seq: ev.seq,
              field: "causedBySeq",
              resolvedBy: "none",
              detail: `causedBySeq=${raw} 在本会话事件流里不存在：要么是**跨会话引用**（写入侧 bug，该列没有 FK 拦它），要么那条前驱已被保留期清掉。投影只有一份输入，不宣称是哪一种；两种成因的处置相同——边悬空，按启发式配对。`,
            });
          } else {
            const mismatch = causationRuleMismatch(ev, cause);
            if (mismatch) {
              causationStats.mismatched += 1;
              pushCausationGap({
                class: "causation_mismatch",
                seq: ev.seq,
                field: "causedBySeq",
                resolvedBy: "none",
                detail: mismatch,
              });
            } else {
              causeOf.set(ev.seq, cause);
              usable = true;
            }
          }
        }
      }
      if (!usable && CAUSATION_REQUIRED_KINDS.has(ev.kind)) {
        causationStats.eventsWithoutCausation += 1;
      }
    }
  }

  /**
   * 逐事件标注「这条边是哪来的」（只在**本会话有因果数据**时执行）。
   *
   * `causation` / `heuristic` 必须可区分：把推断记成事实，正是这一列要消灭的东西。
   */
  const noteCausation = (ev: ProjectionEvent): void => {
    if (!causationPresent) return;
    const cause = causeOf.get(ev.seq);
    if (cause) {
      causationStats.resolvedByCausation += 1;
      pushCausationGap({
        class: "causation_pairing",
        seq: ev.seq,
        field: "kind",
        resolvedBy: "causation",
        detail: `本事件由 seq=${cause.seq}（${cause.kind}）引起：配对按**因果列**（causedBySeq），不靠 payload 推断。`,
      });
      return;
    }
    if (!CAUSATION_REQUIRED_KINDS.has(ev.kind)) return;
    causationStats.resolvedByHeuristic += 1;
    pushCausationGap({
      class: "causation_fallback",
      seq: ev.seq,
      field: "kind",
      resolvedBy: "heuristic",
      detail:
        "本事件没有可用的 causedBySeq（存量事件 / 写入点未接线 / 前驱解析不到唯一一行）：配对回落 payload 的 toolCallId/approvalKey —— 这是**推断**，不是事实。",
    });
  };

  /**
   * 起因事件 → 它指向的那次调用的 `toolCallId`（用于「payload 缺 id 时由因果救回身份」）。
   *
   * 两条路：`tool_call_recorded` 自带 `toolCallId`；`approval_decided` 要通过
   * `approvalKey` 反查「哪次调用的 `approvalId` 是这张单」——这正是因果图相对
   * 「按 toolCallId 归堆」多出来的那份信息。
   */
  const callIdOfCause = (cause: ProjectionEvent | undefined): string | null => {
    if (!cause) return null;
    const cp = (cause.payload ?? {}) as Record<string, unknown>;
    if (cause.kind === "tool_call_recorded") return str(cp.toolCallId);
    if (cause.kind === "approval_decided") {
      const key = str(cp.approvalKey);
      if (!key) return null;
      for (const c of calls.values())
        if (c.approvalId === key) return c.toolCallId;
    }
    return null;
  };
  /**
   * 正文来源的分别统计（事件自带 / 回落快照 / 两侧都没有 / 被截断）。
   *
   * 为什么单列：缺口分类回答「缺了什么」，这张表回答「**正文从哪来**」。库里必然
   * 同时存在存量事件（无 body ⇒ 回落快照）与新事件（有 body ⇒ 事件自足），只报
   * 一个总数就说不出「这条会话的正文有多少是事件自己扛的」。
   */
  const bodyStats: BodyResolutionStats = {
    fromEvent: 0,
    fromSnapshot: 0,
    fromNone: 0,
    truncated: 0,
  };
  /**
   * `approvalKey` → 该单最近一次状态变化。
   *
   * 这是本项目**第一次**让事件流承载审批结果：在此之前投影只能退回
   * 「等待人工审批」，而快照侧在 grant 之后会说「已获批准，请立即重提」。
   */
  const decisions = new Map<string, ApprovalDecision>();
  /** 没有 toolCallId 的台账行：事件里有，但身份不可用（投影无法把它对到某个调用上）。 */
  let unkeyedCallEvents = 0;

  for (const ev of ordered) {
    byKind[ev.kind] = (byKind[ev.kind] ?? 0) + 1;
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    switch (ev.kind) {
      case "step_appended": {
        const stepId = str(p.stepId);
        if (!stepId) {
          gaps.push({
            class: "missing_field",
            seq: ev.seq,
            field: "stepId",
            resolvedBy: "none",
            detail:
              "step_appended 没有 stepId：这一步无法与快照行对齐，投影只能跳过它。",
          });
          break;
        }
        steps.push({
          stepId,
          stepSeq: typeof p.stepSeq === "number" ? p.stepSeq : null,
          eventSeq: ev.seq,
          role: str(p.role) ?? "",
          folded: p.folded === true,
          toolCallCount:
            typeof p.toolCallCount === "number" ? p.toolCallCount : 0,
          // 正文优先取事件自带的（`payload.body.content`）；没有则回落快照行。
          contentBody: readBody(p, "content"),
        });
        break;
      }
      case "tool_call_recorded": {
        noteCausation(ev);
        const id = str(p.toolCallId);
        if (!id) {
          unkeyedCallEvents += 1;
          gaps.push({
            class: "event_only_metadata",
            seq: ev.seq,
            toolCallId: undefined,
            field: "toolCallId",
            resolvedBy: "none",
            detail:
              "tool_call_recorded 没有 toolCallId（迁移 069 之前的存量行）：快照侧还能按 (stepId, 工具名) 兜底匹配，投影侧没有这个兜底——身份不可用即无法投影。",
          });
          break;
        }
        calls.set(id, {
          toolCallId: id,
          toolName: str(p.toolName) ?? "",
          status: str(p.status) ?? "",
          approvalId: str(p.approvalId),
          resultTruncated: p.resultTruncated === true,
          hasResult: undefined,
          errorMessagePresent: undefined,
          lastSeq: ev.seq,
          // 「插入即终态」的行（denied / awaiting_approval）只有这一条事件——
          // 它的正文**只能**从这里拿，回读台账行答不出「那一刻的正文」。
          resultBody: readBody(p, "result"),
          errorBody: readBody(p, "error"),
        });
        break;
      }
      case "tool_call_status_changed": {
        noteCausation(ev);
        // A2：**有因果就先用因果配对**。因果边指向的那次调用就是本事件的归属
        // （`tool_call_recorded` 自带 id；`approval_decided` 经 approvalKey 反查）。
        // 它比 payload 的 `toolCallId` 多一层价值：payload 缺 id 时边还能把身份
        // 救回来（存量 concern 见下面的 unkeyed 分支），而 payload 与因果**互相
        // 矛盾**时更不能装作没看见——那是写入侧连错了对象。
        const declaredId = str(p.toolCallId);
        const cause = causeOf.get(ev.seq);
        const causeId = callIdOfCause(cause);
        if (declaredId && causeId && declaredId !== causeId) {
          causationStats.mismatched += 1;
          pushCausationGap({
            class: "causation_mismatch",
            seq: ev.seq,
            field: "toolCallId",
            resolvedBy: "none",
            detail: `payload 说本事件属于调用 ${declaredId}，而因果边指向的 seq=${cause?.seq ?? "?"}（${cause?.kind ?? "?"}）属于调用 ${causeId} ⇒ 两者矛盾，说明写入侧把边连到了另一次调用。投影按 payload 渲染（既有行为不变），但这条矛盾必须被看见：否则 A 的结果会被渲染成 B 的结果而无人发现。`,
          });
        }
        const id = declaredId ?? causeId;
        if (!id) {
          unkeyedCallEvents += 1;
          gaps.push({
            class: "event_only_metadata",
            seq: ev.seq,
            field: "toolCallId",
            resolvedBy: "none",
            detail:
              "tool_call_status_changed 没有 toolCallId：该状态迁移无法归属到任何调用。",
          });
          break;
        }
        const prev = calls.get(id);
        calls.set(id, {
          toolCallId: id,
          toolName: str(p.toolName) ?? prev?.toolName ?? "",
          status: str(p.status) ?? prev?.status ?? "",
          approvalId: prev?.approvalId ?? null,
          resultTruncated: p.resultTruncated === true,
          hasResult: p.hasResult === true,
          errorMessagePresent: p.errorMessage === "present",
          lastSeq: ev.seq,
          // 正文取**本次迁移**自带的那一份（不是上一条事件的，也不是台账行的
          // 当前值）：台账行会被下一次迁移就地覆盖，只有事件能答「第 N 次
          // 迁移时结果是什么」。
          resultBody: readBody(p, "result") ?? prev?.resultBody ?? null,
          errorBody: readBody(p, "error") ?? prev?.errorBody ?? null,
        });
        break;
      }
      case "approval_decided": {
        noteCausation(ev);
        // S7-G1 第四阶段：审批单状态变化（grant / deny / consume）。
        //
        // **刻意不改 `calls` 里的台账状态**：一次调用的 status 由
        // `tool_call_status_changed` 负责。审批单变了而台账行仍停在
        // `awaiting_approval` 是**常态**（grant 后模型还没重提），不是漂移；
        // 若在这里顺手把 status 改成 granted，投影就会自己制造一条台账里
        // 并不存在的状态迁移（切换后模型看到的状态与库里不符）。
        const key = str(p.approvalKey);
        if (!key) {
          gaps.push({
            class: "missing_field",
            seq: ev.seq,
            field: "approvalKey",
            resolvedBy: "none",
            detail:
              "approval_decided 没有 approvalKey：无法与任何调用的 approvalId 对齐，该决定被丢弃（写入点必须带它）。",
          });
          break;
        }
        const status = str(p.status);
        if (
          status !== "granted" &&
          status !== "denied" &&
          status !== "consumed"
        ) {
          gaps.push({
            class: "semantics_diverged",
            seq: ev.seq,
            toolCallId: undefined,
            field: "status",
            resolvedBy: "event",
            detail: `approval_decided 的 status「${status ?? ""}」不是决定状态（只认 granted/denied/consumed，取自 AGENT_APPROVAL_STATUSES）⇒ 该条不参与渲染，相关调用退回「等待人工审批」。`,
          });
          break;
        }
        decisions.set(key, {
          status,
          decidedBy: str(p.decidedBy),
          decidedAt: str(p.decidedAt),
          seq: ev.seq,
        });
        break;
      }
      case "prompt_fingerprint":
      case "session_finished":
        // 不影响 messages：前者是「当时看到什么」的摘要，后者是会话级终态。
        // 二者都是取证面的事实，投影不为它们产出消息（快照重建也不产出）。
        //
        // `prompt_fingerprint` 的因果规则是「触发这轮 LLM 调用的 step_appended」，
        // 所以它也要标注来源（有边 ⇒ causation，没边 ⇒ heuristic）。它不参与
        // 任何配对，标注的唯一用途是让报告说得清「这一轮的因果关系到底有没有」。
        if (ev.kind === "prompt_fingerprint") noteCausation(ev);
        break;
      default:
        gaps.push({
          class: "unknown_event",
          seq: ev.seq,
          field: "kind",
          resolvedBy: "none",
          detail: `未登记的事件类型「${ev.kind}」：写入点新增了 kind 但投影没跟上（可能悄悄少了一类事实）。`,
        });
        break;
    }
  }

  // 步的排序：快照按 `steps.seq` 升序；事件里 stepSeq 缺省时退回事件 seq 顺序
  // （正常情况下两者同序）。
  const orderedSteps = [...steps].sort((a, b) => {
    const ak = a.stepSeq === null ? 0 : 1;
    const bk = b.stepSeq === null ? 0 : 1;
    if (ak !== bk) return ak - bk;
    if (a.stepSeq !== null && b.stepSeq !== null && a.stepSeq !== b.stepSeq) {
      return a.stepSeq - b.stepSeq;
    }
    return a.eventSeq - b.eventSeq;
  });
  for (const step of orderedSteps) {
    if (step.stepSeq === null) {
      gaps.push({
        class: "missing_field",
        seq: step.eventSeq,
        stepId: step.stepId,
        field: "stepSeq",
        resolvedBy: "none",
        detail:
          "step_appended 没有 stepSeq：排序退回事件 seq（正常写入点不会缺）。",
      });
    }
  }

  const messages: MultimodalMessage[] = [systemMessage(snapshot, gaps)];

  // answeredIds：快照里已经存在的 tool 步（历史数据/测试构造）不重复补应答。
  // 与 `rebuildMessages` 同口径（先全量收集，再逐条补）。
  const answeredIds = new Set<string>();
  for (const step of orderedSteps) {
    if (step.role !== "tool") continue;
    const row = snapshot.steps?.[step.stepId];
    if (row === undefined) {
      gaps.push({
        class: "orphan_reference",
        seq: step.eventSeq,
        stepId: step.stepId,
        field: "step",
        resolvedBy: "none",
        detail:
          "事件引用的 stepId 在快照里不存在（可能已被保留期清理）：该步正文不可回读。",
      });
      continue;
    }
    const pairId = row.toolCallId ?? null;
    if (pairId) answeredIds.add(pairId);
    else {
      gaps.push({
        class: "event_only_metadata",
        seq: step.eventSeq,
        stepId: step.stepId,
        field: "toolCallId",
        resolvedBy: "none",
        detail:
          "role=tool 的步没有 toolCallId：无法证明它应答了哪个调用 ⇒ 同名调用可能被重复补一条 tool 消息。",
      });
    }
  }

  for (const step of orderedSteps) {
    const row = snapshot.steps?.[step.stepId];
    messages.push(...stepMessages(step, row, gaps, bodyStats));
    if (step.role !== "assistant" || step.folded) continue;

    const callsOfStep = resolveToolCalls(step, row);
    for (const call of callsOfStep) {
      if (!call?.id || answeredIds.has(call.id)) continue;
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: renderReplay(
          call.id,
          calls.get(call.id),
          snapshot,
          gaps,
          decisions,
          bodyStats,
        ),
      });
      answeredIds.add(call.id);
    }
  }
  if (unkeyedCallEvents > 0) {
    // 只为让计数可见：这些行在快照里可能真实存在且被 `pickReplayRow` 的
    // (stepId, 工具名) 兜底读到，而投影永远看不到它们（见上面的缺口 detail）。
    byKind.__unkeyed_tool_call_events = unkeyedCallEvents;
  }
  sweepRowsWithoutEvents(orderedSteps, calls, snapshot, gaps);
  sweepUnreferencedDecisions(calls, decisions, gaps);

  return {
    messages,
    gaps,
    integrity,
    stats: {
      eventCount: ordered.length,
      byKind,
      stepCount: orderedSteps.length,
      toolCallCount: calls.size,
      gapsByClass: countByClass(gaps),
      bodyResolution: bodyStats,
      // 只有本会话真的有因果数据时才出现（纯存量会话的 stats 逐字节不变）。
      ...(causationPresent ? { causation: causationStats } : {}),
    },
  };
}

/**
 * 因果边与**规则**是否矛盾（时序与存在性已在调用点查过）。
 *
 * 判据只有两条，但都属于「宁可报缺口，也不接受一条假边」：
 *   ① kind 兼容性：规则允许的父事件类型里有没有它（`AGENT_EVENT_CAUSATION_RULES`
 *      的读侧镜像）。`step_appended` / `session_finished` 的规则是「没有单一前驱」
 *      ⇒ 任何边都矛盾。
 *   ② 身份一致性：`tool_call_status_changed` 指向 `tool_call_recorded` 时必须是
 *      **同一次调用**；`approval_decided(consumed)` 指向 `approval_decided(granted)`
 *      时必须是**同一张审批单**。（身份比较只在两侧都声明了身份时做——缺字段
 *      时「无法反驳」，而不是「相等」。）
 *
 * @returns 人类可读的违规理由；`null` = 这条边与规则一致。
 */
function causationRuleMismatch(
  ev: ProjectionEvent,
  cause: ProjectionEvent,
): string | null {
  const allowed = CAUSATION_ALLOWED_PARENTS[ev.kind];
  // 未登记的 kind（投影不认识它）已由 `unknown_event` 单独记账：不在这里二次判定。
  if (!allowed) return null;
  if (allowed.length === 0) {
    return `${ev.kind} 的规则是「没有单一前驱事件」（刻意恒 NULL），却指向了 seq=${cause.seq}（${cause.kind}）⇒ 这是一条**假边**：它把一个不可归因的事实伪装成可归因（例如声称会话是因某条事件而结束的，而真实原因可能是管理员的 abort）。`;
  }
  if (!allowed.includes(cause.kind)) {
    return `${ev.kind} 的因果来源只能是 [${allowed.join(" / ")}]，而 seq=${cause.seq} 的 kind 是「${cause.kind}」⇒ 边与规则矛盾（写入侧解析错了对象）。边被丢弃，本事件按启发式配对。`;
  }
  const ep = (ev.payload ?? {}) as Record<string, unknown>;
  const cp = (cause.payload ?? {}) as Record<string, unknown>;
  if (
    ev.kind === "tool_call_status_changed" &&
    cause.kind === "tool_call_recorded"
  ) {
    const mine = str(ep.toolCallId);
    const theirs = str(cp.toolCallId);
    if (mine && theirs && mine !== theirs) {
      return `本事件属于调用 ${mine}，因果边却指向另一次调用（${theirs}）的 tool_call_recorded ⇒ 边连错了对象（投影会把 A 的结果渲染成 B 的结果）。`;
    }
  }
  if (ev.kind === "approval_decided" && cause.kind === "approval_decided") {
    const mine = str(ep.approvalKey);
    const theirs = str(cp.approvalKey);
    if (mine && theirs && mine !== theirs) {
      return `approval_decided(consumed) 的起因必须是**同一张审批单**上更早的 granted，而 seq=${cause.seq} 属于另一张单（${theirs}）⇒ consumed 与它在因果图上连成了一条不存在的链。`;
    }
  }
  return null;
}

/**
 * 逐字节比对两份 messages（对账报告的「差在哪一条」）。
 *
 * 「逐字节」= 先比 `JSON.stringify` 的全串（快路径），不同再逐条定位并给出
 * 首个不同的字符位置——只报「不完全一致」没有分诊价值，必须能落到具体一条。
 */
export function diffMessages(
  left: readonly MultimodalMessage[],
  right: readonly MultimodalMessage[],
): MessageDiff[] {
  const out: MessageDiff[] = [];
  const n = Math.max(left.length, right.length);
  for (let i = 0; i < n; i += 1) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) {
      out.push({ index: i, left: null, right: r, kind: "missing-left" });
      continue;
    }
    if (r === undefined) {
      out.push({ index: i, left: l, right: null, kind: "missing-right" });
      continue;
    }
    const ls = JSON.stringify(l);
    const rs = JSON.stringify(r);
    if (ls === rs) continue;
    let charAt = 0;
    while (
      charAt < ls.length &&
      charAt < rs.length &&
      ls[charAt] === rs[charAt]
    ) {
      charAt += 1;
    }
    out.push({ index: i, left: l, right: r, kind: "different", charAt });
  }
  return out;
}

/* ── 内部纯函数 ─────────────────────────────────────────────────── */

/**
 * 反向完整性：**快照里有行、事件流里没有记录**。
 *
 * 这是「事件写入是旁路」这条纪律的代价面：旁路失败只 warn，主数据完整而事件
 * 缺一段。快照重建照样能拼出上下文，事件投影却会少一条消息——对账必须能看见
 * 这件事，否则「投影少一条」会被误读成「快照多一条」。
 */
function sweepRowsWithoutEvents(
  steps: readonly StepState[],
  calls: ReadonlyMap<string, CallState>,
  snapshot: ProjectionSnapshot,
  gaps: ProjectionGap[],
): void {
  const seenSteps = new Set(steps.map((s) => s.stepId));
  for (const id of Object.keys(snapshot.steps ?? {})) {
    if (seenSteps.has(id)) continue;
    gaps.push({
      class: "row_without_event",
      seq: null,
      stepId: id,
      field: "step",
      resolvedBy: "none",
      detail:
        "快照里有这一步，事件流里没有 step_appended（旁路写入失败，或该步早于事件表存在）⇒ 投影少一条消息。",
    });
  }
  for (const id of Object.keys(snapshot.toolCalls ?? {})) {
    if (calls.has(id)) continue;
    gaps.push({
      class: "row_without_event",
      seq: null,
      toolCallId: id,
      field: "tool_call",
      resolvedBy: "none",
      detail:
        "台账里有这一行，事件流里没有任何 tool_call_recorded/status_changed ⇒ 投影渲染「结果缺失」，快照侧会渲染真实结果（这是真实差异，不是投影的 bug）。",
    });
  }
  if ((snapshot.unkeyedToolCallRows ?? 0) > 0) {
    gaps.push({
      class: "row_without_event",
      seq: null,
      field: "toolCallId",
      resolvedBy: "none",
      detail: `台账里有 ${snapshot.unkeyedToolCallRows} 行没有 toolCallId（存量行）：快照侧按 (stepId, 工具名) 兜底匹配，投影侧没有这个兜底 ⇒ 这些调用在投影里不可见，差异无法被投影自身察觉（只能靠这份清单）。`,
    });
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * 从事件 payload 里取出一个正文信封（`payload.body.<slot>`）。
 *
 * 返回 `null` 的**四种**情况都要区分清楚，因为它们指向不同的回落路径：
 *   · `body` 整个不存在 ⇒ **存量事件**（第五阶段之前写入）⇒ 回落快照行；
 *   · `body` 在、但该 slot 是 `null` ⇒ 写入侧**明确没有**这一项正文（结果确实
 *     为空 / 错误确实为空）⇒ 也回落快照（快照侧读到 `null`，两侧同为空）；
 *   · `body` 在、slot 在，但 `text` 不是字符串 ⇒ **形状不对**（坏数据）⇒
 *     回落快照并留痕，绝不把 `undefined` 当正文渲染出去；
 *   · 正常情形 ⇒ 返回信封。
 *
 * 为什么不能「宽松地」把任何非空对象当正文：写侧的信封形状是**契约**
 * （`text`/`bytes`/`originalBytes`/`truncated`），读侧若不校验就渲染，坏数据
 * 会变成「模型看到一段 `undefined`」——那比重回快照更糟（回读至少拿到真值）。
 */
function readBody(
  payload: Record<string, unknown>,
  slot: "content" | "result" | "error",
): ProjectionBody | null {
  const bag = payload.body;
  if (!bag || typeof bag !== "object") return null;
  const raw = (bag as Record<string, unknown>)[slot];
  if (!raw || typeof raw !== "object") return null;
  const text = (raw as Record<string, unknown>).text;
  if (typeof text !== "string") return null;
  return {
    text,
    bytes: numOf((raw as Record<string, unknown>).bytes),
    originalBytes: numOf((raw as Record<string, unknown>).originalBytes),
    truncated: (raw as Record<string, unknown>).truncated === true,
  };
}

/** 数值字段的宽松读取（非有限数按「缺失」处理，绝不当成 0 报出去）。 */
function numOf(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * 正文信封的**渲染**：文本 + （若被截断）截断标注。
 *
 * 为什么截断标注必须出现在**给模型看的文字里**，而不能只留在缺口表：缺口表是
 * 给审计看的，模型看不到它。若正文被截了却不告诉模型，模型会把 2 KiB 前缀当成
 * 全文来推理——它的结论因此建立在「我以为我看到了全部」之上。
 *
 * `originalBytes` 缺失时（坏数据）用**文本字节数**兜底：宁可给一个近似值，
 * 也不能静默丢掉「这里被截过」这个事实。
 */
function renderBodyText(body: ProjectionBody): string {
  if (!body.truncated) return body.text;
  const original =
    body.originalBytes ?? body.bytes ?? Buffer.byteLength(body.text, "utf8");
  return `${body.text}${TRUNCATION_NOTE(original)}`;
}

/**
 * 反向完整性（审批）：事件里有一条决定，但**没有任何调用**引用那张单。
 *
 * 为什么必须点名：审批决定事件的消费路径只有一条——`CallState.approvalId`
 * （来自 `tool_call_recorded`）。若那次 `tool_call_recorded` 丢了（旁路失败）
 * 或该单还没被任何调用引用（申请与调用是两次写入），决定就**写了但没人读**。
 * 静默忽略会让「事件在写」看起来像「投影已在用」，而下一次对账仍会说
 * 「等待人工审批」而没人知道为什么。
 */
function sweepUnreferencedDecisions(
  calls: ReadonlyMap<string, CallState>,
  decisions: ReadonlyMap<string, ApprovalDecision>,
  gaps: ProjectionGap[],
): void {
  if (decisions.size === 0) return;
  const referenced = new Set<string>();
  for (const call of calls.values()) {
    if (call.approvalId) referenced.add(call.approvalId);
  }
  for (const [key, decision] of decisions) {
    if (referenced.has(key)) continue;
    gaps.push({
      class: "orphan_reference",
      seq: decision.seq,
      field: "approvalKey",
      resolvedBy: "none",
      detail: `approval_decided 指向审批单 ${key}，但事件流里没有任何 tool_call_recorded 的 approvalId 引用它 ⇒ 该决定写了没人读（调用记录可能旁路丢失）。`,
    });
  }
}

function countByClass(gaps: readonly ProjectionGap[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const g of gaps) out[g.class] = (out[g.class] ?? 0) + 1;
  return out;
}

/** seq 完整性：缺洞、重复、首尾（截断以免一条坏会话把报告刷爆）。 */
function inspectSeq(
  ordered: readonly ProjectionEvent[],
  inputSorted: boolean,
): SeqIntegrity {
  const seen = new Map<number, number>();
  for (const ev of ordered) seen.set(ev.seq, (seen.get(ev.seq) ?? 0) + 1);
  const duplicates = [...seen.entries()]
    .filter(([, n]) => n > 1)
    .map(([seq]) => seq)
    .sort((a, b) => a - b);
  const lastSeq = ordered.length ? ordered[ordered.length - 1].seq : null;
  const missing: number[] = [];
  let missingSeqTruncated = false;
  if (lastSeq !== null) {
    const present = new Set(ordered.map((e) => e.seq));
    for (let seq = 1; seq <= lastSeq; seq += 1) {
      if (present.has(seq)) continue;
      if (missing.length >= MISSING_SEQ_CAP) {
        missingSeqTruncated = true;
        break;
      }
      missing.push(seq);
    }
  }
  return {
    count: ordered.length,
    firstSeq: ordered.length ? ordered[0].seq : null,
    lastSeq,
    missing,
    missingSeqTruncated,
    duplicates,
    contiguous: missing.length === 0 && duplicates.length === 0,
    inputSorted,
  };
}

/** 首条 system 消息（`SYSTEM_PROMPT` + 上下文段，逐字对齐 `rebuildMessages`）。 */
function systemMessage(
  snapshot: ProjectionSnapshot,
  gaps: ProjectionGap[],
): MultimodalMessage {
  const prompt = snapshot.systemPrompt;
  if (prompt === undefined) {
    gaps.push({
      class: "not_eventized",
      seq: null,
      field: "systemPrompt",
      resolvedBy: "none",
      detail:
        "system prompt 是**代码常量**（不是事件、也不是快照行）：调用方必须显式注入，投影不复制（复制必然漂移）。缺失时首条消息为空串。",
    });
  }
  const base = prompt ?? "";
  if (snapshot.contextJson === undefined) {
    gaps.push({
      class: "not_eventized",
      seq: null,
      field: "contextJson",
      resolvedBy: "none",
      detail:
        "会话上下文（session.contextJson）没有任何事件承载：必须由调用方从会话行显式传入（含 null = 确认没有），否则会话级差异会被静默吞掉。",
    });
    return { role: "system", content: base };
  }
  const raw = snapshot.contextJson
    ? JSON.stringify(snapshot.contextJson, null, 2)
    : "";
  const contextText = raw.slice(0, CONTEXT_MAX_CHARS);
  gaps.push({
    class: "not_eventized",
    seq: null,
    field: "contextJson",
    resolvedBy: "snapshot",
    detail:
      "会话上下文来自会话行（事件流里没有这项事实）；对账时两侧读到同一份，故不产生差异。",
  });
  return {
    role: "system",
    content: contextText ? `${base}${CONTEXT_HEADER}${contextText}` : base,
  };
}

/** 一步 → 一条消息（逐字对齐 `stepToMessages`，含折叠替身与 tool→user 改写）。 */
function stepMessages(
  step: StepState,
  row: SnapshotStep | undefined,
  gaps: ProjectionGap[],
  stats: BodyResolutionStats,
): MultimodalMessage[] {
  if (step.folded && step.role !== "system") {
    // 折叠摘要正文：**事件不记**（写入侧只记 `folded=true`，摘要正文留在
    // `agent_steps.summary`）⇒ 这里**只能**回读快照行，并如实标注来源是快照。
    const summary = row?.summary;
    if (summary === "") {
      // 事件侧判定折叠用的是 `(input.summary ?? null) !== null`（空串也算折叠），
      // 而 `rebuildMessages`/`stepToMessages` 判的是**真值**（空串不算折叠）。
      // 同一份数据的两个口径 ⇒ 投影必然多一条「[阶段小结] 」，快照侧会给出
      // assistant/user 原消息。这属于「两侧口径不同」，不是事件缺失。
      gaps.push({
        class: "semantics_diverged",
        seq: step.eventSeq,
        stepId: step.stepId,
        field: "folded",
        resolvedBy: "event",
        detail:
          "事件 folded=true，但快照侧的摘要为空串（真值判断不折叠）⇒ 折叠口径不同（`!== null` vs 真值），投影按事件侧渲染，必然与快照不一致。",
      });
    }
    gaps.push({
      class: "event_only_metadata",
      seq: step.eventSeq,
      stepId: step.stepId,
      field: "summary",
      resolvedBy:
        summary === undefined || summary === null ? "none" : "snapshot",
      detail:
        "折叠步的摘要正文（agent_steps.summary）不在事件里，事件只记 folded=true ⇒ 投影必须回读快照行；回读不到时只能给带标记的兜底文案。",
    });
    const body =
      summary === undefined || summary === null
        ? `${GAP_MARK}摘要正文缺失（事件只记 folded=true，正文需回读 agent_steps.summary）`
        : summary;
    return [
      {
        role: step.role === "tool" ? "user" : (step.role as "assistant"),
        content: `[阶段小结] ${body}`,
      },
    ];
  }

  // ── 正文来源：事件自带优先，回落快照 ────────────────────────────
  //
  // 判据只有一条：**这条事件的 `payload.body.content` 存在吗**。
  //   · 有 ⇒ 用它渲染（正文是「第 N 轮模型看到的那段」，`agent_steps.content`
  //     会被后续写入覆盖，回读到的未必是它）；
  //   · 没有（存量事件 / 该 kind 不带正文）⇒ 回读快照行，并把来源**如实**记成
  //     `event_only_metadata` + `resolvedBy: "snapshot"`——**不许**把回落伪装成
  //     「事件自足」。
  //
  // 回落路径的**缺口表与渲染逐字节不变**（存量兼容是硬要求）：原来「快照行整个
  // 不存在」时直接给兜底文案且**不记** content 缺口，现在仍必须如此——否则存量
  // 会话的对账报告会凭空多出一批缺口，看起来像「投影坏了」。
  const body = step.contentBody;
  if (body === null) {
    if (row === undefined) {
      // 正文完全没有来源：给出一条**带标记**的消息而不是丢消息——丢消息会让
      // 「投影少一条」看起来像「快照多一条」，而真相是「事件流没有这一步的正文」。
      stats.fromNone += 1;
      return [
        {
          role: passThroughRole(step.role),
          content: `${GAP_MARK}该步正文无法投影（事件只记 stepId/角色，且未提供快照行回读）`,
        },
      ];
    }
    // 回落：**如实**标注来源是快照（存量事件根本没有 body）。
    gaps.push(contentGap(step, "content", row.content));
    stats.fromSnapshot += 1;
  } else {
    gaps.push({
      class: "resolved_by_event",
      seq: step.eventSeq,
      stepId: step.stepId,
      field: "content",
      resolvedBy: "event",
      detail:
        "步正文由事件自带（payload.body.content）⇒ 不回读 agent_steps.content（该列会被后续写入覆盖，回读到的不是「第 N 轮看到的那段」）。",
    });
    stats.fromEvent += 1;
    if (body.truncated) {
      stats.truncated += 1;
      gaps.push({
        class: "body_truncated",
        seq: step.eventSeq,
        stepId: step.stepId,
        field: "content",
        resolvedBy: "event",
        detail: `事件自带正文在写入时被截断（原文 ${body.originalBytes ?? body.bytes ?? 0} 字节，单条上限 2 KiB）⇒ 渲染文案已带「已截断」标注，模型据此知道内容不完整。`,
      });
    }
    if (row === undefined) {
      // 事件自带正文时仍然渲染它（正文比兜底文案有取证价值），但 `tool_call_id`
      // / `tool_calls` 仍无来源 ⇒ 协议上会被上游 400，如实记缺口。
      gaps.push({
        class: "missing_field",
        seq: step.eventSeq,
        stepId: step.stepId,
        field: step.role === "tool" ? "toolCallId" : "toolCallsJson",
        resolvedBy: "none",
        detail:
          "快照行已不可用（可能已被保留期清理）⇒ 该步的 tool_call_id / tool_calls 无来源；正文仍取事件自带的那一份。",
      });
    }
  }
  const content = body !== null ? renderBodyText(body) : (row?.content ?? "");

  if (step.role === "tool") {
    return [
      {
        role: "tool",
        content,
        tool_call_id: row?.toolCallId ?? undefined,
      },
    ];
  }
  if (step.role === "assistant") {
    if (row?.toolCalls === undefined && step.toolCallCount > 0) {
      gaps.push({
        class: "event_only_metadata",
        seq: step.eventSeq,
        stepId: step.stepId,
        field: "toolCallsJson",
        resolvedBy: "none",
        detail: `事件只记 toolCallCount=${step.toolCallCount}，不含 tool_call 的 id/顺序 ⇒ assistant 的 tool_calls 与随后的 tool 应答都无法投影（协议上会被上游 400）。`,
      });
    } else if (step.toolCallCount > 0) {
      gaps.push({
        class: "event_only_metadata",
        seq: step.eventSeq,
        stepId: step.stepId,
        field: "toolCallsJson",
        resolvedBy: "snapshot",
        detail:
          "tool_calls 的 id/参数/顺序不在事件里（只记条数），按约定回读 agent_steps.toolCallsJson。",
      });
    }
    return [
      {
        role: "assistant",
        content,
        tool_calls: row?.toolCalls ?? undefined,
      },
    ];
  }
  return [{ role: passThroughRole(step.role), content }];
}

/**
 * 非 assistant/tool 分支的角色直通（`stepToMessages` 的 `step.role as "user"`
 * 是同一件事：运行期原样保留，类型上收窄成 user）。未知角色按 user 处理——
 * 与快照侧一致（它也是原样透传，上游会拒绝未知角色，但那是对账该看见的差异）。
 */
function passThroughRole(role: string): MultimodalMessage["role"] {
  return role === "system" ? "system" : "user";
}

/**
 * 回落路径的缺口记账（`undefined` = 未提供；`null`/`""` = 明确为空，不算缺口）。
 *
 * `resolvedBy` 必须是 `snapshot`：这条事件**没有自带正文**，正文靠回读台账行
 * 补上——把它记成 `event` 就是在说谎（「事件自足」），而说谎会让报告误判
 * 「读路径已经可以切到事件流」。
 */
function contentGap(
  step: StepState,
  field: string,
  value: string | null | undefined,
): ProjectionGap {
  const missing = value === undefined;
  return {
    class: "event_only_metadata",
    seq: step.eventSeq,
    stepId: step.stepId,
    field,
    resolvedBy: missing ? "none" : "snapshot",
    detail: missing
      ? "事件不记步正文（只记 stepId/角色/折叠位），且未提供快照行 ⇒ 该步消息正文无法等价。"
      : "步正文来自 agent_steps（这条事件没有自带 body）：两侧读同一份，故不产生差异。",
  };
}

/** 某步的 tool_calls（事件只有条数，id/顺序必须回读快照）。 */
function resolveToolCalls(
  step: StepState,
  row: SnapshotStep | undefined,
): ToolCall[] {
  if (row?.toolCalls) return row.toolCalls;
  if (step.toolCallCount > 0) {
    // 已在 stepMessages 里记过同一缺口；这里不重复记，只返回空数组（= 什么都不补）。
    return [];
  }
  return [];
}

/**
 * 把一次调用的**事件状态**渲染成「重放给模型的 tool 应答」。
 *
 * 逐字对齐 `replayedToolResult`：分支顺序、标点、括号、省略号都必须一致，
 * 否则对账会红（那正是它存在的意义——runtime 里那份是私有的，文本一旦改动，
 * 本文件不会编译失败，只会让对账变红；所以对账脚本是这条契约的闸）。
 *
 * **审批单状态**（S7-G1 第四阶段）：过去这里一律退回「等待人工审批」，因为
 * `agent_approvals` 的写入不产生任何事件。现在 `approval_decided` 承载
 * `approvalKey` + `status` + `decidedBy`，三句文案因此可以从事件流重建——
 * 且是**逐字**重建（快照侧那句 `decidedBy ?? "管理员"` 的兜底也照抄）。
 */
function renderReplay(
  callId: string,
  state: CallState | undefined,
  snapshot: ProjectionSnapshot,
  gaps: ProjectionGap[],
  decisions: ReadonlyMap<string, ApprovalDecision>,
  stats: BodyResolutionStats,
): string {
  const row = snapshot.toolCalls?.[callId];
  if (!state) {
    // 台账里有这一行却没有事件：sweep 阶段已统一记账（见 projectSession 尾部），
    // 这里不重复记，只渲染「结果缺失」——与快照侧在「行也不存在」时的文案相同，
    // 差异因此不会被投影自己抹平。
    return MISSING_RECORD_TEXT;
  }
  crossCheckStatus(callId, state, row, gaps);

  if (state.status === "awaiting_approval") {
    const approvalId = state.approvalId;
    const decision = approvalId ? decisions.get(approvalId) : undefined;
    if (approvalId && decision) {
      gaps.push({
        class: "resolved_by_event",
        seq: decision.seq,
        toolCallId: callId,
        field: "approvalStatus",
        resolvedBy: "event",
        detail: `审批单 ${approvalId} 的结论（${decision.status}）与决定人都由 approval_decided 事件（seq=${decision.seq}）给出 ⇒ 与快照同文案，不需要回读 agent_approvals。`,
      });
      if (decision.status === "granted") {
        return (
          `【已获批准】审批单 ${approvalId} 已由 ${decision.decidedBy ?? "管理员"} 批准。` +
          `请**立即用完全相同的参数重新提交本次调用**以执行` +
          `（一张批准单只放行一次；执行后继续后续步骤，不要重复提交第二次）。`
        );
      }
      if (decision.status === "denied") {
        // 第五阶段：controller 的 settle 现在会在**条件 UPDATE 命中之后**补一条
        // `tool_call_status_changed`（见 `agent.controller.ts` 的
        // `emitToolCallSettledEvents`）。走到这个分支说明**那条事件没到**——
        // 旁路写失败，或这是早于该写入点的存量会话 ⇒ 事件流仍停在
        // awaiting_approval，而台账行已经 denied。
        //
        // 这里**不**「顺手把 status 改成 denied」：那是伪造一条事件流里并不存在
        // 的迁移，会让投影在「管理员只拒了单、settle 还没发生（或失败）」时说成
        // 已落库——比不一致更坏。如实记缺口，让对账把它抓出来。
        gaps.push({
          class: "not_eventized",
          seq: decision.seq,
          toolCallId: callId,
          field: "toolCallSettled",
          resolvedBy: "none",
          detail:
            "deny 之后 agent.controller.ts 会把台账行 settle 成 denied（settleToolCallByApprovalId）；该写入点现在会在条件 UPDATE 命中之后补一条 tool_call_status_changed，**这里没有它** ⇒ 要么是旁路写失败，要么是存量会话早于该写入点。投影按「已被拒绝」渲染，快照按台账行渲染「【调用未成功】状态 denied：…」⇒ 两侧仍不一致。",
        });
        return (
          `【已被拒绝】审批单 ${approvalId} 已被 ${decision.decidedBy ?? "管理员"} 拒绝。` +
          `不得重试同一调用：请改走其他手段核实，或把「需要人工执行」写进最终结论。`
        );
      }
      return (
        `【已执行】该调用已凭审批单 ${approvalId} 执行过一次；` +
        `请勿重复提交（一张批准单只放行一次），需要再次执行请在最终报告中说明。`
      );
    }
    gaps.push({
      class: "not_eventized",
      seq: state.lastSeq,
      toolCallId: callId,
      field: "approvalDecided",
      resolvedBy: "none",
      detail: approvalId
        ? `事件流里没有审批单 ${approvalId} 的 approval_decided：要么它仍是 pending（此时本句与快照一致），要么这次写入是旁路、决定那一条丢了（此时快照会说「已获批准 / 已被拒绝 / 已执行」，与本句**语义相反**）。`
        : "tool_call_recorded 的 payload 没带 approvalId ⇒ 即使有 approval_decided 也对不到这次调用 ⇒ 只能按「等待人工审批」渲染。",
    });
    const msg = errorText(callId, state, row, gaps, true, stats);
    return `【等待人工审批】${msg ?? "该调用需人工审批"}（会话已挂起；批准后会恢复；批准前请勿重复提交）。`;
  }
  if (state.status === "in_flight") {
    return (
      "【结果未知】该调用在进程中断前已发起，副作用可能已经发生。" +
      "请先用只读工具核实当前状态；确认未生效后再决定是否重新提交，" +
      "不要直接重提同一调用。"
    );
  }
  if (state.status === "ok") {
    if (state.hasResult === false) {
      const shaped = shapeToolResultForModel("", REPLAY_MAX_CHARS);
      return `【工具结果（重放）】${shaped.content}${
        state.resultTruncated ? "…（原结果已截断）" : ""
      }`;
    }
    // ── 正文来源：事件自带优先，回落快照 ────────────────────────────
    //
    // 判据：`state.resultBody`（本次状态迁移自带的 `payload.body.result`）存在吗。
    // 存在 ⇒ 用它；不存在（存量事件 / 该 kind 不带正文）⇒ 回读台账行，并把来源
    // **如实**记成 `event_only_metadata` + `resolvedBy: "snapshot"`。
    //
    // 为什么优先事件：台账行是**就地更新**的，回读到的永远是「最后一次写入」，
    // 答不出「第 N 次迁移时结果是什么」——那正是读路径要回答的问题。
    const eventBody = state.resultBody;
    if (eventBody !== null) {
      gaps.push({
        class: "resolved_by_event",
        seq: state.lastSeq,
        toolCallId: callId,
        field: "resultJson",
        resolvedBy: "event",
        detail:
          "结果正文由事件自带（payload.body.result）⇒ 不回读 agent_tool_calls.resultJson（该列被后续迁移就地覆盖，回读到的不是「这次迁移那一刻」的结果）。",
      });
      stats.fromEvent += 1;
      if (eventBody.truncated) {
        stats.truncated += 1;
        gaps.push({
          class: "body_truncated",
          seq: state.lastSeq,
          toolCallId: callId,
          field: "resultJson",
          resolvedBy: "event",
          detail: `事件自带的结果正文在写入时被截断（原文 ${eventBody.originalBytes ?? eventBody.bytes ?? 0} 字节，单条上限 2 KiB）⇒ 渲染文案已带「已截断」标注；此时与快照侧**必然不一致**（快照读的是完整台账行），这是真实差异，不是投影的 bug。`,
        });
      }
      return renderResultBody(eventBody, state);
    }
    if (!row || row.result === undefined) {
      gaps.push({
        class: "missing_field",
        seq: state.lastSeq,
        toolCallId: callId,
        field: "resultJson",
        resolvedBy: "none",
        detail:
          "事件只记 hasResult=true（存在性），不记结果正文；未提供快照行 ⇒ 正文无法等价（快照侧会渲染真实 JSON / 预览 / sha256）。",
      });
      stats.fromNone += 1;
      return (
        `【工具结果（重放·正文缺失）】${GAP_MARK}事件只记「有结果」，` +
        `正文需回读 agent_tool_calls.resultJson`
      );
    }
    const stored = row.result as Record<string, unknown> | null;
    crossCheckResultFlags(callId, state, row, gaps);
    if (state.hasResult === true && stored === null) {
      gaps.push({
        class: "event_lags_snapshot",
        seq: state.lastSeq,
        toolCallId: callId,
        field: "resultJson",
        resolvedBy: "event",
        detail:
          "事件说「有结果」，台账行的 resultJson 却是 null ⇒ 两者漂移（事件按有/无结果的旧值）。",
      });
    }
    // 回落路径：**不新增缺口条目**（存量兼容是硬要求）。
    //
    // 为什么这里刻意**不**补一条 `event_only_metadata/resultJson`：改动前的这条
    // 路径就没有记它（只有「快照行都读不到」与「事件说有、台账说无」两类才记）。
    // 存量事件若凭空多出一条缺口，存量会话的对账报告会看起来「比以前脏了」——
    // 而正文来源的变化由 `stats.bodyResolution.fromSnapshot` **单独**统计（不混
    // 进缺口分类），那才是「两者分别统计」该落的地方。
    stats.fromSnapshot += 1;
    if (stored && stored.truncated === true) {
      if (typeof stored.full === "string") {
        const shaped = shapeToolResultForModel(stored.full, REPLAY_MAX_CHARS);
        return `【工具结果（重放）】${shaped.content}`;
      }
      const preview = typeof stored.preview === "string" ? stored.preview : "";
      return (
        `【工具结果（重放·仅预览）】${preview}` +
        `\n（原结果超过 32KB 存储上限，仅保留预览与 sha256=${String(stored.sha256 ?? "n/a")}；` +
        `需要完整内容请按参数重新查询只读资源）`
      );
    }
    const body = stored ? JSON.stringify(stored) : "";
    const shaped = shapeToolResultForModel(body, REPLAY_MAX_CHARS);
    return `【工具结果（重放）】${shaped.content}${
      state.resultTruncated ? "…（原结果已截断）" : ""
    }`;
  }
  if (state.status === "denied") {
    const msg = errorText(callId, state, row, gaps, false, stats);
    if (typeof msg === "string" && msg.startsWith("skipped:")) {
      if (msg.includes("approval")) {
        return "【未执行】本次调用因同批前一个调用进入人工审批而跳过（会话已挂起）。如需执行本调用，请在恢复后重新提交。";
      }
      return "【未执行】本次调用因会话墙钟预算到期而跳过。如需继续，请新建会话或调大预算后重新指派。";
    }
    return `【调用未成功】状态 ${state.status}${msg ? `：${msg}` : ""}`;
  }
  const msg = errorText(callId, state, row, gaps, false, stats);
  return `【调用未成功】状态 ${state.status}${msg ? `：${msg}` : ""}`;
}

/**
 * 用**事件自带**的结果正文渲染 tool 应答。
 *
 * 为什么不能直接把 `body.text` 当字符串塞进去：台账的 `resultJson` 是**结构化**
 * 的，快照侧对它有三种形态（普通 JSON / `truncated+full` / `truncated+preview+sha256`），
 * 各自对应**不同的模型可见文案**。事件正文是那份结构的**紧凑 JSON 串**，所以这里
 * 先把它**解析回结构**再套同一套渲染规则——这样「事件自足」的会话与「回读快照」
 * 的会话给出的文案**逐字相同**（切换读路径的那一天，模型看到什么才不会变）。
 *
 * 解析失败或正文被截断 ⇒ 退化成「原样 + 截断标注」：**如实**告诉模型这是前缀，
 * 绝不假装看到了全文。
 */
function renderResultBody(body: ProjectionBody, state: CallState): string {
  const suffix = state.resultTruncated ? "…（原结果已截断）" : "";
  if (body.truncated) {
    // 截断的 JSON 一定不完整 ⇒ 解析必失败（或更糟：解析出一个**子集**，那会把
    // 「被截掉的部分」说成「本来就没有」）。因此这里**不解析**，直接原样渲染 +
    // 截断标注。
    const shaped = shapeToolResultForModel(body.text, REPLAY_MAX_CHARS);
    const original =
      body.originalBytes ?? body.bytes ?? Buffer.byteLength(body.text, "utf8");
    return `【工具结果（重放）】${shaped.content}${suffix}${TRUNCATION_NOTE(
      original,
    )}`;
  }
  let stored: unknown;
  try {
    stored = JSON.parse(body.text);
  } catch {
    // 不是 JSON（写侧对无法序列化的值写的是 `[UNSERIALIZABLE]` 这类占位）。
    // 如实原样渲染，不假装它是结构化结果。
    const shaped = shapeToolResultForModel(body.text, REPLAY_MAX_CHARS);
    return `【工具结果（重放）】${shaped.content}${suffix}`;
  }
  if (
    stored &&
    typeof stored === "object" &&
    (stored as Record<string, unknown>).truncated === true
  ) {
    const obj = stored as Record<string, unknown>;
    if (typeof obj.full === "string") {
      const shaped = shapeToolResultForModel(obj.full, REPLAY_MAX_CHARS);
      return `【工具结果（重放）】${shaped.content}`;
    }
    const preview = typeof obj.preview === "string" ? obj.preview : "";
    return (
      `【工具结果（重放·仅预览）】${preview}` +
      `\n（原结果超过 32KB 存储上限，仅保留预览与 sha256=${String(obj.sha256 ?? "n/a")}；` +
      `需要完整内容请按参数重新查询只读资源）`
    );
  }
  const shaped = shapeToolResultForModel(body.text, REPLAY_MAX_CHARS);
  return `【工具结果（重放）】${shaped.content}${suffix}`;
}

/**
 * 错误正文：**事件自带优先，回落台账行**。
 *
 * `required` 只影响缺口分类的措辞：某些分支（待审批的兜底文案、skipped 的区分）
 * **必须**有正文才能等价；而 `【调用未成功】状态 x` 在正文缺失时仍能给出
 * 一个诚实的（但不等价的）文案。
 */
function errorText(
  callId: string,
  state: CallState,
  row: SnapshotToolCall | undefined,
  gaps: ProjectionGap[],
  required: boolean,
  stats: BodyResolutionStats,
): string | null {
  const present = state.errorMessagePresent;
  // ── 事件自带优先 ────────────────────────────────────────────────
  //
  // 判据：`state.errorBody`（本次状态迁移自带的 `payload.body.error`）存在吗。
  // 存在 ⇒ 用它（它是「那次迁移那一刻」的错误文案）；不存在 ⇒ 回读台账行。
  //
  // 为什么事件优先：台账行的 `errorMessage` 是**就地覆盖**的——一次调用先失败
  // 后被 settle 成 denied，回读到的永远是**最后**那次写的文案，答不出「上一次
  // 失败时模型看到的是什么」。
  const eventBody = state.errorBody;
  if (eventBody !== null) {
    gaps.push({
      class: "resolved_by_event",
      seq: state.lastSeq,
      toolCallId: callId,
      field: "errorMessage",
      resolvedBy: "event",
      detail:
        "错误正文由事件自带（payload.body.error）⇒ 不回读 agent_tool_calls.errorMessage（该列被后续迁移就地覆盖，回读到的不是「这次迁移那一刻」的错误文案）。",
    });
    stats.fromEvent += 1;
    if (eventBody.truncated) {
      stats.truncated += 1;
      gaps.push({
        class: "body_truncated",
        seq: state.lastSeq,
        toolCallId: callId,
        field: "errorMessage",
        resolvedBy: "event",
        detail: `事件自带的错误正文在写入时被截断（原文 ${eventBody.originalBytes ?? eventBody.bytes ?? 0} 字节，单条上限 2 KiB）⇒ 渲染文案已带「已截断」标注。`,
      });
    }
    return renderBodyText(eventBody);
  }
  const text = row?.errorMessage;
  if (text !== undefined && text !== null) {
    if (present === true) {
      gaps.push({
        class: "event_only_metadata",
        seq: state.lastSeq,
        toolCallId: callId,
        field: "errorMessage",
        resolvedBy: "snapshot",
        detail:
          '事件只把 errorMessage 记成 "present"，正文须回读 agent_tool_calls.errorMessage（skipped:approval 与 skipped:wall_clock 的区分也靠它）。',
      });
    } else if (present === undefined) {
      // 只有 `tool_call_recorded`（没有后续 status_changed）：它的 payload **根本不带**
      // errorMessage 字段。而 `skipped: approval` / `skipped: wall_clock` 恰恰是
      // 「插入即终态」的行——事件里只有一条 recorded，正文只能回读台账行。
      gaps.push({
        class: "event_only_metadata",
        seq: state.lastSeq,
        toolCallId: callId,
        field: "errorMessage",
        resolvedBy: "snapshot",
        detail:
          "tool_call_recorded 的 payload 不带 errorMessage（只有 status）⇒ 正文须回读台账行；对 denied/awaiting_approval 这类「插入即终态」的行，事件里不会有第二条 status_changed。",
      });
    } else {
      gaps.push({
        class: "event_lags_snapshot",
        seq: state.lastSeq,
        toolCallId: callId,
        field: "errorMessage",
        resolvedBy: "snapshot",
        detail:
          "台账行有 errorMessage，但事件说「无」⇒ 事件落后于行（旁路写入失败）。",
      });
    }
    stats.fromSnapshot += 1;
    return text;
  }
  if (!present) return null;
  stats.fromNone += 1;
  gaps.push({
    class: "missing_field",
    seq: state.lastSeq,
    toolCallId: callId,
    field: "errorMessage",
    resolvedBy: "none",
    detail: required
      ? "事件记了「有错误正文」但正文不在事件里，且未提供快照行 ⇒ 待审批/跳过的文案无法等价。"
      : "事件记了「有错误正文」但正文不在事件里，且未提供快照行 ⇒ 失败原因只能省略（快照侧会带上）。",
  });
  return `${GAP_MARK}错误正文缺失（事件只记 presence）`;
}

/** 事件状态 vs 台账行状态：事件写入是旁路，落后是**可能**的（必须能被对账看见）。 */
function crossCheckStatus(
  callId: string,
  state: CallState,
  row: SnapshotToolCall | undefined,
  gaps: ProjectionGap[],
): void {
  if (!row || row.rowStatus === undefined) return;
  if (row.rowStatus === state.status) return;
  gaps.push({
    class: "event_lags_snapshot",
    seq: state.lastSeq,
    toolCallId: callId,
    field: "status",
    resolvedBy: "event",
    detail: `事件说状态是 ${state.status}，台账行是 ${row.rowStatus} ⇒ 事件流缺了最后一次迁移（写入是旁路，失败只 warn）。投影按事件渲染，因此这里**必然**与快照不一致——这是对账该抓到的真差异。`,
  });
}

/** 事件里的 resultTruncated 与台账行不一致时留痕（同一事实的两个来源漂移）。 */
function crossCheckResultFlags(
  callId: string,
  state: CallState,
  row: SnapshotToolCall,
  gaps: ProjectionGap[],
): void {
  if (row.resultTruncated === undefined) return;
  if (row.resultTruncated === state.resultTruncated) return;
  gaps.push({
    class: "event_lags_snapshot",
    seq: state.lastSeq,
    toolCallId: callId,
    field: "resultTruncated",
    resolvedBy: "event",
    detail: `事件说 resultTruncated=${state.resultTruncated}，台账行是 ${row.resultTruncated}。`,
  });
}
