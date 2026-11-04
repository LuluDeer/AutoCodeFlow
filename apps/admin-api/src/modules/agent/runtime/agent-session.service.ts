import { Injectable, Logger, Optional } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import { In, LessThan, Not, Repository } from "typeorm";
// LANG-ERR-01（后端错误码化）：用户面抛出统一走 AppError（带稳定码，前端按
// 用户语言渲染）。AppError 按状态码挂到对应内置异常原型上，故既有按异常类
// 断言的 spec 不受影响。
import { AppError } from "../../../common/errors/app-error";
import {
  AgentSession,
  AgentSessionKind,
  AgentSessionStatus,
  AGENT_TERMINAL_STATUSES,
  type AgentBudget,
  type AgentContextFoldLedgerEntry,
} from "../entities/agent-session.entity";
import { AgentStep, type AgentStepRole } from "../entities/agent-step.entity";
import {
  AgentToolCall,
  type AgentToolCallStatus,
  type AgentToolTier,
} from "../entities/agent-tool-call.entity";
import {
  toAgentEventBody,
  type AgentEventBody,
  type AgentEventInput,
  type AgentEventKind,
} from "../entities/agent-event.entity";
// S7-G1 第五阶段：事件正文必须脱敏。用**共享实现**（本轮刚从 tool-executor 抽出的
// `agent-sanitize.util`），不在这里写第二套正则——安全控制上的复制等于下一次漂移，
// 详见该文件头注与 `agent-event.entity.ts` 的 payload 头注。
import { sanitizeResult, sanitizeString } from "../tools/agent-sanitize.util";
// 主表脱敏用**共享实现本体**（不带 maxLength）——见 redactForStorage 的注释。
import { sanitizeSecrets } from "../../../common/utils/sanitize-secrets.util";
import { AgentBudgetService } from "./agent-budget.service";
// OBS3-02：工具指标 label 的有界化（未知名字 → "unknown"）
import { AGENT_TOOL_BY_NAME } from "../tools/tool-registry";
import { AgentNotifyService } from "./agent-notify.service";
import {
  AGENT_APPROVAL_TTL_MS,
  AgentApprovalsService,
} from "./agent-approvals.service";
import { recordRuntime } from "../../metrics/runtime-metrics-entry";
import { LeaderGateService } from "../../../common/leader-gate/leader-gate.service";
// R9：23505 按约束名归因（四态语义见 util 头注）。
import {
  AGENT_UNIQUE_CONSTRAINTS,
  isOwnUniqueViolation,
} from "./agent-unique-violation.util";
/** 本文件的短别名（仅为了让调用点落在 print width 内）。 */
const EVENT_SEQ_UQ = AGENT_UNIQUE_CONSTRAINTS.eventSeq;

/**
 * P2：会话生命周期与持久化。
 *
 * 本服务是推理循环的**唯一持久化入口**——AgentRuntimeService 不直接碰
 * repository。这样做的理由：steps 的 seq 分配必须原子（唯一约束），
 * 且「每步写完后同步累加会话用量」两者若分散在两个服务里，很容易出现
 * 用量与 steps 不一致（用量少了 → 预算闸门失效 → 会话跑飞）。
 * 收敛到一处，累加与写入在同一方法内，不会漂移。
 */

/**
 * B-4：token 计数收敛——上游（AI provider）返回的 usage 可能是字符串或
 * 畸形值，进 SQL 表达式前必须收敛为有限正数，否则 `"totalTokensIn" + ${raw}`
 * 是一个可注入面（raw = "1; DROP TABLE agent_sessions--"）。
 * 非有限/非正数一律按 0 记。
 */
