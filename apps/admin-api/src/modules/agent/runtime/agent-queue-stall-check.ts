/**
 * R204：「队列停摆」（queue stall）判据的**纯函数**实现。
 *
 * 判据（完整推导见 `docs/observability/agent-queue-stall-criterion.md`）：
 * > **queue stall = `pendingJobs > 0` 且 `active === 0` 且（`workers === 0` 或 `isPaused()`）**
 *
 * ## 为什么是**纯函数**（不含 BullMQ 依赖）
 *
 * 与 R201 的 backlog 判据同款：判据的核心是**一个可测的决策**：「给定队列的观测快照，
 * 是否停摆」。抽成纯函数 ⇒ ① 不需要真队列就能测 ② 接线层只负责「取观测 + 调本函数」。
 *
 * ## 为什么**不用**时间阈值（R393 的强制步骤：候选信号 × 会被什么打穿）
 *
 * · ❌ `waiting > 0`：**合法积压**（`AGENT_QUEUE_CONCURRENCY = 2`，批量触发时 18 个正常排队）
 * · ❌ `active === 0` 单独用：**瞬态**（两个 job 之间的间隙、刚启动时）
 * · ❌ 最老 waiting job 的年龄 > N：同样被**合法积压**打穿
 * ⇒ 唯一**不受合法积压影响**的信号是**结构性**的：「**有没有人在这场子里干活**」
 * （`getWorkers()`）与「**队列是不是被暂停了**」（`isPaused()`）。
 */

/** 队列观测快照（**由接线层从 BullMQ 读出**）。 */
export interface QueueStallSnapshot {
  /** `waiting`（在队列里等着的）。 */
  waiting: number;
  /** `delayed`（延迟投递的，例如自动续跑的 delayed job）。 */
  delayed: number;
  /** `prioritized`（带优先级排队的）。 */
  prioritized: number;
  /** `active`（**正在被处理**的）。 */
  active: number;
  /** 已注册的 worker 数（BullMQ 的 worker 注册表）。 */
  workers: number;
  /** 队列是否被**人为暂停**。 */
  paused: boolean;
}

/** 在排队等消费的 job 数（**不含 `active`**——active 说明「有人在干」）。 */
export function pendingJobCount(s: QueueStallSnapshot): number {
  return s.waiting + s.delayed + s.prioritized;
}

/**
 * 是否「队列停摆」。
 *
 * @param s 队列观测快照
 * @param opts.requireIdleWorker 置 true 时额外要求 `active === 0`
 *   （接线层**应当**打开它 —— 它把「心跳过期但仍在干活」这一大类误报挡掉，
 *   见判据文档 §3.3）。
 */
export function isQueueStalled(
  s: QueueStallSnapshot,
  opts: { requireIdleWorker?: boolean } = {},
): boolean {
  // ① 没有人要干活 ⇒ 谈不上停摆。
  if (pendingJobCount(s) <= 0) return false;
  // ② 还在处理中 ⇒ 说明**有人在干活**（哪怕 workers 注册表看不到，可能是心跳过期）。
  if (opts.requireIdleWorker !== false && s.active > 0) return false;
  // ③ 结构性条件：队列被暂停，**或**一个 worker 都没注册。
  return s.paused || s.workers <= 0;
}

/**
 * 停摆的**成因**（用于文案与处置指引）——
 * 「暂停」与「无 worker」是**两种不同的处置**（前者去 `resume`，后者去查进程）。
 */
export type QueueStallReason = "paused" | "no-worker";

export function queueStallReason(
  s: QueueStallSnapshot,
): QueueStallReason | null {
  if (!isQueueStalled(s)) return null;
  return s.paused ? "paused" : "no-worker";
}
