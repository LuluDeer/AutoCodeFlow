/**
 * R206：「队列空转」（queue idle-stuck）判据的**纯函数**实现。
 *
 * 判据（完整推导见 `docs/observability/agent-queue-idle-criterion.md`）：
 * > **idle-stuck = 存在一个 `waiting` job，其「入队至今」的年龄 > 阈值 T，
 * > 且 T **大于**「单个 job 的合理耗时上界」。**
 *
 * ## 为什么**不需要**跨采样状态（R204/R205 曾认为「报不出来」—— 本轮推翻）
 *
 * BullMQ 的 job 有 **`timestamp`（入队时间，`job.timestamp = opts.timestamp ?? Date.now()`）**，
 * 而 waiting 列表底层是 Redis **有序集合**（score = 入队时间）⇒
 * `queue.getWaiting(0, 1)`（内部 `asc=true`）**取到的第一个就是最老的 job**
 * ⇒ **单次请求内**就能算出「最老 waiting job 的年龄」，**不需要**比较两次采样。
 *
 * ## 为什么**不能**只用一个固定阈值（R393：候选信号 × 会被什么打穿）
 *
 * `AGENT_QUEUE_CONCURRENCY = 2` ⇒ 一次批量触发 20 个会话、每个跑 5 分钟 ⇒
 * **最后一个合法地等了 45 分钟**。⇒ 任何 < 45 分钟的固定阈值都会把**正常排队**
 * 报成「空转」⇒ 运营看到一片红、**下次就不看了**。
 * ⇒ 阈值必须**由「单 job 的合理耗时上界」推导**（本仓的**墙钟预算**就是现成上界）。
 */

/** 一个 waiting job 的**最小**观测面（接线层只需提供这些）。 */
export interface WaitingJobProbe {
  /** job id（诊断用）。 */
  id: string;
  /** 入队时间（ms since epoch）—— BullMQ 的 `job.timestamp`。 */
  timestamp: number;
  /** 已经尝试过的次数（`attemptsStarted`）；首轮就卡住的是 0。 */
  attemptsStarted?: number;
}

export interface QueueIdleInput {
  /** 当前 `waiting` 的 job 数（用于「有没有活」的判定）。 */
  waitingCount: number;
  /**
   * **最老**的那个 waiting job（`getWaiting(0, 1)` 的第一个）。
   * `null` = 没有 waiting job。
   */
  oldest: WaitingJobProbe | null;
  /**
   * 阈值（毫秒）—— 应当**由「单 job 合理耗时上界」推导**，
   * **不要**在这里写死魔法数（判据文档 §3.2 / §5）。
   */
  thresholdMs: number;
  /** 当前时刻（ms since epoch）；缺省 `Date.now()`。 */
  now?: number;
}

export interface QueueIdleVerdict {
  /** 是否「空转」（有人 registered 但不再消费新 job）。 */
  idleStuck: boolean;
  /** 最老 waiting job 的年龄（毫秒）；无 job 时为 0。 */
  oldestAgeMs: number;
  /**
   * 这个 job **曾经开始过**又回到 waiting（`attemptsStarted > 0`）。
   *
   * ⚠️ **不是判据的必要条件**（首轮就卡住的 job 两者都没有），但**能加强**它：
   * 区分「从没开始过」与「开始了但反复重来」（后者更像 worker 内部出问题）。
   */
  retried: boolean;
}

/**
 * 判定「队列空转」。
 *
 * ⚠️ **只覆盖 `waiting`**（**不含** `delayed` / `prioritized`）：
 * `delayed` job 的「年龄」语义不同（它是**故意**延迟的，例如 GAP-3 的自动续跑）
 * ⇒ 把它算进来会把**正常延迟**报成「空转」。
 */
export function evaluateQueueIdle(input: QueueIdleInput): QueueIdleVerdict {
  const now = input.now ?? Date.now();
  // 没有 waiting job ⇒ 谈不上空转（队列是空的，不是「卡住了」）。
  if (input.waitingCount <= 0 || !input.oldest) {
    return { idleStuck: false, oldestAgeMs: 0, retried: false };
  }
  const oldestAgeMs = Math.max(0, now - input.oldest.timestamp);
  // 阈值 ≤ 0 ⇒ **不判定**（而不是「全部都算空转」）：
  // 阈值配错时**宁可漏报**，也不要制造一片红（R201 判据文档 §3.2 的同一原则）。
  if (input.thresholdMs <= 0) {
    return {
      idleStuck: false,
      oldestAgeMs,
      retried: (input.oldest.attemptsStarted ?? 0) > 0,
    };
  }
  return {
    idleStuck: oldestAgeMs > input.thresholdMs,
    oldestAgeMs,
    retried: (input.oldest.attemptsStarted ?? 0) > 0,
  };
}