export function safeTokenCount(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 陈旧 running 判死阈值（GAP-2）：30 分钟无任何落库步进即视为持有者已死。
 * 心跳 = updatedAt（appendStep/recordToolCall/markRunning 都刷新它），
 * 最长合法静默窗口 ≈ 单轮重试 8s×3 + 工具批 10×60s ≈ 11 分钟，取 30 分钟
 * 留足裕量（对齐 detectStuckDeployments 的 DEPLOYING 口径）。
 */
export const STALE_RUNNING_TIMEOUT_MS = 30 * 60_000;

/**
 * S2-A2：折叠账本的**有界**条数（每会话只留最近 N 条）。
 *
 * 为什么必须有界：账本挂在 `agent_sessions.contextFoldLedger`（jsonb）上——见
 * 实体列注释「不建新表的理由」。会话行永不删除（留存策略只清 steps /
 * tool_calls / approvals），所以**唯一**能防它无界增长的地方就是写入侧。
 * 100 ≈ 出厂 `maxSteps`（40）的 2.5 倍：够覆盖「一次会话 + 两次人工 resume」
 * 的完整折叠史，又不让单行体积失控（每条 ~300B ⇒ 上限 ~30KB）。
 */
export const AGENT_CONTEXT_FOLD_LEDGER_MAX = 100;

/**
 * PK-19 续：waiting_input 会话的**总**等待上限（30 天）。
 *
 * 审批单已有 7 天 TTL；但 waiting_input 还包含「等待澄清」等人工输入面——
 * 它们没有 TTL 时同样会永久挂着。30 天是「这条会话已经没人管了」的保守线：
 * 到期收敛为 failed 并写明原因（用户可重新发起），而不是永远占着列表。
 */
export const STALE_WAITING_INPUT_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;

/** 陈旧 running 收敛时的 errorMessage（如实指明发生了什么 + 恢复路径）。 */
export const STALE_RUNNING_MESSAGE =
  "会话执行中断（admin-api 进程重启/崩溃，超过 30 分钟无任何步进）——" +
  "会话数据完好，可在排查后经 resume 重建上下文继续";

/**
 * appendStep 的 seq 冲突重试上限（含首次）。
 *
 * 3 次足够：并发窗口来自「清扫+恢复」这类一次性交错，重算 MAX(seq) 后第二次
 * 基本必成；无限重试会在真正的死锁/约束错误上变成挂起。
 */
const APPEND_STEP_MAX_RETRIES = 3;

/**
 * C2：拒绝向「已终态（或已不存在）」的会话追加步骤。
 *
 * 为什么抛而不是静默返回：调用方（AgentRuntimeService.run）拿到「追加成功」
 * 就会继续推进推理循环——在一个已经 succeeded / failed / aborted /
 * budget_exceeded 的会话上继续产生步骤与副作用，会出现「状态说结束了、库里
 * 还在长」的自相矛盾。抛出让它按未预期异常收敛；即便走到了 finish，finish
 * 是**非终态**条件写，输给已终态者只打一条 debug，不会改写既有终态结论。
 *
 * 用类型而不是错误文案做判据：调用方不应靠字符串匹配判断「是不是终态拒绝」。
 */
export class AppendStepRejectedError extends Error {
  constructor(
    readonly sessionId: string,
    /** 会话当前状态；`null` = 会话行已不存在（被清理），与「终态」同判。 */
    readonly status: AgentSessionStatus | null,
  ) {
    super(
      status
        ? `session ${sessionId} is terminal (${status}) — refusing to append step`
        : `session ${sessionId} not found — refusing to append step`,
    );
    this.name = "AppendStepRejectedError";
  }
}

/** 创建会话的输入。 */
export interface CreateSessionInput {
  kind: AgentSessionKind;
  triggerSource: string;
  title?: string;
  parentSessionId?: string | null;
  context?: Record<string, unknown> | null;
  scope?: Record<string, unknown> | null;
  /** 不传则用 resolveBudget() 的默认/配置值。 */
  budget?: AgentBudget;
  /** G4 发起人（`user:<username>` / `system:<cron|event>`；缺省 NULL=未知）。 */
  createdBy?: string | null;
}

/** 追加一步的输入。 */
export interface AppendStepInput {
  role: AgentStepRole;
  content?: string | null;
  reasoning?: string | null;
  toolCallsJson?: unknown[] | null;
  toolCallId?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  latencyMs?: number;
  provider?: string | null;
  model?: string | null;
  summary?: string | null;
}

/**
 * S7-G1：单次 append 的事件条数上限（超限**整批拒**，见 `appendEvents`）。
 *
 * 为什么要有上限：一次 append 是一条 SQL（一个事务），批量越大，语句的持锁时间
 * 与「插入撞唯一约束后整批重试」的成本越高。32 远大于任何真实写入点（本阶段的
 * 写入点每次 1 条；将来「批处理一批工具结果」也是个位数），所以它只在**误用**
 * （有人把 N 轮事件攒起来一次灌）时触发——那种用法该在调用侧拆批，而不是让一条
 * 语句变成长事务。超限直接抛、一行都不写：这就是 Temporal 的「超事务上限直接拒，
 * 不许部分写入」（`temporal-main.md` §M1 第 4 条）。
 */
export const AGENT_EVENT_BATCH_MAX = 32;

/**
 * S7-G1 第五阶段：单次 append 的**字节**上限（256 KiB），超限同样**整批拒**。
 *
 * 为什么条数上限不够：`AGENT_EVENT_BATCH_MAX` 只管「几条」，不管「多大」。正文进
 * payload 之后（每条正文另有 `AGENT_EVENT_BODY_MAX_BYTES=2KiB` 的单条上限），
 * 32 条 × 2 KiB ≈ 64 KiB 是理论上限，但 JSON 转义（引号/换行/中文 `\uXXXX` 形态）
 * 能把它放大数倍；再叠加**误用**（有人把 N 轮事件攒起来一次灌）就会让一条 INSERT
 * 变成长期持锁的大事务——这正是 Temporal 用 `TransactionSizeLimit`
 * （`history_manager.go:369`）整批拒掉的那类形态。
 *
 * 判据是**真正要写进 jsonb 的那串文本**的字节数（`JSON.stringify(rows)`），不是
 * 字段估算：估算会漏掉转义，而转义恰恰是放大器。
 *
 * 256 KiB 的取法：≥ 32 条 × 2 KiB × 转义最坏倍数（约 2 倍）仍有余量，所以正常
 * 批量**不会**被这条拦住；它只在误用/异常载荷时触发。超限抛 `EventBatchRejectedError`
 * （与条数上限同一个类型），**一行都不写**——「要么全成要么全不成」。
 */
export const AGENT_EVENT_BATCH_MAX_BYTES = 256 * 1024;

/**
 * `appendEvents` 的唯一约束冲突重试上限（含首次）。
 *
 * 与 `APPEND_STEP_MAX_RETRIES` 同口径：并发窗口来自「人工 resume 撞上定时扫描」
 * 这类一次性交错，重算 `MAX(seq)` 后第二次基本必成；无限重试会把真正的死锁/约束
 * 错误变成挂起。
 */
const APPEND_EVENT_MAX_RETRIES = 3;

/**
 * S7-G1：批量超限（**拒绝，不是截断**）。
 *
 * 为什么用类型而不是错误文案做判据：调用方（旁路包装 `tryAppendEvent`）要区分
 * 「这一批天生不合规」与「DB 抖了」，前者是调用侧的 bug，值得一条显眼的 warn。
 */
export class EventBatchRejectedError extends Error {
  constructor(
    readonly sessionId: string,
    readonly count: number,
    /** 本批的 JSON 字节数（`JSON.stringify(rows)` 的 UTF-8 长度）。 */
    readonly bytes: number = 0,
  ) {
    super(
      bytes > AGENT_EVENT_BATCH_MAX_BYTES
        ? `agent_events batch rejected: ${bytes} bytes > ${AGENT_EVENT_BATCH_MAX_BYTES} (session=${sessionId}, ${count} event(s)) — 拆批后重试，整批未写入`
        : `agent_events batch rejected: ${count} > ${AGENT_EVENT_BATCH_MAX} (session=${sessionId}) — 拆批后重试，整批未写入`,
    );
    this.name = "EventBatchRejectedError";
  }
}

/**
 * S7-G1：同批 `seq` 不连续（**事务回滚**，整批不落）。
 *
 * 理论上不可能发生（单语句 `MAX(seq)+ord` 构造上连续）；保留它是为了让「不变量
 * ①同批连续」成为**被断言的**事实而不是**被相信的**事实：真出现跳号时宁可整批
 * 丢掉（事件日志不是主数据，缺一批远好过留下一段伪造的顺序）。
 */
export class EventSeqContiguityError extends Error {
  constructor(
    readonly sessionId: string,
    readonly seqs: number[],
  ) {
    super(
      `agent_events seq not contiguous: session=${sessionId} seqs=[${seqs.join(",")}] — 整批回滚`,
    );
    this.name = "EventSeqContiguityError";
  }
}

/**
 * S7-G1 第五阶段：**正文的脱敏**（**复用共享实现**，不写第二套规则）。
 *
 * ## 规则本体只有一份
 * 规则来自 `tools/agent-sanitize.util.ts` 的 `sanitizeString`（转发到全仓唯一的
 * `common/utils/sanitize-secrets.util.ts`）：S-10 口径 + 键名剥离 + S1-C3 小写凭据。
 * 事件正文、步正文、工具错误文案三处**共用同一个函数**——安全控制上的复制等于
 * 下一次漂移（通知面就丢过小写凭据规则，见 `sanitize-secrets.util.ts` 头注）。
 *
 * ## 为什么**主表**也要脱敏（而不只是事件表）
 * 事件表（`agent_events`）是 append-only 的**取证副本**；主表
 * （`agent_steps.content` / `agent_tool_calls.errorMessage`）是**被读回来再外发**的
 * 权威源——三处读面都直接把它带出去：
 *   ① **上下文重建**：`rebuildMessages` 把 `step.content` 与台账行的
 *      `errorMessage` 回灌给模型（`replayedToolResult`）⇒ 凭据会被**再次外发给
 *      LLM provider**。事件表里那份脱敏副本管不到这一跳；
 *   ② **会话导出 / 详情 API**：`GET /agent/sessions/:id/export` 与详情接口原样
 *      返回 steps / toolCalls ⇒ 事件表的脱敏副本同样救不了这一跳；
 *   ③ **投影快照回落**：事件正文缺失时（存量事件 / 旁路写失败）投影回读主表行
 *      来渲染 ⇒ 主表明文会出现在审计投影里。
 *
 * ## 保留期（为什么说主表的脱敏比事件表更关键）
 * 事件表默认 180 天；主表侧的保留期是**分档且不完整**的：终态会话的 steps
 * 90 天、read 档 tool_calls 30 天，而**非终态会话**的 steps 与 read 档
 * tool_calls 不在清理谓词内（谓词要求会话终态）⇒ 事实上**没有保留期**；
 * write/dangerous 档 180 天（与事件表同档，但读面更多、保留期不短于事件表）。
 * 结论：明文在主表里的**暴露窗口不短于**事件表，在无保留期的那部分（非终态会话）
 * 反而更长——主表恰恰是「明文留存」的那一面。
 *
 * **而会话行（`agent_sessions`）比步骤行更极端：行永不删除。** 保留期只清
 * `agent_steps` / `agent_tool_calls` / `agent_approvals` / `agent_events`
 * （见 `agent-session-retention.service.ts`，谓词里 `agent_sessions` 只作为
 * 存在性判断出现）⇒ 会话行的正文一旦明文写入就是**永久留存**，没有任何窗口
 * 会把它清掉。它还有两条额外的外发读面：`summary` / `errorMessage` 进通知正文
 * （`AgentNotifyService.sessionFinished`，出口层有 `sanitizeNotificationText`
 * 兜底，但**库里的原文没有**）、`resultJson.conclusion` 被执行详情/导出 API
 * 原样返回。
 *
 * ## 两列同名 `resultJson`，纪律**不同**
 *   · `agent_tool_calls.resultJson`（工具结果）：上游 `ToolExecutorService` 已过
 *     `sanitizeResult`，本层**不再**脱敏——幂等但浪费，且结构脱敏跑第二遍会把
 *     成品（`AUTOFLOW_TOKEN=[REDACTED]`）再打一次码。
 *   · `agent_sessions.resultJson`（模型最终结论 `{ conclusion }`）：上游**零脱敏**，
 *     因此在 `finish()` 写入点用 `redactSessionResultForStorage` 打码。
 */
export function redactEventBodyText(raw: string): string {
  return sanitizeString(raw);
}

/**
 * 主表正文的脱敏（`agent_steps.content` / `agent_tool_calls.errorMessage`）：
 * **只打码、不截断**。
 *
 * 为什么不直接用 `redactEventBodyText`：`sanitizeString` 自带 `maxLength: 4000`
 * （`agent-sanitize.util.ts:85`），那是为**事件表**设计的——事件 payload 是
 * 有界审计面，单条必须封顶。但主表的 `content` / `errorMessage` 是
 * **无界 text 列**，套上 4000 上限的直接后果是
 * **>4000 字的模型回复在库里丢掉尾部** = 用丢数据换安全。
 *
 * 脱敏的目标是「打码凭据」，不是「砍掉正文」⇒ 这里显式**不传 `maxLength`**，
 * 规则集与事件表**完全同一份**（`sanitizeSecrets` 的唯一实现），只是不设长度上限。
 *
 * ⚠ 别把它改回 `redactEventBodyText`：那会把两件本来独立的事（打码 / 封顶）
 *   绑在一起，而主表根本不需要封顶。
 */
export function redactForStorage(raw: string): string {
  return sanitizeSecrets(raw);
}

/**
 * 会话行纯文本字段（`summary` / `errorMessage`）的写入点脱敏。
 *
 * 空值语义原样保持（`null` / `undefined` → `null`）：`finish()` 允许三个字段
 * 全部缺省（缺省时不覆盖既有值），「没有值」不能被脱敏函数改写成空串——那会
 * 让「没写」与「写了空」在库里同形。
 *
 * 为什么不把 `x == null ? null : redactForStorage(x)` 就地铺在四个写入点上：
 * `scripts/check-agent-write-sanitize.mjs` 要求**每个写入点的值表达式里看得见
 * 脱敏调用**；本函数以 `redact` 命名，所以调用点仍是调用点，判据不用为此放宽。
 */
export function redactNullableText(
  raw: string | null | undefined,
): string | null {
  return raw == null ? null : redactForStorage(raw);
}

/**
 * 会话结论（`agent_sessions.resultJson`）的写入点脱敏：
 * **只对 `conclusion` 这一个字符串打码**，不引入结构脱敏。
 *
 * 为什么不做结构脱敏（`sanitizeResult` 那种「键名命中 SECRET_KEYS_RE 就整键
 * 替换」）：本列写入点的结构是固定的 `{ conclusion }`，键名 `conclusion`
 * 不含任何凭据词，键名规则在这里只可能是空转；而结构脱敏还会顺手改写调用方
 * 塞进来的其它键（`resourceId` 之类），把「本层只负责正文」的边界搞糊。
 * 正文只有一个字符串 ⇒ 就打这一个，范围最小、可断言。
 *
 * 与 `agent_tool_calls.resultJson` 的区别（两列同名，纪律不同）：
 * 那边是**工具结果**，上游 `ToolExecutorService` 已过 `sanitizeResult`，本层
 * 故意不重复脱敏（幂等但浪费，且结构脱敏跑第二遍会把成品再打一次码）；
 * 这边是**模型最终结论正文**，上游没有任何脱敏——`redactForStorage` 之前
 * 是原样入库（见 `agent_sessions`「行永不删除」的保留期事实）。
 *
 * 非字符串的 `conclusion`（模型/调用方给了对象）原样透传：这不是脱敏能决定的
 * 形状问题，改成 `String(...)` 会把结构化结论压成 `[object Object]`。
 */
export function redactSessionResultForStorage(
  raw: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (raw == null) return null;
  const conclusion = raw.conclusion;
  if (typeof conclusion !== "string") return raw;
  return { ...raw, conclusion: redactForStorage(conclusion) };
}

/**
 * 会话上下文（`agent_sessions.contextJson`）的写入点脱敏：**结构脱敏**，只打码
 * 不截断。
 *
 * 为什么用 `sanitizeResult`（结构脱敏）而不是 `redactForStorage`（纯文本规则）：
 * 上下文是**结构化 jsonb**（`{ question, applicationId, scope… }`），凭据通常以
 * **键名**出现（`token` / `password` / `credential`），文本规则只认 `key: value`
 * 的**排版**，一旦值被别处序列化过（或键名形态少见）就漏。结构脱敏按 SECRET_KEYS_RE
 * 整键替换，与 `buildEventBody` 写进 `payload.body.context` 的掩码**逐字一致**——
 * 两侧同规则，投影（读事件）与 `rebuildMessages`（读会话行）渲染出的上下文才可能
 * 相等。
 *
 * 为什么不截断：本列是**主数据**（无界 jsonb），截断会静默丢用户数据；有界性由
 * 事件侧（`buildEventBody` 的 2 KiB + `truncated` 标记）负责，那边截了看得出来。
 *
 * 空值语义原样保持：`null`/`undefined` → `null`（「没有上下文」不能被脱敏改写成
 * `{}`，否则投影与快照就分不清「没有」与「空对象」）。
 */
export function redactContextForStorage(
  raw: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (raw == null) return null;
  return sanitizeResult(raw) as Record<string, unknown>;
}

/**
 * 把一个「字符串 / 对象 / 空」的正文值包成事件正文信封（`payload.body.<slot>`）。
 *
 * 两种输入形态的来源不同，处理顺序也**必须**不同：
 *   · **字符串**（步 `content`、`errorMessage`）：就是自由文本，直接过文本规则
 *     （`redactEventBodyText`）。这里 `KEY=value` 形态是真实存在的（日志行、
 *     curl 命令），文本规则正是为它准备的。
 *   · **对象**（台账 `resultJson`）：**先按结构脱敏再序列化**（`sanitizeResult`：
 *     键名命中 `SECRET_KEYS_RE` 的整键替换 + 逐字符串走文本规则），**不能**反过来。
 *     实测反过来的后果：`{"env":"AUTOFLOW_TOKEN=abc123","password":"hunter2"}` 这种
 *     **紧凑 JSON 没有空白**，`([A-Z_]{3,}\s*=\s*)[^\s\n]+` 的 `[^\s\n]+` 会一路
 *     吃到整串结尾，正文被吞成 `{"env":"AUTOFLOW_TOKEN=[REDACTED]`——键名规则再也
 *     没有机会命中 `password`，而且事件里的正文凭空少了半截。
 *     结构化脱敏后**不再**跑第二遍文本规则：同一段 JSON 里若含 `AUTOFLOW_TOKEN=[REDACTED]`
 *     这样的成品，第二遍又会被贪婪匹配吞掉一次。
 *
 * 返回 null 的两种情况都要**如实**：没有值、空串。无法序列化的值（BigInt/函数）
 * 用可断言的占位 `[UNSERIALIZABLE]`——「没有正文」与「正文写不进去」不能靠 null
 * 混为一谈；「正文太大被截」另有 `truncated`。
 */
export function buildEventBody(value: unknown): AgentEventBody | null {
  if (value === null || value === undefined) return null;

  if (typeof value === "string") {
    if (value.length === 0) return null;
    return toAgentEventBody(redactEventBodyText(value), value);
  }

  // 原文与脱敏后的副本各序列化一次：前者只用于 `originalBytes`（「原文多长」是
  // 事实，不该被脱敏的增删改写），后者才是落库正文。
  let rawJson: string;
  try {
    rawJson = JSON.stringify(value);
  } catch {
    return toAgentEventBody("[UNSERIALIZABLE]");
  }
  if (rawJson === undefined) return null;

  let sanitizedJson: string;
  try {
    sanitizedJson = JSON.stringify(sanitizeResult(value));
  } catch {
    sanitizedJson = "[UNSERIALIZABLE]";
  }
  if (sanitizedJson === undefined) sanitizedJson = "[UNSERIALIZABLE]";
  return toAgentEventBody(sanitizedJson, rawJson);
}

/** 记录一次工具调用的输入。 */
export interface RecordToolCallInput {
  sessionId: string;
  stepId?: string | null;
  /** 模型给的 tool_call id（重放时唯一的关联键，见实体注释）。 */
  toolCallId?: string | null;
  toolName: string;
  tier: AgentToolTier;
  args?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  resultTruncated?: boolean;
  status: AgentToolCallStatus;
  errorMessage?: string | null;
  approvalId?: string | null;
  durationMs?: number;
  /**
   * 本行 status 变更时刻（迁移 083 / C2）。缺省由写入口按 now() 置位——
   * 工具执行器在副作用窗口的开合点（in_flight / timeout / ok / error）显式
   * 传入，其余路径（denied / awaiting_approval 等）走兜底，保证「写了 status
   * 却没有时间戳」不可能发生。
   */
  stateChangedAt?: Date;
}

/**
 * `appendStep` 的返回值：`agent_steps` 那一行 **+ 该步 `step_appended` 事件的 seq**。
 *
 * ## 为什么要把事件的 seq 一起带出来（A2）
 *
 * `prompt_fingerprint` 的因果规则是「指向上游那条 `step_appended`」。而这个 seq
 * **只有在写事件的那一刻**才存在（由 `appendEvents` 的 `RETURNING "seq"` 分配）。
 * 如果不在这一跳把它转交出去，下游要拿到它就只有两条路，两条都不可接受：
 *   · 回表按「本会话最近一条 `step_appended`」取 —— 那是**时间邻近推断**，
 *     会话并发推进（人工 resume 撞上定时扫描）时会指错步，而错边在数据层不可见；
 *   · 干脆不写（NULL）—— 读侧只能退回启发式，本列的取证价值就落空。
 * 所以事实在它诞生的地方被转交：`tryAppendEvent` 返回 seq（失败返回 null），
 * 这里原样带出，`null` 就如实是 `null`（绝不写 0 或 `undefined`）。
 *
 * 兼容性：它是 `AgentStep` 的**超集**（交叉类型），既有调用方按 `AgentStep` 使用
 * 不受影响——`eventSeq` 是运行时附加的非列属性，不会被持久化。
 */
export type AppendedStep = AgentStep & {
  /** 该步 `step_appended` 事件的 `seq`；`null` = 事件写入失败（旁路，step 已提交）。 */
  readonly eventSeq: number | null;
};

@Injectable()
export class AgentSessionService {
  private readonly logger = new Logger(AgentSessionService.name);

  constructor(
    @InjectRepository(AgentSession)
    private readonly sessions: Repository<AgentSession>,
    @InjectRepository(AgentStep)
    private readonly steps: Repository<AgentStep>,
    @InjectRepository(AgentToolCall)
    private readonly toolCalls: Repository<AgentToolCall>,
    private readonly budgetService: AgentBudgetService,
    private readonly notify: AgentNotifyService,
    // ARCH-31 §5: 多实例下 cron 维护任务仅 Leader 执行（@Optional——既有
    // 单测直接 new 装配时 gate 缺席 → null → 门禁不生效，先例同 retention）。
    @Optional()
    private readonly leaderGate: LeaderGateService | null = null,
    // PK-19：审批单 TTL 收口（@Optional——既有单测直接 new 装配时缺席，
    // 缺席即跳过超时扫描，不影响其它行为）。
    @Optional()
    private readonly approvals: AgentApprovalsService | null = null,
  ) {
    // S7-G1（第四阶段）：把「写事件」的能力反向注册给审批服务。
    //
    // 为什么是反向注册（而不是 approvals 构造器注入本服务）：依赖方向必须是
    // 单向的——本服务已经 @Optional 依赖 approvals（TTL 扫描），反向注入成环，
    // 只能靠 forwardRef 拆，且 approvals 的单测就得编造一个半边 session 服务。
    // 这里注册的是**最窄端口**（`tryAppendEvent` 一个方法），approvals 因此
    // 不认识本类；`seq` 的原子分配也保持「只有 appendEvents 一份实现」。
    //
    // `?.`/`?.()`：既有单测给 approvals 塞的是只有 `hasPendingForSession` /
    // `expireStalePending` 的替身，没有这个方法——缺席即不接端口（与
    // @Optional 同款的 fail-safe：事件是旁路，缺它不改变主链）。
    //
    // A2（因果）：端口在这里**多包一层**——`approval_decided` 的因果边
    // （「这张单是为哪次调用开的」）需要跨表解引用（`approvalKey` →
    // `agent_tool_calls.approvalId` → `toolCallId` → 事件 seq），而审批服务只认
    // 端口、不认识会话与台账。把它补在**拥有事件表的那一侧**，既保持单向依赖，
    // 又让「谁写的事件谁负责因果」这条纪律只有一处实现
    // （见 `enrichApprovalDecidedCausation`）。
    this.approvals?.attachEventSink?.({
      tryAppendEvent: async (sessionId, event) =>
        this.tryAppendEvent(
          sessionId,
          await this.enrichApprovalDecidedCausation(sessionId, event),
        ),
    });
  }

  /**
   * cron 入口（每 10 分钟）：Leader 门禁 + sweepStaleRunning。
   * 与 AgentSessionRetentionService.handleDailyCleanup / detectStuckDeployments
   * 同一门禁纪律——多副本下只有 Leader 做维护扫描。
   */
  @Cron("0 */10 * * * *")
  async handleStaleRunningSweep(): Promise<void> {
    if (this.leaderGate && !this.leaderGate.isLeader) return;
    try {
      await this.sweepStaleRunning();
    } catch (err) {
      this.logger.error(
        `Agent stale-running sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── 创建与查询 ──────────────────────────────────────────────────

  async create(input: CreateSessionInput): Promise<AgentSession> {
    const session = this.sessions.create({
      kind: input.kind,
      status: "pending",
      title: input.title ?? null,
      triggerSource: input.triggerSource,
      createdBy: input.createdBy ?? null,
      parentSessionId: input.parentSessionId ?? null,
      // 上下文脱敏（第七阶段）：`contextJson` 是**用户提供的数据**，而
      // `rebuildMessages` 把它原样拼进首条 system 消息（`JSON.stringify(…,2)` 截
      // 16 KiB）⇒ 它会被**再次外发给 LLM provider**；本列还随会话行**永不删除**。
      // 规则见 `redactContextForStorage`（结构脱敏 `sanitizeResult`），与写进
      // `payload.body.context` 的是**同一份掩码**，因此事件侧与快照侧渲染出的是
      // 同一段文本——否则投影切上读路径的那一天，模型看到的上下文会静默地从明文
      // 变成 `[REDACTED]`。
      contextJson: redactContextForStorage(input.context),
      // 作用域缺省为空对象而非 null：闸门统一按「有 scope 且为空 = 不可操作
      // 任何资源」处理，比 null（表示"未指定，按不限处理"）更安全。
      scopeJson: input.scope ?? {},
      budgetJson: input.budget ?? this.budgetService.resolveBudget(),
      totalSteps: 0,
      totalTokensIn: 0,
      totalTokensOut: 0,
      totalToolCalls: 0,
    });
    const saved = await this.sessions.save(session);
    this.logger.log(
      `Agent session created: id=${saved.id} kind=${saved.kind} trigger=${saved.triggerSource}`,
    );
    // S7-G1 第七阶段：把「会话创建时喂进去的上下文」落成一条事件。
    //
    // 为什么必须有一条事件而不是让投影回读会话行：首条 system 消息 = SYSTEM_PROMPT
    // + `contextJson`（16 KiB 截断），它同样是 `rebuildMessages` 的**输入**。会话行
    // 只有「当前值」，事件流要能自足地重建那次重建的输入，就得有「创建那一刻的
    // 上下文」这个时间点。`hasContext` 把「创建时确实没有上下文」与「存量会话没有
    // 这类事件」分开——两者对输入等价，对取证不等价。
    //
    // 旁路纪律（同 `appendStep`）：`tryAppendEvent` 永不抛出，事件写失败只丢这一条
    // 取证事件，不影响会话创建；位置在**会话行提交之后**，因为事件的 `sessionId`
    // 外键指向它。
    await this.tryAppendEvent(saved.id, {
      kind: "session_context_recorded",
      // 因果：会话创建先于本会话的一切事件，没有单一前驱 ⇒ 显式 NULL（见
      // `AGENT_EVENT_CAUSATION_RULES.session_context_recorded.ifViolated`）。
      causedBySeq: null,
      payload: {
        // 「有没有上下文」是**事实**，与正文分开记：`body.context` 为 null 时，
        // 这一位才答得出「是明确没有」还是「正文被截/丢了」。
        hasContext: input.context != null,
        body: { context: buildEventBody(input.context) },
      },
    });
    return saved;
  }

  async findById(id: string): Promise<AgentSession | null> {
    return this.sessions.findOne({ where: { id } });
  }

  async requireById(id: string): Promise<AgentSession> {
    const s = await this.findById(id);
    if (!s)
      throw new AppError("AGENT_SESSION_NOT_FOUND", {
        sessionId: id,
      });
    return s;
  }

  async list(options: {
    kind?: AgentSessionKind;
    status?: AgentSessionStatus;
    page?: number;
    pageSize?: number;
  }): Promise<{ items: AgentSession[]; total: number }> {
    // NaN 守卫（R3 后端遗留）：HTTP 层 parseInt("abc")=NaN 会穿透下面的
    // Math.max/Math.min 钳制（Math.max(1, NaN)=NaN），NaN 直达 skip/take
    // 炸 500。与前端深链非法值回落默认的既有口径（R2-C URL-SYNC-01）对齐：
    // 非有限数（NaN/±Infinity）一律视同未传、回落 1/20，而不是 400——
    // 400 会改变「非法深链安全回落」契约。钳制本身维持原状（page≥1、
    // pageSize∈[1,100]）。
    // F-54（UIAUDIT 后端轮 P3-1）：page 补上限 10000——对齐 NETOPT-3④ 的
    // PageQueryDto 口径（与 events 先例 2ea869fc 一致）：无封顶的 page 生成
    // 深 OFFSET + getManyAndCount 全量 COUNT，可钉满连接池（ADMIN-only 小表，
    // 风险低，属标准统一而非堵洞）。仍在 clamp 内做（不引 DTO）以保持本端点
    // 「非法值安全回落、绝不 400」的契约——语义是「超限视同翻到最深一页内的
    // 最后一屏」而非报错。
    const rawPage = options.page;
    const rawPageSize = options.pageSize;
    const page = Math.min(
      10000,
      Math.max(
        1,
        typeof rawPage === "number" && Number.isFinite(rawPage) ? rawPage : 1,
      ),
    );
    const pageSize = Math.min(
      100,
      Math.max(
        1,
        typeof rawPageSize === "number" && Number.isFinite(rawPageSize)
          ? rawPageSize
          : 20,
      ),
    );

    const qb = this.sessions.createQueryBuilder("s");
    if (options.kind) qb.andWhere("s.kind = :kind", { kind: options.kind });
    if (options.status)
      qb.andWhere("s.status = :status", { status: options.status });
    qb.orderBy("s.createdAt", "DESC")
      .skip((page - 1) * pageSize)
      .take(pageSize);

    const [items, total] = await qb.getManyAndCount();
    return { items, total };
  }

  /** 子会话（P6 澄清链）。 */
  async findChildren(parentSessionId: string): Promise<AgentSession[]> {
    return this.sessions.find({
      where: { parentSessionId },
      order: { createdAt: "ASC" },
    });
  }

  /** 会话的全部步骤（按 seq 升序）——重建 messages 的唯一数据源。 */
  /**
   * 批量取会话状态（第 6 轮审计 P2：SOP 澄清兜底扫描的 2×N 点查收敛）。
   * 只投影 id/status——调用方只需要状态，别把 contextJson/resultJson 搬出来。
   */
  async findStatusByIds(
    ids: readonly string[],
  ): Promise<Array<{ id: string; status: string }>> {
    if (ids.length === 0) return [];
    return this.sessions.find({
      where: { id: In([...ids]) },
      select: { id: true, status: true },
    });
  }

  async listSteps(sessionId: string): Promise<AgentStep[]> {
    return this.steps.find({
      where: { sessionId },
      order: { seq: "ASC" },
    });
  }

  /**
   * 按 (sessionId, toolCallId) 取单行（第 6 轮审计 P1：在途台账/幂等判定的读面）。
   * 投影只取判定所需字段，避免把 resultJson 大字段搬进执行热路径。
   */
  async findToolCall(
    sessionId: string,
    toolCallId: string,
  ): Promise<Pick<
    AgentToolCall,
    "status" | "toolName" | "resultJson" | "resultTruncated" | "errorMessage"
  > | null> {
    if (!toolCallId) return null;
    return this.toolCalls.findOne({
      where: { sessionId, toolCallId },
      select: {
        status: true,
        toolName: true,
        resultJson: true,
        resultTruncated: true,
        errorMessage: true,
      },
    });
  }

  async listToolCalls(sessionId: string): Promise<AgentToolCall[]> {
    return this.toolCalls.find({
      where: { sessionId },
      order: { createdAt: "ASC" },
    });
  }

  /**
   * 按审批单键回写工具调用行的终态（实施轮 #14）。
   *
   * 为什么需要：审批单被 deny 之后，`agent_tool_calls` 里那一行会永远停在
   * `awaiting_approval`——台账因此无法区分「没人处理」与「明确被拒」，
   * 会话详情页也一直显示挂起。条件写钉住 `awaiting_approval`：只改还没走完
   * 的那一行，已执行/已拒绝的行不被二次覆盖。
   *
   * @returns 受影响行数（0 = 没有处于该状态的调用行，不是错误）
   */
  async settleToolCallByApprovalId(
    approvalId: string,
    status: Extract<AgentToolCallStatus, "denied" | "error">,
    errorMessage: string,
  ): Promise<number> {
    // 2026-11-02（只读审计的 ③(b)）：这里**补写 `stateChangedAt`**。
    //
    // 为什么该补：本列的定义逐字是「本行 `status` **最后一次变更**的时刻」
    // （`agent-tool-call.entity.ts:148-149`）。人工拒绝**确实**改了 `status`
    // （`awaiting_approval` → `denied`/`error`）⇒ 按定义就该更新；
    // 不写它会让该行的本列停在「审批挂起」那一刻，与列语义相反。
    //
    // 为什么现在才补（历史）：审计出的原状是「三个写入口里前两个置位、第三个不置位」，
    // 当时用**改文案**（而不是改代码）记录了这个不一致。后来核实：
    // `stateChangedAt` **全仓无任何逻辑消费方**（只有 DTO 暴露 + admin-web 的生成类型），
    // 行为风险≈0 ⇒ 补一行让列与定义一致，比留一条「读侧按这个口径理解」的例外更干净。
    //
    // 时刻来源：本方法**执行**的时刻（与另两个写入口的 `now()` 兜底同一口径）。
    // 不是「审批单被决策的时刻」——那属于 `agent_approvals.decidedAt`，两列各说各的行。
    const res = await this.toolCalls.update(
      { approvalId, status: "awaiting_approval" },
      {
        status,
        // 写入点脱敏（与另两个 errorMessage 写入点**同一口径**）：拒绝文案里通常
        // 嵌着审批单 key 与调用参数片段，那些东西**可能**含凭据样式串。
        errorMessage: redactForStorage(errorMessage),
        stateChangedAt: new Date(),
      },
    );
    return res.affected ?? 0;
  }

  // ── 状态迁移 ────────────────────────────────────────────────────

  /**
   * 标记会话开始运行。
   * startedAt 只在第一次置位（resume 不重置）——否则墙钟预算会被反复续命，
   * 「单会话 30 分钟上限」形同虚设。
   *
   * @returns CAS 是否赢得执行凭据（affected > 0）。**调用方必须消费它**：
   * 输掉 CAS = 会话已被另一个 worker 置 running（重复 resume 入队 / 定时
   * 扫描撞上在跑会话）或已收敛终态——输家不得进入推理循环（GAP-1：此前
   * affected 被丢弃，输家照跑，B-8 声称的双跑守卫实际不成立）。
   */
  async markRunning(id: string, expectWaitingFor?: string): Promise<boolean> {
    // B-8：CAS 双保险——只有「非 running 且未终态」的会话能被置 running。
    // ① 双 worker 领到同一会话（重复入队的残余窗口）时只有一方真正置态；
    // ② 防住把终态会话拉回 running 的状态机倒退。
    //
    // RT-3：`expectWaitingFor` 是**唤醒凭据**。delayed job 在 60s 后才执行，
    // 期间会话可能已被人工 resume 并走到「等审批」；不带凭据的唤醒会把
    // waiting_input(审批) 无条件翻成 running，审批门在模型眼里退化成拒绝。
    // 用 `IS NOT DISTINCT FROM` 而不是 `=`：既允许 NULL 语义（存量/手工
    // 路径显式传 undefined 时不加这段谓词），也让 SQL 三值逻辑不误挡。
    const qb = this.sessions
      .createQueryBuilder()
      .update(AgentSession)
      .set({
        status: "running",
        waitingFor: null,
        ...((await this.shouldSetStartedAt(id))
          ? { startedAt: new Date() }
          : {}),
      })
      .where(
        "id = :id AND status <> 'running' AND status NOT IN (:...terminal)",
        {
          id,
          terminal: AGENT_TERMINAL_STATUSES,
        },
      );
    if (expectWaitingFor !== undefined) {
      qb.andWhere('"waitingFor" IS NOT DISTINCT FROM :expect', {
        expect: expectWaitingFor,
      });
    }
    const res = await qb.execute();
    return (res.affected ?? 0) > 0;
  }

  /**
   * 本次启动是否要写 startedAt（= 是否给一个新的墙钟窗口）。
   *
   * 两条触发条件：
   *  ① 从来没有 startedAt（首跑）；
   *  ② **从 waiting_input 恢复**（审批 / 澄清 / 自动续跑）——等待期间人
   *     和外部系统花的时间不该记在 Agent 的工作预算里。此前只在首跑置位，
   *     于是「30 分钟墙钟 + 30 分钟才批准」的审批必然在恢复后第一轮就被
   *     `budget_exceeded` 判死：模型一次没被调用、审批单永久 granted 未消费、
   *     controller 又拒绝恢复 budget_exceeded ⇒ 死局（数据审计 #1）。
   *
   * 为什么不会变成「无限续命」：每次恢复都需要**外部事件**（人工审批、
   * 执行器答复、一次性的自动续跑额度），不是循环自激；成本闸门（steps /
   * tokens / toolCalls）始终按会话累计，不因恢复清零。
   */
  private async shouldSetStartedAt(id: string): Promise<boolean> {
    const s = await this.sessions.findOne({
      where: { id },
      select: { id: true, startedAt: true, status: true },
    });
    if (!s?.startedAt) return true;
    return s.status === "waiting_input";
  }

  /**
   * GAP-3：领取「本会话的自动续跑额度」。
   *
   * 语义 = 「每会话最多自动补跑一次」。用**条件写**而不是「先读后判」：
   * 多个 admin-api 副本可能同时判定同一次 LLM 耗尽（各自的重试循环独立），
   * 读时判断会让每个副本都排一个 delayed job —— provider 抖动就被放大成
   * 重试风暴。`autoResumeCount < max` 保证只有一个赢家，与 GAP-1 的
   * markRunning、ADR-026 的条件写是同一条纪律。
   *
   * 谓词里带「非终态」：若此刻会话已被别的路径收敛（人工 abort、预算触顶），
   * 续跑已经没有意义——命中 0 行即放弃，调用方按普通 failed 收敛。
   *
   * @returns 是否赢得本次自动续跑资格（affected > 0）。
   */
  async claimAutoResume(id: string, max = 1): Promise<boolean> {
    const limit = Number.isInteger(max) && max > 0 ? max : 1;
    const res = await this.sessions
      .createQueryBuilder()
      .update(AgentSession)
      .set({ autoResumeCount: () => `"autoResumeCount" + 1` })
      .where(
        `id = :id AND "autoResumeCount" < :limit AND status NOT IN (:...terminal)`,
        { id, limit, terminal: [...AGENT_TERMINAL_STATUSES] },
      )
      .execute();
    return (res.affected ?? 0) > 0;
  }

  /**
   * S2-A2（R5/R18）：落**折叠派生账本**并推进/清零「连续不收敛」计数。
   *
   * 写入点由 `AgentRuntimeService` 在每轮 `planContextWindow` 之后调用一次：
   *   · 本轮超窗（`plan.tokensBefore > maxTokens`）⇒ 带一条账本行（哪怕
   *     `foldedMessages === 0`——那正是「折叠静默 no-op、照原样发请求换 400」
   *     的可观测形态）；
   *   · 计数 `streak` 由**纯函数** `nextContextFoldStreak` 算出（命中 +1，
   *     否则清零），本方法只负责把它与账本行落库——仓库纪律禁止在
   *     `agent-context.ts` 读上一轮状态，因此「判定纯、状态在库」是硬分工。
   *
   * ## 为什么先读再写（而不是一条 SQL 自增）
   * 账本是**有界数组**（只留最近 `AGENT_CONTEXT_FOLD_LEDGER_MAX` 条）：截断
   * 需要知道当前数组，jsonb 拼接 + 截断写成一条 SQL 的可读性远不如
   * 「读一会话行 → 追加截断 → 条件写」。单写者由 `markRunning` 的 CAS 保证
   * （同一会话同时只有一个 worker 在跑），故不存在丢更新；多副本同时写同一
   * 会话本来就被那道栅栏挡住，这里不重复造锁。
   *
   * ## 条件写为什么不只带 id（ADR-026）
   * 写的是计数器与派生列，但调用点仍在推理循环里：会话可能已被陈旧清扫/人工
   * abort 收敛为终态，此时无条件写会把账本追加到一个「已经结束」的会话上，
   * 并刷新 `updatedAt`（陈旧清扫的心跳）。`status NOT IN (terminal)` 让命中
   * 0 行时如实让位。
   *
   * ## 失败为什么**不**吞
   * 落库失败（DB 抖动）与 `appendStep` 失败同级：推理循环无法保证「有一个
   * 可信的收敛判据」时，继续跑就是在无观测的情况下烧钱。异常交给 `run()` 的
   * 兜底收敛为 `failed`（runtime error），而不是静默降级成「没有账本」。
   *
   * @param input.streak 本轮结束后的连续不收敛计数（0 = 清零）
   * @param input.entry  本轮账本行（null = 本轮无折叠事件，只做清零）
   */
  async recordContextFold(
    id: string,
    input: { streak: number; entry?: AgentContextFoldLedgerEntry | null },
  ): Promise<void> {
    const streak =
      Number.isFinite(input.streak) && input.streak > 0
        ? Math.trunc(input.streak)
        : 0;
    const entry = input.entry ?? null;

    if (!entry) {
      // 清零路径：绝大多数轮次（压根没超窗）走这里。谓词带 `<> 0` 是为了
      // 在计数已是 0 时**命中 0 行**——0→0 的 UPDATE 不但白费一次往返，还会
      // 刷新 `updatedAt`（它是陈旧 running 清扫的心跳，不能被无意义的写推后）。
      await this.sessions
        .createQueryBuilder()
        .update(AgentSession)
        .set({ contextFoldStreak: 0 })
        .where("id = :id AND status NOT IN (:...terminal)", {
          id,
          terminal: [...AGENT_TERMINAL_STATUSES],
        })
        .andWhere(`"contextFoldStreak" <> 0`)
        .execute();
      return;
    }

    const session = await this.sessions.findOne({ where: { id } });
    if (!session) {
      this.logger.warn(
        `recordContextFold(${id}) skipped — session row is gone`,
      );
      return;
    }
    const prev = Array.isArray(session.contextFoldLedger)
      ? session.contextFoldLedger
      : [];
    // 有界账本：只留最近 N 条（会话行不被清理，无界数组会让单行体积随时间
    // 单调增长——这是「不建新表」必须自己付的代价，见实体列注释）。
    const ledger = [...prev, entry].slice(-AGENT_CONTEXT_FOLD_LEDGER_MAX);

    const res = await this.sessions.update(
      { id, status: Not(In(AGENT_TERMINAL_STATUSES)) },
      { contextFoldStreak: streak, contextFoldLedger: ledger },
    );
    if (!res.affected) {
      this.logger.debug(
        `recordContextFold(${id}) lost the race — session already terminal`,
      );
    }
  }

  /**
   * 把终态（failed / budget_exceeded）的会话重新打开为 pending，用于显式
   * resume（GAP-6）。
   *
   * ## 为什么需要它
   * `run()` 对终态一律短路让位（幂等的第一道保证），而 `markRunning` 的
   * CAS 又显式排除终态。于是「对 failed 会话点恢复」此前是**静默 no-op**：
   * controller 返回 `{ok:true}`、job 入队、`run()` 立刻以 failed 返回，
   * 什么都没发生——运维看到的是「点了没反应」，而日志里连一条警告都没有。
   *
   * 正确做法是把「重开」显式化成一次条件状态迁移：只有 failed /
   * budget_exceeded 能被重开（succeeded / aborted 的结果已兑现，重跑等于
   * 让状态机倒退），且用条件写防止与并发收敛撞车。
   *
   * ## RT-2：为什么**要**重置 startedAt
   * 旧实现的注释是「墙钟不可通过 resume 续命」，但那条纪律的真正对象是
   * **自动**续命（一个会话被反复 grant 审批无限延长）。对人工 reopen 它
   * 造成了数学上的死路：陈旧 running 清扫阈值 = 出厂墙钟预算 = 30min，
   * 「被清扫」蕴含 elapsed 已 ≥ 30min，于是恢复后第一轮闸门立刻
   * budget_exceeded——GAP-2 写在 errorMessage 里的「可 resume 继续」、
   * sweep 日志里的 resumable、GAP-6 的恢复能力全是空头支票。
   *
   * 重置只发生在**人工显式恢复**这一条路径上（`resume` 端点），且成本闸门
   * 仍然累计：maxSteps / maxTokens / maxToolCalls 都是会话级累加，不因
   * 重开清零。墙钟是「防卡死」的活性闸门，不是计费闸门——给人工重试一个
   * 新窗口是它的正确语义（同 langgraph：恢复是一次新的 run，有自己的超时）。
   * 自动续跑（auto_resume）与审批 grant 都不经过这里，墙钟不会自增。
   *
   * 不清理 errorMessage（重开是「再试一次」不是「抹掉上次失败」；成功终态
   * 会自然覆盖它）。
   *
   * ## S2-A2：**不**重置 contextFoldStreak（重开不改变历史，判据必须延续）
   * 重开的语义是「用同一份 history 再跑一次」。若上一轮是
   * `context_not_converging`（streak=2），把计数清零等于声称「历史变短了」——
   * 而历史一条都没少，下一轮折叠只会更难收敛。因此计数延续：重开后若仍折
   * 不收敛，会立刻以同一个 reason 再收敛一次（省下那些注定 400 的付费调用）；
   * 反之若运维**调大了** `agent.context.maxTokens`（或换了大窗口模型），折叠
   * 就会重新收敛，计数自然清零——闸门是自愈的，不需要额外开关。
   *
   * @returns 是否重开成功（false = 状态已变化或不是可重开的状态）。
   */
  async reopenForResume(id: string): Promise<boolean> {
    // 数据审计 #2：steps 已被保留期清理的会话不能重开——rebuildMessages 会
    // 拿到空历史（totalSteps 仍是旧值），模型在「没有过去」的情况下重规划，
    // 把已发生的写操作再做一遍。用 EXISTS 条件写消掉「检查→删除→重开」的
    // 竞态：只要 steps 已经没了（且确实跑过），重开命中 0 行。
    const qb = this.sessions
      .createQueryBuilder()
      .update(AgentSession)
      .set({
        status: "pending",
        waitingFor: null,
        startedAt: new Date(),
        finishedAt: null,
      })
      .where("id = :id AND status IN (:...resumable)", {
        id,
        resumable: ["failed", "budget_exceeded"],
      })
      .andWhere(
        `("totalSteps" = 0 OR EXISTS (
          SELECT 1 FROM "agent_steps" st WHERE st."sessionId" = "agent_sessions"."id"
        ))`,
      );
    const res = await qb.execute();
    if (!res.affected) {
      this.logger.warn(
        `reopenForResume(${id}) skipped — session is not in a resumable terminal state`,
      );
    }
    return (res.affected ?? 0) > 0;
  }

  /**
   * 挂起到 waiting_input。
   * **不设 finishedAt**——它不是终态，只是等外部输入。
   */
  async markWaiting(id: string, waitingFor: string): Promise<void> {
    // R36（ADR-026）：进入 waiting_input 同样是状态迁移——若此刻会话已被 finish
    // 收敛到终态（runtime 判定失败与「等输入」几乎同时），无条件写会**把终态翻回
    // waiting_input**：会话永远不再收敛，其后的恢复路径全部按「还在等输入」处理。
    // 条件写命中 0 就什么都不做（让位给已经写出终态的那一方）。
    const marked = await this.sessions.update(
      { id, status: Not(In(AGENT_TERMINAL_STATUSES)) },
      { status: "waiting_input", waitingFor },
    );
    if (!marked.affected) {
      this.logger.debug(
        `markWaiting(${id}) skipped — the session is already terminal`,
      );
    }
  }

  /**
   * 收敛到终态并写指标。
   * 幂等：已是终态则直接返回（重复 resume 不应重复计数或覆盖结论）。
   */
  async finish(
    id: string,
    status: Exclude<
      AgentSessionStatus,
      "pending" | "running" | "waiting_input"
    >,
    options: {
      result?: Record<string, unknown> | null;
      summary?: string | null;
      errorMessage?: string | null;
    } = {},
  ): Promise<void> {
    const session = await this.sessions.findOne({ where: { id } });
    if (!session) return;
    if (AGENT_TERMINAL_STATUSES.includes(session.status)) {
      this.logger.debug(
        `finish(${id}) ignored — already terminal (${session.status})`,
      );
      return;
    }

    // R36（ADR-026）：把上面的「已是终态则返回」从**读时判断**升级为**条件写**。
    //
    // 旧实现是先 findOne 看快照、再 update({id})——两个并发的 finish（runtime 的
    // succeeded 与 controller 的 abort 撞在一起）都能通过快照判断，于是：
    //   ① 后到者覆盖先到者的 status/resultJson/summary（终态结论被改写）；
    //   ② 两次都走到下面的 notify.sessionFinished ⇒ **用户收到两条终态通知**
    //      （注释里明确写着「上面的守卫同时防住了重复通知」，而那条守卫并不成立）；
    //   ③ 指标 autoflow_agent_sessions_total 被计两次，看板会话数偏高。
    // 改成条件写后，命中 0 说明别人先收敛了这个会话——让位即可，这才是真的幂等。
    // 写入点脱敏（本表三个正文列）。**为什么会话行比步骤行更该脱敏**：
    //   ① **行永不删除**：保留期只清 agent_steps / agent_tool_calls /
    //      agent_approvals / agent_events，会话行不在任何清理谓词里 ⇒ 明文
    //      一旦写进这三列就是**永久留存**，没有窗口把它带走；
    //   ② **进通知正文**：`summary` / `errorMessage` 被
    //      `AgentNotifyService.sessionFinished` 直接拼进通知（出口层有
    //      `sanitizeNotificationText` 兜底，但**库里的原文没有**兜底）；
    //   ③ **进导出/详情**：`resultJson.conclusion` 被执行详情与导出 API 原样返回。
    // 口径与步正文完全同一份（`redactForStorage`：只打码、不截断——主数据不许
    // 套事件表的 4000 上限）。
    //
    // 三个值都允许缺省：`result` / `summary` 缺省时**回落既有值**（既有值在
    // 它自己被写入时已经打过码，这里是幂等的第二次，不会解开任何打码）；
    // `errorMessage` 缺省即 null（保持原语义，不回落）。
    const finished = await this.sessions.update(
      { id, status: Not(In(AGENT_TERMINAL_STATUSES)) },
      {
        status,
        finishedAt: new Date(),
        waitingFor: null,
        resultJson: redactSessionResultForStorage(
          options.result ?? session.resultJson,
        ),
        summary: redactNullableText(options.summary ?? session.summary),
        errorMessage: redactNullableText(options.errorMessage),
      },
    );
    if (!finished.affected) {
      this.logger.debug(
        `finish(${id}) lost the race — another writer already terminalized it`,
      );
      return;
    }

    recordRuntime("autoflow_agent_sessions_total", {
      kind: session.kind,
      status,
    });
    this.logger.log(
      `Agent session finished: id=${id} status=${status} steps=${session.totalSteps} tokens=${session.totalTokensIn + session.totalTokensOut}`,
    );

    // S7-G1：`session_finished` —— 终态是会话级唯一「结论事件」，先于通知落库，
    // 这样「用户收到的是什么结论」与「库里记的结论」同源。旁路：事件失败只 warn
    // （`tryAppendEvent`），既不回滚已写出的终态，也不阻断下面的通知。
    // payload 只放**计数与状态**，不放 resultJson/summary/errorMessage——那三者
    // 已在会话行上，且可能含用户数据；事件表要长期保留，不复制它们。
    await this.tryAppendEvent(id, {
      kind: "session_finished",
      // A2 因果：**恒为 NULL**——终态是整轮运行的结论（或管理员 abort / 预算闸门），
      // 没有任何一条**事件**是它的单一前驱。指向最后一条事件会谎称「会话是因为
      // 那条事件结束的」，而真实原因可能是一条根本没有事件的外部动作。
      causedBySeq: null,
      payload: {
        status,
        totalSteps: session.totalSteps,
        tokensIn: session.totalTokensIn,
        tokensOut: session.totalTokensOut,
      },
    });

    // P4 通知：`finish` 是**通知**的唯一收敛点，在这里通知一次即覆盖
    // runtime 的 succeeded/failed/budget_exceeded 与 controller 的 abort。
    //
    // ⚠ 措辞校正（2026-11-02，只读审计）：原文写「**终态**唯一收敛点」，**字面为假**——
    // `sweepStaleRunning`（本文件 `:2151`/`:2167`）**直接写 `status:"failed"` 绕过 `finish()`**。
    // 它走自己的 `notify.staleSweepConverged`（聚合 ERROR，不是 `sessionFinished`），
    // 所以**不会重复通知**——「不重复」那半句是对的，错的是「唯一」这个范围。
    // ⇒ 准确表述：**终态写入有两个来源**（`finish` 与 stale sweep），
    //   **会话级通知只有一个收敛点**（`finish`；sweep 走独立的聚合通知）。
    // 为什么不在 sweep 里也调 `finish`：它会触发 `sessionFinished` 单会话通知，
    // 而 sweep 一次可能收敛多条，逐条通知会把一次清扫变成一串刷屏。
    //
    // 且上面的「已是终态则提前返回」守卫同时防住了重复通知。
    // 传**更新后**的快照——静默语义读的是新 summary，不是旧值。
    // 三个正文值在这里再走一次同一个脱敏（与上面 update 的表达式逐字相同）：
    // 通知正文必须与**库里那份**同源，否则出现「库里 [REDACTED]、通知里明文」
    // 这种最难排查的形态。对已打码的文本再打一次是幂等的（占位符不匹配任何规则）。
    await this.notify.sessionFinished({
      ...session,
      status,
      finishedAt: new Date(),
      waitingFor: null,
      resultJson: redactSessionResultForStorage(
        options.result ?? session.resultJson,
      ),
      summary: redactNullableText(options.summary ?? session.summary),
      errorMessage: redactNullableText(options.errorMessage),
    });
  }

  // ── 步骤与工具调用（用量累加与写入同点，不会漂移）──────────────

  /**
   * 追加一步。
   *
   * seq 分配：`MAX(seq)+1` 在同一事务内完成（唯一约束兜底并发）。
   * 会话是单 worker 串行推进的，并发只可能出现在「人工 resume 撞上定时
   * 扫描」——唯一约束会让后者失败并重试，不会产生重复 seq。
   *
   * C2：会话已终态（或行已不存在）时抛 `AppendStepRejectedError`，且**整步
   * 不落**（事务回滚）——见 appendStepOnce 里的条件写谓词。
   */
  async appendStep(
    sessionId: string,
    input: AppendStepInput,
  ): Promise<AppendedStep> {
    // B-4：token 计数在进 SQL 表达式前收敛为有限正数（见 safeTokenCount）。
    const tokensIn = safeTokenCount(input.tokensIn);
    const tokensOut = safeTokenCount(input.tokensOut);

    // 数据审计 #3：注释承诺「唯一约束会让后者失败并重试」，但实现此前没有任何
    // 重试——23505 直接逃出 appendStep，而 run() 没有兜住它的 catch，最终被
    // AgentProcessor 的「不重抛」策略吞掉：会话停在 running、没有 worker，
    // 只能等 30 分钟陈旧清扫，且 errorMessage 误报「进程崩溃」。
    //
    // 并发来源是真实存在的：陈旧清扫把会话判 failed → 人工 resume → 旧 worker
    // 的慢工具批刚好结束、继续写 step；或两个副本在 CAS 窗口内交错。重算
    // MAX(seq) 后重试即可收敛（每次事务内读到的 max 已包含对方写入）。
    for (let attempt = 0; ; attempt++) {
      let saved: AgentStep;
      try {
        saved = await this.appendStepOnce(
          sessionId,
          input,
          tokensIn,
          tokensOut,
        );
      } catch (err: unknown) {
        // R9：按约束名归因——只有撞 `stepSeq` 才是本路径的 seq 冲突才重试；
        // 撞别的唯一索引原样外抛（重算 MAX(seq) 改变不了它）。`unknown` 维持原行为。
        const own = isOwnUniqueViolation(err, AGENT_UNIQUE_CONSTRAINTS.stepSeq);
        if (attempt + 1 >= APPEND_STEP_MAX_RETRIES || !own) {
          throw err;
        }
        this.logger.warn(
          `appendStep seq conflict (attempt ${attempt + 1}/${APPEND_STEP_MAX_RETRIES}), retrying: session=${sessionId}`,
        );
        // 小幅错开，避免两个 writer 以同一节奏反复撞车
        await new Promise((resolve) => setTimeout(resolve, 5 + attempt * 10));
        continue;
      }
      // S7-G1：`step_appended` 落在**事务之外**（这一步已提交）。
      // 为什么不塞进 appendStepOnce 的事务：事件写入是**旁路**（失败不得影响
      // step），而 PG 的事务一旦有语句报错就进入 aborted 状态——在事务里 catch
      // 住一个失败的事件插入，提交时仍会失败，等于把旁路做成了主链。放到提交后
      // 写，失败只丢一条事件（`tryAppendEvent` 只 warn）。
      // 代价写清：进程在「step 提交」与「事件插入」之间崩溃时，这段事件缺口
      // 不会自愈——可接受，因为 step 本身在，取证仍能回答大部分问题。
      const eventSeq = await this.tryAppendEvent(sessionId, {
        kind: "step_appended",
        // A2 因果：**恒为 NULL**（写出来而不是省略，让「这一步没有前驱事件」
        // 成为代码里的显式陈述）。这一步由用户/scheduler/人工 resume 触发，起因
        // 在事件流之外；若指向「上一条事件」就是一条假边——见
        // `AGENT_EVENT_CAUSATION_RULES.step_appended.ifViolated`。
        causedBySeq: null,
        payload: {
          stepId: saved.id,
          stepSeq: saved.seq,
          role: saved.role,
          tokensIn,
          tokensOut,
          latencyMs: saved.latencyMs ?? 0,
          provider: saved.provider,
          model: saved.model,
          // 只有「是否已折叠」这个派生事实；**摘要正文另走 `body.summary`**。
          // 此前这里只有 `folded`，正文留在 `agent_steps.summary` ⇒ 投影要渲染
          // `[阶段小结] …` 就只能回读台账行，而「折叠那一刻的摘要是什么」这一问
          // 没有事件能回答（`rebuildMessages` 的输入因此**不可由事件流自足重建**）。
          folded: (input.summary ?? null) !== null,
          toolCallCount: Array.isArray(input.toolCallsJson)
            ? input.toolCallsJson.length
            : 0,
          // 正文进事件（S7-G1 第五阶段）：`agent_steps.content` 会被后续写入覆盖
          // （折叠摘要、同 seq 重放），所以「第 N 轮模型看到的那段话」只能由事件
          // 自己承载。已脱敏 + 有界（超 2KiB 截断并标记 truncated/originalBytes）。
          //
          // `summary` 同批进事件（第七阶段）：折叠步的 `[阶段小结] ` 替身正文同样是
          // `rebuildMessages` 的**输入**，缺了它投影只能回读 `agent_steps.summary`
          // ——那列与 `content` 一样是「当前值」，不是「折叠那一刻的值」。
          // 空串经 `buildEventBody` 归一成 `null`（与 `folded` 的 `!== null` 口径
          // 一起保留在快照侧，投影不替它编造判定）。
          body: {
            content: buildEventBody(input.content),
            summary: buildEventBody(input.summary),
          },
        },
      });
      // A2：把这条 `step_appended` 事件的 `seq` 交给调用方（`prompt_fingerprint`
      // 的因果边要用它做前驱）。`tryAppendEvent` 的契约就是「返回新事件的 seq，
      // 失败返回 null」，所以这里是**转交事实**，不是新造一个值：
      //   · 成功 ⇒ 该事件的 seq（`prompt_fingerprint` 的 causedBySeq 直接用它，
      //     不需要再回表按「最近一条 step_appended」猜）；
      //   · 失败（旁路丢了）⇒ **null**。绝不写成 0 或 `undefined` 让 SQL 里出现
      //     一个「看起来像 seq」的假值：那会让因果图指向不存在的前驱。
      return Object.assign(saved, { eventSeq }) as AppendedStep;
    }
  }

  /** appendStep 的单次事务体（seq 分配 + step 写入 + 用量累加，同事务）。 */
  private async appendStepOnce(
    sessionId: string,
    input: AppendStepInput,
    tokensIn: number,
    tokensOut: number,
  ): Promise<AgentStep> {
    return this.sessions.manager.transaction(async (em) => {
      const row = await em
        .createQueryBuilder(AgentStep, "s")
        .select("COALESCE(MAX(s.seq), 0)", "maxSeq")
        .where("s.sessionId = :sessionId", { sessionId })
        .getRawOne<{ maxSeq: number }>();
      const nextSeq = Number(row?.maxSeq ?? 0) + 1;

      const step = em.create(AgentStep, {
        sessionId,
        seq: nextSeq,
        role: input.role,
        // 主表写入点必须脱敏（此前**零脱敏**：列注释写着「已脱敏」，代码却是
        // `input.content ?? null` 原样落库）。为什么主表的脱敏比事件表**更关键**：
        //   · 保留期：事件表固定 180 天；主表是**分档且不完整**的——终态会话的
        //     steps 只留 90 天、read 档 tool_calls 只留 30 天，而**非终态会话**
        //     的 steps / read 档 tool_calls 压根不在清理谓词内（谓词要求会话
        //     终态）⇒ 那部分事实上**没有保留期**；write/dangerous 档 180 天。
        //     明文在主表里的暴露窗口不短于事件表，在无保留期那部分反而更长。
        //   · 读面：主表是**被读回来再外发**的权威源——`rebuildMessages` 把
        //     `step.content` 回灌给模型、`GET /agent/sessions/:id/export` 与详情
        //     API 原样返回 steps、投影在事件正文缺失时回读主表行。事件表那份
        //     脱敏副本管不到这三跳。
        // 规则**复用** `redactEventBodyText`（= 共享实现的 `sanitizeString`），
        // 不在本文件写第二套正则。
        content: input.content == null ? null : redactForStorage(input.content),
        reasoning: input.reasoning ?? null,
        toolCallsJson: input.toolCallsJson ?? null,
        toolCallId: input.toolCallId ?? null,
        tokensIn,
        tokensOut,
        latencyMs: input.latencyMs ?? 0,
        provider: input.provider ?? null,
        model: input.model ?? null,
        // 摘要正文（折叠步的 `[阶段小结] ` 替身）与 `content` **同一口径**：只打码、
        // 不截断。它此前是 `input.summary ?? null`（零脱敏），而它同时有两条外发
        // 读面——`rebuildMessages` 把它回灌给模型、投影把它写进 `payload.body.summary`
        // （脱敏副本）。若这里留明文，事件侧（已脱敏）与快照侧（明文）会对同一句
        // 折叠摘要给出两份不同的文本：切换读路径那一刻，模型看到的上下文会**悄悄
        // 变一次**，而任何一侧都察觉不到。两处同规则是这件事唯一的收敛方式。
        summary: input.summary == null ? null : redactForStorage(input.summary),
      });
      const saved = await em.save(step);

      // 用量累加与 step 写入同事务——分开写会出现「步数涨了用量没涨」
      // 的窗口，而预算闸门正是读用量。这一步是闸门可靠性的基础。
      // B-4：tokens 经 safeTokenCount 收敛后才是有限数——原样拼接上游
      // 字符串可注入原生 SQL。
      //
      // C2：谓词里补**终态排除**——「终态会话不得再被追加」由 DB 条件写判定，
      // 而不是先 findOne 读一次状态、再在应用层抛。
      //   · 为什么不能追加：stale 清扫 / 人工 abort / 并发 finish 会把会话收敛
      //     成终态，而旧 worker 手里的 LLM 回合或慢工具批还在往回写 step。
      //     此时 step 照落、计数照涨，会话详情页就会出现「status=succeeded 但
      //     步数还在增长」，而 finish 的非终态条件写会拒绝改写终态——状态与事实
      //     永久矛盾（用户看到「已完成」，库里却仍在长）。终态是结论，结论之后
      //     不该再有新事实。
      //   · 为什么用谓词而不是先读再抛：先读后写要**多一次查询**，且读-写之间
      //     存在竞态窗口（读到的还是 running，真正 UPDATE 时已终态）。条件写把
      //     「判定 + 写入」压成一条原子语句，命中 0 行就是不可再追加，没有窗口。
      // 命中 0 行时**在事务内抛出**：整个事务回滚，刚 save 的 step 一并撤销，
      // 绝不留下「有 step 但计数没涨」的半截状态（这正是本事务存在的理由）。
      const usage = await em
        .createQueryBuilder()
        .update(AgentSession)
        .set({
          totalSteps: () => '"totalSteps" + 1',
          totalTokensIn: () => `"totalTokensIn" + ${tokensIn}`,
          totalTokensOut: () => `"totalTokensOut" + ${tokensOut}`,
        })
        .where("id = :id", { id: sessionId })
        .andWhere("status NOT IN (:...terminal)", {
          terminal: AGENT_TERMINAL_STATUSES,
        })
        .execute();

      if (!usage.affected) {
        // 只在**拒绝路径**多读一次：用来区分「已终态」与「行不存在」，给出可
        // 判定的错误（正常路径零额外查询）。放行与否早已由上面那条原子条件写
        // 决定，这里读到的状态只用于报错，不参与判定。
        const current = await em.findOne(AgentSession, {
          where: { id: sessionId },
          select: { id: true, status: true },
        });
        throw new AppendStepRejectedError(sessionId, current?.status ?? null);
      }

      // 令牌指标（成本归因）：第三个参数是**令牌数量**，不是 +1。
      // 少了它这张指标只是「有令牌的步数」，按它算成本会低 2~3 个数量级。
      if (tokensIn > 0) {
        recordRuntime(
          "autoflow_agent_tokens_total",
          {
            provider: input.provider ?? "unknown",
            model: input.model ?? "unknown",
            direction: "in",
          },
          tokensIn,
        );
      }
      if (tokensOut > 0) {
        recordRuntime(
          "autoflow_agent_tokens_total",
          {
            provider: input.provider ?? "unknown",
            model: input.model ?? "unknown",
            direction: "out",
          },
          tokensOut,
        );
      }

      return saved;
    });
  }

  // ── 取证型事件日志（S7-G1 第一阶段：只写不读）────────────────────

  /**
   * 追加一批事件到 `agent_events`（会话内 `seq` 单调递增、同批连续）。
   *
   * ## `seq` 的原子分配方案（本方法的重点）
   * **一条 SQL 完成「取基址 + 连续分配 + 插入」**：
   *
   * ```sql
   * WITH base AS (SELECT COALESCE(MAX("seq"), 0) AS "maxSeq"
   *               FROM "agent_events" WHERE "sessionId" = $1)
   * INSERT INTO "agent_events" (...)
   * SELECT $1, base."maxSeq" + t.ord, t.ev->>'kind', ..., now()
   * FROM base CROSS JOIN jsonb_array_elements($2::jsonb) WITH ORDINALITY AS t(ev, ord)
   * RETURNING "seq"
   * ```
   *
   * 三条被**否掉**的方案，以及为什么：
   *   · `SELECT MAX(seq)` + 应用层 +1 + `INSERT`：两次往返，中间是裸的竞态窗口
   *     （两个 writer 都读到 N，都写 N+1）——唯一约束会拒掉一个，但那是「靠约束
   *     兜底」，不是「分配本身原子」。用户要求的「不能 select max+1 再 insert」
   *     正是这条。
   *   · 会话行上的原子计数（`UPDATE agent_sessions SET eventSeq = eventSeq + n
   *     RETURNING eventSeq`）：计数本身确实原子（行锁串行化），但它**会留洞**——
   *     计数涨了而插入失败（约束冲突/连接断/FK），那个号就永久空了，于是
   *     「同批连续」这条不变量从「构造上成立」退化成「需要额外修复」。而且每次
   *     append 都要去锁会话行，与 `markRunning`/用量自增/`finish` 抢同一把锁。
   *   · 序列/雪花：与会话内偏移脱钩（全局单调 ≠ 会话内连续），不满足判据。
   * 现方案的性质：`MAX` 与 `INSERT` 在**同一条语句**里，PG 保证它要么全成要么
   * 全不成；同一会话的并发 append 里，输的一方撞 `(sessionId, seq)` 唯一约束
   * 拿 23505，重试时重算的 `MAX` 已包含赢家的行 ⇒ 收敛、且**永远不会留洞**
   * （没有中间态可言：要么这段 seq 被写进去，要么一行都没有）。
   *
   * ## 落实的两条 Temporal 不变量
   * ① **同批连续**：`ord` 来自 `WITH ORDINALITY`，基址只有一个；插入后再用
   *    `RETURNING "seq"` **断言**一次连续性（`EventSeqContiguityError`，事务回滚）；
   * ② **超上限整批拒**：`AGENT_EVENT_BATCH_MAX`（条数）与
   *    `AGENT_EVENT_BATCH_MAX_BYTES`（字节，S7-G1 第五阶段随正文一起加）都在动
   *    DB **之前**判，超限抛 `EventBatchRejectedError`，一行都不写（不存在
   *    「写了一半」）。两条上限是同一种纪律的两个维度：条数管「事务多宽」，字节
   *    管「载荷多重」——后者对应 Temporal 的 `TransactionSizeLimit`。
   * 另外两条（同批版本一致、`node_id`=首批事件 ID）是分片/重放锚点，我们单库
   * 且不做重放，**刻意不抄**——理由写在迁移 1790000000089 与实体头注里。
   *
   * ## 为什么包在事务里
   * 单语句本身已原子；事务只是为了让「连续性断言失败 ⇒ 整批回滚」成为可能。
   * 断言正常通过时事务的代价是一次 BEGIN/COMMIT，与「事件可被信任为连续」相比
   * 可以忽略。
   *
   * @throws EventBatchRejectedError 批量超上限（未写入）
   * @throws EventSeqContiguityError 插入后断言不连续（已回滚）
   * @throws TypeORM 驱动错误（23505 已内部重试至上限）
   */
  async appendEvents(
    sessionId: string,
    events: AgentEventInput[],
  ): Promise<{ firstSeq: number; seqs: number[] }> {
    if (events.length === 0) return { firstSeq: 0, seqs: [] };
    if (events.length > AGENT_EVENT_BATCH_MAX) {
      throw new EventBatchRejectedError(sessionId, events.length);
    }
    // payload 归一：null/undefined → {}（列是 NOT NULL；空 jsonb 比 SQL NULL 好读）。
    //
    // 因果边（A2）归一：只接受**正整数**，其余（undefined / null / 0 / 负数 /
    // 非整数）一律**不带这个键** ⇒ 落库为 NULL。为什么是「不带键」而不是「带
    // null」：两者在库里同一件事（列可空），但前者让 `appendEvents` 的既有调用
    // 参数逐字节不变（`WITH ORDINALITY` 那条 SQL 的 `$2` 是本仓被断言过的稳定
    // 面），后者会让「一次性写全批」的参数多出一串 `"causedBySeq":null`。归一
    // 放在这里而不是信任调用方：seq 是 DB 分配的，0/负数/NaN 不可能指向任何一行，
    // 写进去就是一条**假边**（比 NULL 坏——NULL 是「不知道」，假边是「说谎」）。
    const rows = events.map((e) => {
      const causedBySeq =
        typeof e.causedBySeq === "number" &&
        Number.isInteger(e.causedBySeq) &&
        e.causedBySeq > 0
          ? e.causedBySeq
          : null;
      return {
        kind: e.kind,
        payload: e.payload ?? {},
        ...(causedBySeq === null ? {} : { causedBySeq }),
      };
    });

    // 字节上限：与上面条数上限**同位置、同纪律**——动 DB 之前判，超限整批拒。
    // 计量对象就是下面真正进 `jsonb_array_elements($2)` 的那串文本（含转义），
    // 不是字段长度估算：转义是放大器，估算会低估，而低估正是「以为有界其实没有」
    // 的来源。序列化结果顺带传给单次事务体，避免同一次 append 序列化两遍。
    const batchJson = JSON.stringify(rows);
    const batchBytes = Buffer.byteLength(batchJson, "utf8");
    if (batchBytes > AGENT_EVENT_BATCH_MAX_BYTES) {
      throw new EventBatchRejectedError(sessionId, rows.length, batchBytes);
    }

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.appendEventsOnce(sessionId, rows, batchJson);
      } catch (err: unknown) {
        // R9：按约束名归因（同 `appendStep`，详见 agent-unique-violation.util.ts）。
        const own = isOwnUniqueViolation(err, EVENT_SEQ_UQ);
        if (attempt + 1 >= APPEND_EVENT_MAX_RETRIES || !own) {
          throw err;
        }
        this.logger.warn(
          `agent_events seq conflict (attempt ${attempt + 1}/${APPEND_EVENT_MAX_RETRIES}), retrying: session=${sessionId}`,
        );
        // 小幅错开，避免两个 writer 以同一节奏反复撞车（同 appendStep）
        await new Promise((resolve) => setTimeout(resolve, 5 + attempt * 10));
      }
    }
  }

  /** `appendEvents` 的单次事务体（单语句插入 + 连续性断言）。 */
  private async appendEventsOnce(
    sessionId: string,
    rows: Array<{
      kind: string;
      payload: Record<string, unknown>;
      causedBySeq?: number;
    }>,
    /** `JSON.stringify(rows)`——字节上限已按它判过，这里直接复用同一串。 */
    batchJson: string,
  ): Promise<{ firstSeq: number; seqs: number[] }> {
    return this.sessions.manager.transaction(async (em) => {
      // `"causedBySeq"` 的取值写法：`->>'causedBySeq'` 对**缺键**返回 SQL NULL，
      // 对显式 `null` 也返回 SQL NULL，只有正整数会变成文本 ⇒ `NULLIF(...,'')`
      // 再 `::integer` 是恒等变换（归一已在 appendEvents 里做过，这里是第二道
      // 类型闸：JSON 里若混进 `"abc"`，PG 会在插入时直接报错而不是写成 0）。
      const inserted = (await em.query(
        `WITH base AS (
           SELECT COALESCE(MAX("seq"), 0) AS "maxSeq"
           FROM "agent_events"
           WHERE "sessionId" = $1::uuid
         )
         INSERT INTO "agent_events" ("sessionId", "seq", "kind", "payload", "causedBySeq", "createdAt")
         SELECT $1::uuid,
                base."maxSeq" + t."ord",
                t."ev"->>'kind',
                COALESCE(NULLIF(t."ev"->'payload', 'null'::jsonb), '{}'::jsonb),
                NULLIF(t."ev"->>'causedBySeq', '')::integer,
                now()
         FROM base
         CROSS JOIN jsonb_array_elements($2::jsonb) WITH ORDINALITY AS t("ev", "ord")
         RETURNING "seq"`,
        [sessionId, batchJson],
      )) as Array<{ seq: number | string }>;

      const seqs = inserted.map((r) => Number(r.seq)).sort((a, b) => a - b);
      // 不变量①：同批必须连续（不跳号、不重复、条数一致）
      const contiguous =
        seqs.length === rows.length &&
        seqs.every((seq, i) => seq === seqs[0] + i);
      if (!contiguous) {
        throw new EventSeqContiguityError(sessionId, seqs);
      }
      return { firstSeq: seqs[0], seqs };
    });
  }

  /**
   * 旁路追加一条事件：**永不抛出**（S7-G1 纪律 2）。
   *
   * 为什么必须旁路：事件日志是**观测面**，不是主链的一部分。`appendStep` /
   * `recordToolCall` / `finish` / provider 调用都是「会话正在发生的事」，事件写入
   * 失败（DB 抖动、批量误用、会话行已被清导致 FK 违例）若把它们拖成 failed，
   * 就是「记账失败导致交易失败」——与 `emitTerminalEvent` 的纪律同款（旁路失败
   * 不改变主链结论）。代价必须写清：**事件可能缺失**，缺的那一段不会自我修补；
   * 但主数据（steps / tool_calls / 会话终态）始终完整，取证只能拿到「部分但忠实」
   * 的序列——这比「为了记账把会话弄死」正确。
   *
   * 返回新事件的 `seq`（便于调用侧/测试断言顺序），失败返回 null。
   *
   * ## 失败必须留一条**可查询**的信号（S7-G1 补丁）
   *
   * 上面写了「事件可能缺失」，但没说清**缺口怎么被发现**。事实是：`agent_events`
   * 剩下的行 seq 仍然连续、投影照常渲染 ⇒ 取证序列**看起来是完整的**，而运维
   * 手上只有一条随日志轮转消失的 warn。所以失败时同时 `recordRuntime` 一次
   * `autoflow_agent_event_append_failed_total{kind}`——它是「第 N 轮模型看到什么」
   * 这个问题还值不值得相信的**唯一机器可查判据**。
   *
   * 计数本身是**旁路里的旁路**：`recordRuntime` 的契约是「纯内存自增，不抛错」
   * （runtime-metrics-entry.ts 的 `recordRuntime`：未知名字静默忽略、脏 value
   * 归一为 1、无 await），但这里仍然包一层 try/catch——纪律是「计数失败也绝不
   * 能把主链拖成 failed」，而纪律不能建立在「被调方永远不抛」的假设上。
   */
  async tryAppendEvent(
    sessionId: string,
    event: AgentEventInput,
  ): Promise<number | null> {
    try {
      const out = await this.appendEvents(sessionId, [event]);
      return out.firstSeq;
    } catch (err: unknown) {
      try {
        recordRuntime("autoflow_agent_event_append_failed_total", {
          kind: event.kind,
        });
      } catch {
        // 计数失败静默吞掉：宁可少一条观测，也不能少一条主链
      }
      this.logger.warn(
        `agent_events append failed (bypass — main flow unaffected): ` +
          `session=${sessionId} kind=${event.kind} — ${
            err instanceof Error ? err.message : String(err)
          }`,
      );
      return null;
    }
  }

  // ── 因果边（A2）：写入侧的因果解析 ────────────────────────────────
  //
  // ## 为什么因果必须落列，而不是每次靠 payload 猜
  //
  // 事件流此前是**扁平日志**：能查到「先发生什么、后发生什么」，查不到「后那条
  // 被**哪条**引起」。回答后者只能靠 `payload.toolCallId` 相同就归堆——而那是
  // 推断，三个具体失效面都存在：① 一次调用有多条状态迁移，「第 3 条是被第 2 条
  // 还是被审批决定引起的」按 id 分不出来；② payload 可以缺字段（迁移 069 之前
  // 的 `tool_call_recorded` 没有 `toolCallId`）；③ 推断永远能给一个「看起来对」
  // 的答案 ⇒ **配错了在数据层不可见**，而能被违反的断言才是证据。
  //
  // ## 落点规则（与 `AGENT_EVENT_CAUSATION_RULES` 逐条对应，守卫按它检查）
  //
  //   · `step_appended`      → NULL（由用户/scheduler 触发整轮运行，没有单一前驱事件）
  //   · `tool_call_recorded` → 请求它的那个 step 的 `step_appended`（按 `stepId` 解析）
  //   · `tool_call_status_changed` → 该调用的 `tool_call_recorded`（Temporal
  //     `ScheduledEventId` 口径：结果事件指向**发起事件**）；deny settle 这两条
  //     由审批决定直接触发，改指 `approval_decided`（见 `agent.controller.ts`）
  //   · `approval_decided`   → 需要审批的那个调用的 `tool_call_recorded`（由本类注册
  //     给审批服务的**事件端口**统一补齐，见 `enrichApprovalDecidedCausation`）
  //   · `prompt_fingerprint` → 触发这轮 LLM 调用的 `step_appended`（写点在
  //     `agent-runtime.service.ts`，本项足迹之外——如实保持 NULL，见报告）
  //   · `session_finished`   → NULL（终态是整轮运行的结论或人工 abort，没有单一前驱）
  //
  // ## 「解析不到就不写」为什么是纪律而不是偷懒
  //
  // 下面三个解析器都只接受**唯一命中**：0 行（前驱没写成功/已被保留期清掉）与
  // ≥2 行（引用不唯一）都返回 null。塞一个「最近的」「最像的」进去，库里就再也
  // 分不清真指针与推断——而本列的全部价值就是「它一定是事实」。查询失败同样降级
  // 为 null（因果是**记账**，不能让记账把主链弄挂；与 `tryAppendEvent` 的旁路同款）。
  //
  // ## 成本（必须写清，因为它在热路径上）
  //
  // 每次 `recordToolCall` / `updateToolCallByToolCallId` 各多**一次** SELECT：
  // `WHERE "sessionId" = $1 AND "kind" = $2 AND "payload"->>k = v ORDER BY "seq" DESC
  // LIMIT 2`。它走 `(sessionId, seq)` 唯一索引做**会话内**范围扫，行数被事件保留期
  // 与会话步数上限共同封顶（量级 10²~10³），jsonb 过滤在内存里做——换来的是每工具
  // 调用多一次往返、拿到一条**事实**而不是事后推断。若将来这成了热点，正确做法是
  // 让它更便宜（给关键引用建表达式索引），**不是**退回去「按时间邻近猜」。

  /**
   * 按 payload 里的**唯一引用键**找那条事件的 `seq`（精确解析，不做邻近推断）。
   *
   * 为什么用 payload 里的引用而不是重算业务键：`stepId` / `toolCallId` /
   * `approvalKey` 都是写入时就已确定的唯一键（分别有主键、`(sessionId,toolCallId)`
   * 唯一索引、`approvalKey` 唯一约束），「按主键回指」是**解引用**，不是模式匹配。
   *
   * 返回 null 的三种情形都必须保留：0 行（前驱没写成）、≥2 行（引用不唯一——
   * 说明写入侧出现了不该出现的一条调用两行记录）、查询失败。三者都写 NULL，读侧
   * 会把它记成 `heuristic`（回落既有启发式）而不是伪造一条边。
   *
   * `public` 只因为 `agent.controller.ts` 的 deny settle 需要它把事件指向那条
   * `approval_decided`；它不是通用查询面（本表没有对外的读 API，见实体头注）。
   */
  async findEventSeqByRef(
    sessionId: string,
    kind: AgentEventKind,
    match: Record<string, string>,
  ): Promise<number | null> {
    const keys = Object.keys(match);
    if (keys.length === 0) return null;
    try {
      const where = keys
        .map((k, i) => `"payload"->>$${i + 3} = $${keys.length + 3 + i}`)
        .join(" AND ");
      const rows = (await this.sessions.manager.query(
        `SELECT "seq" FROM "agent_events"
         WHERE "sessionId" = $1::uuid AND "kind" = $2 AND ${where}
         ORDER BY "seq" DESC
         LIMIT 2`,
        [sessionId, kind, ...keys, ...keys.map((k) => match[k])],
      )) as Array<{ seq: number | string }>;
      // 只认**唯一命中**：0 行 = 前驱不存在/已被清理；2 行 = 引用不唯一（不猜）。
      if (rows.length !== 1) {
        if (rows.length > 1) {
          this.logger.debug(
            `causation ref not unique: session=${sessionId} kind=${kind} ` +
              `${keys.join(",")} — 保持 NULL（不猜）`,
          );
        }
        return null;
      }
      const seq = Number(rows[0].seq);
      return Number.isInteger(seq) && seq > 0 ? seq : null;
    } catch (err: unknown) {
      this.logger.debug(
        `causation resolve failed (bypass — 事件照写，因果留 NULL): ` +
          `session=${sessionId} kind=${kind} — ${
            err instanceof Error ? err.message : String(err)
          }`,
      );
      return null;
    }
  }

  /**
   * `tool_call_recorded` 的因果：请求它的那个 step 的 `step_appended`。
   *
   * `stepId` 缺省（工具调用没有归属步，例如某些恢复路径）⇒ NULL：没有引用就没有
   * 事实，不按「最近一条 step_appended」补（并发会话/折叠重放时会指错步）。
   */
  private async resolveToolCallRecordedCause(
    sessionId: string,
    stepId: string | null | undefined,
  ): Promise<number | null> {
    if (!stepId) return null;
    return this.findEventSeqByRef(sessionId, "step_appended", { stepId });
  }

  /**
   * `tool_call_status_changed` 的因果：该调用的 `tool_call_recorded`。
   *
   * 为什么指向**发起事件**而不是「上一条状态事件」：Temporal 的
   * `ScheduledEventId` 也是指向 `ActivityTaskScheduled`（发起），不是指向上一次
   * 结果。指向发起事件让「这次调用的一生」收敛到同一个父亲节点，因果图是一棵树
   * 而不是一条链（链在缺一条事件时会让整段历史断成互不相关的碎片）。
   */
  private async resolveStatusChangedCause(
    sessionId: string,
    toolCallId: string | null | undefined,
  ): Promise<number | null> {
    if (!toolCallId) return null;
    return this.findEventSeqByRef(sessionId, "tool_call_recorded", {
      toolCallId,
    });
  }

  /**
   * `approval_decided` 的因果（**由事件端口统一补齐**，见构造器）。
   *
   * 为什么补在这里而不是写事件的审批服务里：审批服务的 `decide` / `consume` 入参
   * 只有 `approvalKey`，「这个 key 对应哪次调用」是 `agent_tool_calls.approvalId`
   * 那一列的语义——**事件表的拥有者是本服务**，跨表解引用放在这里才不破坏
   * 「审批服务不认识会话/台账」的单向依赖（构造器的反向注册注释同理）。
   *
   * 两个分支（与规则表一致）：
   *   · `granted` / `denied`：起因 = 需要审批的那个调用的 `tool_call_recorded`；
   *   · `consumed`：起因 = 同一 `approvalKey` 上更早的 `approval_decided(granted)`
   *     ——「执行体领走这张单」是被**那次批准**引起的，不是被调用的申请引起的
   *     （把 granted 与 consumed 都指向申请，会让「谁批准 → 谁领取」的先后关系
   *     在因果图里消失）。
   */
  private async enrichApprovalDecidedCausation(
    sessionId: string,
    event: AgentEventInput,
  ): Promise<AgentEventInput> {
    // 只补一种 kind、且只在调用点**没给**的时候补（显式给了就以调用点为准）。
    if (event.kind !== "approval_decided") return event;
    if (typeof event.causedBySeq === "number") return event;
    const p = (event.payload ?? {}) as Record<string, unknown>;
    const approvalKey =
      typeof p.approvalKey === "string" ? p.approvalKey : null;
    const status = typeof p.status === "string" ? p.status : null;
    if (!approvalKey || !status) return event;
    let cause: number | null = null;
    if (status === "consumed") {
      cause = await this.findEventSeqByRef(sessionId, "approval_decided", {
        approvalKey,
        status: "granted",
      });
    } else {
      // approvalKey → agent_tool_calls.approvalId → 该行的 toolCallId → 事件 seq。
      // 三跳都是唯一键解引用；任何一跳不唯一就保持 NULL（`resolveStatusChangedCause`
      // 的「只认唯一命中」同款）。查询失败在 findEventSeqByRef 内部已降级为 null。
      const call = await this.findToolCallIdByApprovalId(
        sessionId,
        approvalKey,
      );
      cause = await this.resolveStatusChangedCause(sessionId, call);
    }
    return cause === null ? event : { ...event, causedBySeq: cause };
  }

  /**
   * `approvalKey` → 该审批单引用的那次调用的 `toolCallId`（唯一命中才返回）。
   *
   * 为什么用一次按 `approvalId` 的查询而不是从 controller 传进来：`decide` /
   * `consume` 是**审批侧**的动作，它不知道自己对应哪次调用；而两表的连接键在
   * `agent_tool_calls.approvalId` 上——本服务持有那个仓储（见构造器）。
   */
  private async findToolCallIdByApprovalId(
    sessionId: string,
    approvalId: string,
  ): Promise<string | null> {
    try {
      const rows = (await this.toolCalls.find({
        where: { sessionId, approvalId },
        select: { toolCallId: true },
        take: 2,
      })) as Array<{ toolCallId: string | null }>;
      if (rows.length !== 1) return null;
      return rows[0].toolCallId ?? null;
    } catch {
      // 因果是记账：查不到就留 NULL，绝不把主链（审批决定本身）拖挂。
      return null;
    }
  }

  /**
   * 记录一次工具调用。
   *
   * 无论成功/被拒/待审批都调用本方法——**被拒的尝试同样有价值**
   * （安全信号 + scope 调参依据），不能只在内存丢弃。
   */
  /**
   * 就地更新一次已存在的工具调用记录（TOOLS-02 确定性重放）。
   *
   * 为什么需要「更新」而不是再插一行：重放已批准的调用时，模型当时给的
   * `tool_call id` 与台账里那条 `awaiting_approval` 行**相同**；GAP-5 的
   * `(sessionId, toolCallId)` 唯一索引会直接拒绝第二次 insert。就地更新
   * 同时保证「一次调用只对应一行台账」，审计面不会出现一调用两行。
   *
   * **不累加 totalToolCalls**：挂起时那一行已经计过一次（recordToolCall 里
   * 的 SQL 自增）；这里再自增会让「工具调用数」预算凭空多消耗一次。
   *
   * @returns 是否命中（false = 行不存在/已被别的路径更新）。
   */
  async updateToolCallByToolCallId(
    sessionId: string,
    toolCallId: string,
    patch: {
      toolName: string;
      tier: AgentToolTier;
      status: AgentToolCallStatus;
      args?: Record<string, unknown> | null;
      result?: Record<string, unknown> | null;
      resultTruncated?: boolean;
      errorMessage?: string | null;
      durationMs?: number;
      /** 本行 status 变更时刻（迁移 083 / C2）；缺省由本方法按 now() 置位。 */
      stateChangedAt?: Date;
      /**
       * A2 因果：调用点显式给出的因果边（引起本次状态迁移的那条事件的 seq）。
       *
       * 只有**知道得比按 `toolCallId` 解析更准**的路径才该用它——目前是
       * 「由审批决定直接触发」的迁移（此时起因是 `approval_decided`，不是发起
       * 事件）。缺省（`undefined`）按规则解析 `tool_call_recorded`；
       * 显式传 `null` = 调用点明确表示「不知道」，本方法**不再**去解析
       * （两者在库里都是 NULL，区别只在「谁做的判断」，写清楚便于人读）。
       */
      causedBySeq?: number | null;
    },
  ): Promise<boolean> {
    const res = await this.toolCalls.update(
      { sessionId, toolCallId },
      {
        argsJson: patch.args ?? null,
        // `resultJson` 在上游（`ToolExecutorService`）已过 `sanitizeResult` ⇒
        // **本层不再脱敏**（幂等但浪费，且结构脱敏跑第二遍会把成品再打一次码）。
        resultJson: patch.result ?? null,
        resultTruncated: patch.resultTruncated ?? false,
        status: patch.status,
        // 写入点脱敏：与 `appendStep` 的步正文**同一口径**（同一个函数）。
        errorMessage:
          patch.errorMessage == null
            ? null
            : redactForStorage(patch.errorMessage),
        durationMs: patch.durationMs ?? 0,
        // C2：状态迁移时间戳与 status 同一次 UPDATE 落库——分两次写会出现
        // 「status 已变但时间戳还是上一个状态」的窗口，崩溃恢复读到的时间点
        // 就成了假证据。缺省 now() 保证没有任何更新路径能忘记它。
        stateChangedAt: patch.stateChangedAt ?? new Date(),
      },
    );
    if (!res.affected) return false;
    recordRuntime("autoflow_agent_tool_calls_total", {
      tool: this.metricToolLabel(patch.toolName),
      tier: patch.tier,
      status: patch.status,
    });
    // S7-G1：`tool_call_status_changed` —— 这一条就是「历史状态不保留」的补丁。
    // 本表的 status 是就地更新（先写 in_flight，执行完再覆盖成 ok/error），从此
    // 每次迁移都以事件形式留痕：按 toolCallId 取事件序列，就是这次调用真实的
    // 生命周期。
    // payload 记**状态与工具身份**，并且从 S7-G1 第五阶段起**也记正文**
    // （`body.result` / `body.error`，已脱敏 + 有界）。此前这里只记
    // `hasResult` / `errorMessage:"present"` 这类「有没有」的哨兵，正文靠
    // `(sessionId, toolCallId)` 回读台账行——但台账行是**就地更新**的，回读到
    // 的永远是「最后一次写入」，答不出「第 N 次状态迁移那一刻看到什么」。
    // 参数（`argsJson`）仍**不**进事件：它不在本方法的正文契约里（写入点由
    // `recordToolCall` 负责），保留「只记结果与错误」的口径。
    // 没有记 `from`：那需要额外一次读（多一次往返 + 读-写窗口），而「按 seq 排序
    // 的 to 序列」已经完整决定 from 序列（首条由 tool_call_recorded 给出）。
    //
    // A2 因果：这条事件「是谁引起的」。规则是**该调用的 tool_call_recorded**
    // （Temporal `ScheduledEventId` 口径：结果事件指向发起事件），由
    // `resolveStatusChangedCause` 按 `(sessionId, toolCallId)` 精确解析；调用点
    // 若知道得更准（审批触发的迁移 ⇒ `approval_decided`）就显式传 `causedBySeq`。
    // 解析不到唯一前驱 ⇒ NULL（回落启发式配对，读侧标 `heuristic`），**不猜**。
    const causedBySeq =
      patch.causedBySeq !== undefined
        ? patch.causedBySeq
        : await this.resolveStatusChangedCause(sessionId, toolCallId);
    await this.tryAppendEvent(sessionId, {
      kind: "tool_call_status_changed",
      causedBySeq,
      payload: {
        toolCallId,
        toolName: patch.toolName,
        tier: patch.tier,
        status: patch.status,
        durationMs: patch.durationMs ?? 0,
        resultTruncated: patch.resultTruncated ?? false,
        hasResult: (patch.result ?? null) !== null,
        // `errorMessage` 这个**存在性哨兵**保留原样（"present"）：投影与守卫脚本
        // 都在按它判断「事件说这里有错误文案」，改语义会连带改读侧。正文走 body。
        errorMessage: patch.errorMessage ? "present" : null,
        // 正文进事件：这一条事件记的**就是本次更新写入那份正文**。否则「第 N 次
        // 状态迁移时结果是什么」只能回读台账行——而那一行已经被这次（或下一次）
        // 更新覆盖，引用会漂回「最后一次写入」。
        body: {
          result: buildEventBody(patch.result),
          error: buildEventBody(patch.errorMessage),
        },
      },
    });
    return true;
  }

  /**
   * OBS3-02（第 3 轮观测审计）：把模型给的工具名收敛成**有界**的指标 label。
   *
   * 指标 label 直接取 `call.function.name` 等于把基数交给模型：每次编一个新
   * 名字就是一个新 series（Prometheus 基数爆炸、渲染内存随会话线性增长）。
   * 注册表里的工具名是闭集，不在其中的一律归并成 "unknown"——审计仍能看到
   * 「有越界调用」，但不会为每个幻觉名字建一条永久 series。
   */
  private metricToolLabel(toolName: string): string {
    return AGENT_TOOL_BY_NAME.has(toolName) ? toolName : "unknown";
  }

  async recordToolCall(input: RecordToolCallInput): Promise<AgentToolCall> {
    const row = this.toolCalls.create({
      sessionId: input.sessionId,
      stepId: input.stepId ?? null,
      toolCallId: input.toolCallId ?? null,
      toolName: input.toolName,
      tier: input.tier,
      argsJson: input.args ?? null,
      // `resultJson` 在上游（`ToolExecutorService`）已过 `sanitizeResult` ⇒
      // **本层不再脱敏**（幂等但浪费，且结构脱敏跑第二遍会把成品再打一次码）。
      resultJson: input.result ?? null,
      resultTruncated: input.resultTruncated ?? false,
      status: input.status,
      // 写入点脱敏：与 `appendStep` 的步正文**同一口径**（同一个函数）。
      // 为什么主表的脱敏比事件表更关键见 `redactEventBodyText` 的头注（保留期
      // 差异 + 三处「读回来再外发」的读面）。
      errorMessage:
        input.errorMessage == null
          ? null
          : redactForStorage(input.errorMessage),
      approvalId: input.approvalId ?? null,
      durationMs: input.durationMs ?? 0,
      // C2：插入本身就是本行 status 的**首次**迁移（无 → status）。写入口兜底
      // now()：本表的写路径只有这里与 updateToolCallByToolCallId 两处，兜底后
      // 「有 status 行却没有时间戳」只能在迁移前的存量行里出现（那正是可空的
      // 理由——不知道就是 NULL，不编）。
      stateChangedAt: input.stateChangedAt ?? new Date(),
    });
    const saved = await this.toolCalls.save(row);

    // A3（P2）：`denied` 行只留审计，**不**占用 maxToolCalls 预算。
    //
    // 口径必须与 ToolExecutorService.countPriorCalls 一致：那里也排除
    // denied（否则越权尝试会把正常调用拖到限流，反而放大攻击效果）。而预算
    // 闸门读的是会话的 totalToolCalls——两边口径不一致时，「等审批/墙钟到期
    // 而未执行」的调用会**吃到**速率预算：一批 3 个调用只执行了 1 个，配额
    // 却掉了 3 格，且这些调用一次都没真正跑过。
    //
    // awaiting_approval 仍要计：管理员批准后真正执行走的是 update 台账行的
    // 路径（不重新 recordToolCall），若这里不计，这次执行就永远不进预算。
    if (input.status !== "denied") {
      await this.sessions
        .createQueryBuilder()
        .update(AgentSession)
        .set({ totalToolCalls: () => '"totalToolCalls" + 1' })
        .where("id = :id", { id: input.sessionId })
        .execute();
    }

    recordRuntime("autoflow_agent_tool_calls_total", {
      tool: this.metricToolLabel(input.toolName),
      tier: input.tier,
      status: input.status,
    });

    // S7-G1：`tool_call_recorded` —— 台账行的**首次**插入（开跑 / 待审批 / 被拒
    // 都走这里，初态在 payload.status 里）。它是每一次调用生命周期的起点事件，
    // 后面的 `tool_call_status_changed` 序列与它按 seq 拼起来才是完整轨迹。
    // 旁路：事件写失败只 warn，不影响已经落库的台账行与预算自增。
    //
    // A2 因果：起因 = **请求这次调用的那个 step 的 `step_appended`**（按 `stepId`
    // 精确解析）。缺这条边，「模型在哪一步决定调这个工具」只能靠
    // `agent_tool_calls.stepId` 回读台账行（可空 + 会被就地更新），而同一步里调
    // 多个工具时更分不出它们同属一步。没有 `stepId`（无归属步的恢复路径）⇒ NULL。
    const causedBySeq = await this.resolveToolCallRecordedCause(
      input.sessionId,
      input.stepId,
    );
    await this.tryAppendEvent(input.sessionId, {
      kind: "tool_call_recorded",
      causedBySeq,
      payload: {
        toolCallId: input.toolCallId ?? null,
        toolName: input.toolName,
        tier: input.tier,
        status: input.status,
        approvalId: input.approvalId ?? null,
        hasArgs: (input.args ?? null) !== null,
        resultTruncated: input.resultTruncated ?? false,
        // 首次插入也可能自带终态正文（开跑即 ok/被拒即 error）：不落的话，
        // 「插入即终态」的行（denied / awaiting_approval）就永远没有第二条
        // status_changed 事件可以携带正文。
        body: {
          result: buildEventBody(input.result),
          error: buildEventBody(input.errorMessage),
        },
      },
    });

    return saved;
  }

  /** 会话当前用量（喂给预算闸门）。 */
  async getUsage(session: AgentSession): Promise<{
    steps: number;
    tokensIn: number;
    tokensOut: number;
    toolCalls: number;
    startedAt: Date | null;
  }> {
    // 直接从 DB 重读而非用入参的内存副本——闸门判定必须基于**已落库**的
    // 真实用量（内存副本可能落后于刚写入的 step）。
    const fresh = await this.sessions.findOne({
      where: { id: session.id },
      select: {
        id: true,
        totalSteps: true,
        totalTokensIn: true,
        totalTokensOut: true,
        totalToolCalls: true,
        startedAt: true,
      },
    });
    return {
      steps: fresh?.totalSteps ?? 0,
      tokensIn: fresh?.totalTokensIn ?? 0,
      tokensOut: fresh?.totalTokensOut ?? 0,
      toolCalls: fresh?.totalToolCalls ?? 0,
      startedAt: fresh?.startedAt ?? null,
    };
  }

  // ── 陈旧 running 清扫（GAP-2：崩溃后僵尸 running 的恢复语义）──────

  /**
   * 收敛陈旧 running 会话为 failed（数据完好，可经 resume 重建上下文）。
   *
   * ## 为什么必须有
   * run() 中途 admin-api 崩溃/重启 → 会话永久停在 running：B-8 的 resume
   * 409 只拦「非 running」调用方，而没有任何机制把 running 收敛——
   * steps 与 tool_calls 数据完好、可完整重建上下文，状态机却锁死，只能改库。
   *
   * ## 心跳语义（零新列）
   * `updatedAt`（@UpdateDateColumn）即天然租约：运行中的会话每轮推理都
   * appendStep / recordToolCall（≥每 2-3 分钟一次），每次都自动刷新它。
   * 阈值 30 分钟（对齐 detectStuckDeployments 的 DEPLOYING 判死口径）：
   * 单轮 LLM 重试最坏 ~8s×3 + 工具批 ~10×60s ≈ 11 分钟，30 分钟已高于
   * 任何合法无步进窗口。
   *
   * ## 收敛为 failed 而不是直接重入队
   * 崩溃瞬间的执行位置未知（可能停在工具副作用中途）——盲目 resume 有
   * 双份副作用风险（GAP-1 的 fence 只保证单 worker，不保证「上次执行到
   * 哪」可续）。如实判 failed + errorMessage 指明可 resume：管理员或自动
   * 链路按需 resume（重建上下文后模型看到事实状态，重新规划未完成的
   * 副作用），与桌面端「崩溃重领整单重跑」同一保守取向。
   */
  /**
   * PK-19 续：等待人工输入的会话超时收口（30 天）。
   *
   * 审批面由 `sweepStaleApprovals`（7 天）处理；这里兜住「等待澄清」等其它
   * waiting_input 场景——它们没有 TTL 时同样永久挂起。仍挂在**未过期**审批上的
   * 会话跳过（交给审批 TTL 流程，避免两套规则互相抢）。
   */
  async sweepAbandonedWaitingInput(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - STALE_WAITING_INPUT_TIMEOUT_MS);
    const rows = await this.sessions.find({
      where: { status: "waiting_input", updatedAt: LessThan(cutoff) },
      select: { id: true, waitingFor: true },
    });
    let converged = 0;
    for (const row of rows) {
      if (
        row.waitingFor?.startsWith("等待审批") &&
        this.approvals &&
        (await this.approvals.hasPendingForSession(row.id))
      ) {
        continue;
      }
      await this.finish(row.id, "failed", {
        errorMessage:
          "等待输入超时：30 天内无人工输入，会话已收敛。数据完好；如需继续请重新发起。",
      });
      converged += 1;
    }
    if (converged > 0) {
      this.logger.warn(
        `Agent waiting-input sweep: ${converged} abandoned session(s) converged to failed`,
      );
    }
    return converged;
  }

  /**
   * PK-19：审批单超时收口（与 stale-running 同一 cron / 同一 Leader 门禁）。
   *
   * 只处理「pending 超过 TTL」的单：标 expired，并把**仍挂在该审批上**的
   * 会话收敛为 failed。判定三要素缺一不可：
   *   ① 会话仍是 waiting_input（人可能已批准并恢复，不能再覆盖）；
   *   ② waitingFor 是审批（澄清/自动续跑的等待不能被这条扫掉）；
   *   ③ 该会话已无 pending 单（同一批里可能有多张，全部过期才收敛）。
   * 其余情况交给原流程——宁可少收，不可误杀正在等待输入的会话。
   */
  async sweepStaleApprovals(now: Date = new Date()): Promise<number> {
    if (!this.approvals) return 0;
    const cutoff = new Date(now.getTime() - AGENT_APPROVAL_TTL_MS);
    const { expired, sessionIds } = await this.approvals.expireStalePending(
      cutoff,
      now,
    );
    if (expired === 0) return 0;
    let converged = 0;
    for (const sessionId of sessionIds) {
      const session = await this.sessions.findOne({
        where: { id: sessionId },
        select: { id: true, status: true, waitingFor: true },
      });
      if (!session || session.status !== "waiting_input") continue;
      if (!session.waitingFor?.startsWith("等待审批")) continue;
      if (await this.approvals.hasPendingForSession(sessionId)) continue;
      await this.finish(sessionId, "failed", {
        errorMessage:
          "审批超时：7 天内无人工处置，会话已收敛。审批单已标记 expired；" +
          "如需继续，请重新发起（模型会重新申请审批）。",
      });
      converged += 1;
    }
    if (converged > 0) {
      this.logger.warn(
        `Agent approval TTL sweep: ${expired} approval(s) expired, ${converged} session(s) converged to failed`,
      );
    }
    return converged;
  }

  async sweepStaleRunning(now: Date = new Date()): Promise<string[]> {
    const staleBefore = new Date(now.getTime() - STALE_RUNNING_TIMEOUT_MS);
    const stale = await this.sessions.find({
      where: { status: "running", updatedAt: LessThan(staleBefore) },
      select: { id: true, kind: true },
      take: 1000,
    });
    const swept: string[] = [];
    for (const { id, kind } of stale) {
      // 条件写：仍 running 才收敛——与运行中的 finish 竞态时让位
      // （心跳刚刷新的行 updatedAt 已离开谓词，这层是双保险）。
      const res = await this.sessions.update(
        { id, status: "running" },
        {
          status: "failed",
          finishedAt: now,
          waitingFor: null,
          // 清理路径绕开 finish()，所以脱敏也得**自己带上**（写入点判据见
          // `scripts/check-agent-write-sanitize.mjs`：会话行的每个正文写入点
          // 都必须看得见脱敏调用，不因为"这里是个常量"开例外——例外一开，
          // 下一个把变量塞进来的人就有了先例）。
          errorMessage: redactNullableText(STALE_RUNNING_MESSAGE),
        },
      );
      if ((res.affected ?? 0) > 0) {
        swept.push(id);
        // RT-4：清理路径绕开 finish() 时必须自己补上观测面，否则
        // autoflow_agent_sessions_total 与库内事实漂移（看板少计一类终态）。
        recordRuntime("autoflow_agent_sessions_total", {
          kind,
          status: "failed",
        });
      }
    }
    if (swept.length > 0) {
      this.logger.warn(
        `Agent stale-running sweep: ${swept.length} session(s) converged to failed ` +
          `(no progress for >${Math.round(STALE_RUNNING_TIMEOUT_MS / 60_000)}min) — resumable via resume API`,
      );
      // RT-4：一条聚合 ERROR（不是每会话一条）——崩溃中断是最需要人介入的
      // 失败，此前完全不出现在告警渠道里。notify 自身 fail-open，不阻塞清扫。
      await this.notify.staleSweepConverged(
        swept,
        Math.round(STALE_RUNNING_TIMEOUT_MS / 60_000),
      );
    }
    return swept;
  }
}
