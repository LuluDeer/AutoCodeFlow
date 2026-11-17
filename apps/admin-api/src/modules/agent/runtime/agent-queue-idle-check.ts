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

/**
 * R207：**从「单 job 合理耗时上界」推导阈值**（R403：阈值不该是魔法数）。
 *
 * ## 推导链（每一环都必须是仓里**已有**的量，不准拍脑袋）
 *
 * ```
 *   单 job 合理耗时上界    = 会话墙钟预算 wallClockMs
 *                          （`agent.budget.wallClockMs`，默认 30min；
 *                           它是**代码层硬闸门**：超时即 budget_exceeded ⇒ 单个 job
 *                           的耗时**结构上**不可能超过它）
 *   并发窗口               = ceil(AGENT_QUEUE_CONCURRENCY / 1) = 2（processor 的并发）
 *   ⇒ 阈值 T               = wallClockMs × 并发槽位数
 * ```
 *
 * ## 为什么乘「并发槽位数」而不是别的倍数
 *
 * 队列里**最老**的那个 waiting job 之所以能合法地等很久，唯一成因是：
 * **前面的 job 正在占用并发槽位**。峰值合法等待 = 「所有槽位各跑满一个上界」
 * = `wallClockMs × AGENT_QUEUE_CONCURRENCY`。`AGENT_QUEUE_CONCURRENCY = 2`
 * + 30min 墙钟 ⇒ **60min**。
 *
 * ⚠️ 这个乘法**不是**保守系数，而是**最坏合法路径本身**：换成 2×/3× 之类的
 * 系数就成了魔法数，而 R403 明确要求「先问本仓有没有一个量已表达『合理上界』」。
 *
 * ## 为什么再留一个「余量」——**只加一拍，不是系数**
 *
 * 派发本身有往返（Redis → worker → DB 落 `processedOn`），且墙钟判定是在
 * **每轮开头**做的 ⇒ 单 job 真实结束时刻会**略晚于** `wallClockMs`。
 * 这个超出量**没有上界**（一次 LLM 调用的超时才是上界），所以**不用系数放大**，
 * 而是加**一拍**：`+ 心跳间隔`。心跳间隔是仓里已有的量
 * （`EXECUTOR_HEARTBEAT_INTERVAL`，执行器心跳 30s）⇒ 取它当「一拍」。
 *
 * @param wallClockMs 会话墙钟预算（`agent.budget.wallClockMs`）
 * @param concurrency 队列并发槽位数（`AGENT_QUEUE_CONCURRENCY`）
 * @param tickMs      一拍（心跳间隔）；缺省 0 ⇒ 纯乘积
 */
export function deriveIdleThresholdMs(
  wallClockMs: number,
  concurrency: number,
  tickMs = 0,
): number {
  // 任一分量为非法/非正 ⇒ 返回 0 ⇒ 判据层「阈值 ≤ 0 ⇒ 不判定」接手（**宁可漏报**）。
  // ⚠️ 这里**不**回落到默认值：配错时静默换一个默认阈值，等于把「配置坏了」
  //   伪装成「判定正常」，那是本仓主导缺陷类（「没读到」渲染成「没问题」）。
  if (!Number.isFinite(wallClockMs) || wallClockMs <= 0) return 0;
  if (!Number.isFinite(concurrency) || concurrency <= 0) return 0;
  const tick = Number.isFinite(tickMs) && tickMs > 0 ? tickMs : 0;
  return wallClockMs * Math.floor(concurrency) + tick;
}

/** 阈值推导的**输入**（接线层从配置读；单独列出便于把「读了哪些量」钉进测试）。 */
export interface IdleThresholdInputs {
  wallClockMs: number;
  concurrency: number;
  tickMs: number;
}

/**
 * 阈值推导的**依据链**（诊断用）——把「T 是多少」和「T 为什么是这个数」一起交出去。
 *
 * 为什么要一并返回依据：运营看到「60min」时的第一个问题是「这个数哪来的」，
 * 若只给结果，下一次调参就会变成改魔法数。
 */
export interface IdleThresholdBasis {
  wallClockMs: number;
  concurrency: number;
  tickMs: number;
  thresholdMs: number;
  /** 一句话推导（进 API 响应与 tooltip，避免前端自己复述公式而漂移）。 */
  formula: string;
}

export function deriveIdleThreshold(
  input: IdleThresholdInputs,
): IdleThresholdBasis {
  const thresholdMs = deriveIdleThresholdMs(
    input.wallClockMs,
    input.concurrency,
    input.tickMs,
  );
  return {
    ...input,
    thresholdMs,
    formula:
      thresholdMs > 0
        ? `wallClockMs(${input.wallClockMs}) × concurrency(${input.concurrency})` +
          (input.tickMs > 0 ? ` + tick(${input.tickMs})` : "")
        : "推导失败（任一分量非法/非正）⇒ **不判定**（宁可漏报）",
  };
}
