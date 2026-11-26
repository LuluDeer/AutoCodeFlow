/**
 * N8 · steer inbox 的纯状态机层。
 *
 * 审批期（会话 waiting_input）用户追加的 steer 意图不能立刻喂给模型——模型此刻
 * 不在跑；先 park 进 inbox，等模型恢复并在**模型步边界**处 drain 注入。
 *
 * 本文件只有状态迁移，零 Nest / DB / 队列依赖：
 *   · 不解释审批短语、不判四眼、不查 TTL、不算策略指纹——那些是
 *     agent-approvals.service 的职责；inbox 只记「什么意图 + 何时入队」；
 *   · 所有函数不可变：返回新对象，绝不修改入参。
 */

/** 一条被 park 的 steer 意图：只含身份、正文与入队时机，不含任何审批语义。 */
export interface SteerIntent {
  /** 意图唯一 id（调用方生成，作为幂等去重的锚点）。 */
  id: string;
  /** 用户 steer 正文，原样透传；状态机不解释其内容。 */
  content: string;
  /** 入队所在的模型步序号——「时机」，供诊断/排序，不参与边界判定。 */
  parkedAtStep: number;
}

/** 不可变收件箱。 */
export interface SteerInbox {
  readonly intents: readonly SteerIntent[];
}

/** 空 inbox（每次返回新对象，避免共享可变引用）。 */
export function emptyInbox(): SteerInbox {
  return { intents: [] };
}

/**
 * 模型步边界令牌：
 *   · number = 刚结束的模型步序号，此刻是注入 steer 的安全点；
 *   · null   = 不在步边界（审批阻塞中 / 工具调用中途 / 后台事件）。
 */
export type StepBoundary = number | null;

/** 一次 drain 的结果。 */
export interface DrainResult {
  /** 本步要处理的意图，按入队 FIFO 顺序；非步边界恒为空数组。 */
  intents: readonly SteerIntent[];
  /** 剩余 inbox：非步边界原样保留，步边界清空已 drain 的意图。 */
  inbox: SteerInbox;
}

/**
 * 审批期入队。
 *
 * 同 id 已存在时幂等返回原 inbox —— 既不追加第二份，也不改既有意图的时机/正文。
 */
export function parkIntent(inbox: SteerInbox, intent: SteerIntent): SteerInbox {
  if (inbox.intents.some((existing) => existing.id === intent.id)) {
    return inbox;
  }
  return { intents: [...inbox.intents, intent] };
}

/**
 * 只在模型步边界取出意图。
 *
 * 非步边界（currentStep === null）绝不放行：返回空 intents 且 inbox 原样保留，
 * 让「审批还在阻塞就把 steer 塞给模型」在行为上无法发生。
 */
export function drainAtStepBoundary(
  inbox: SteerInbox,
  currentStep: StepBoundary,
): DrainResult {
  if (currentStep === null || inbox.intents.length === 0) {
    return { intents: [], inbox };
  }
  return { intents: inbox.intents, inbox: { intents: [] } };
}

/** 一条待唤醒意图：只记目标身份与所挂的 steer 意图 id，不含审批语义。 */
export interface PendingWake {
  /** 唤醒目标的会话 id。 */
  targetId: string;
  /** 触发本次唤醒的 steer 意图 id。 */
  intentId: string;
}

/**
 * 目标状态的已知取值——与 agent-session.entity.ts 的 AgentSessionStatus 逐字对齐。
 * 纯状态机不 import entity，避免把 typeorm 拉进零依赖层；
 * 未列入下方白名单的状态（含本类型里的终态与未来新态）默认不可唤醒。
 */
export type WakeTargetStatus =
  | "pending"
  | "running"
  | "waiting_input"
  | "succeeded"
  | "failed"
  | "aborted"
  | "budget_exceeded";

/** 唯一允许唤醒的活跃态白名单（终态与未知态一律拒绝）。 */
const WAKEABLE_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "waiting_input",
]);

/**
 * 是否应当唤醒目标。
 *
 * fail-closed：pendingWake 缺席、目标状态未知/缺席、或目标处于终态（死意图）
 * 一律 false；只有明确活跃态才 true —— pendingWake 绝不复活死意图。
 */
export function shouldWake(
  pendingWake: PendingWake | null | undefined,
  targetStatus: string | null | undefined,
): boolean {
  if (!pendingWake) return false;
  if (typeof targetStatus !== "string") return false;
  return WAKEABLE_STATUSES.has(targetStatus);
}
