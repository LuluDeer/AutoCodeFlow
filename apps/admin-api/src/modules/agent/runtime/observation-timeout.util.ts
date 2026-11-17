/**
 * R213：**观测调用超时**（observation timeout）—— 保证「观测」本身总有上界。
 *
 * 判据见 `docs/observability/observation-timeout-criterion.md`。
 *
 * ## 要解决的缺陷（R212 真机实测发现）
 *
 * Redis **不应答但 TCP 仍在**（`docker pause`）时，`queue-stall` / `queue-idle` 端点
 * **挂死 25s+ 无响应** —— 不报错、也不降级。运营看到的是浏览器转圈，
 * 而不是「队列状态未知」徽标。**这是唯一一种「观测系统自己坏了，却让观测面看起来
 * 像没数据」的形态**（误报至少有红色徽标，读失败至少有「未知」文案）。
 *
 * ## 为什么必须在这里修，而不是改连接配置
 *
 * `app.module.ts` 的 `maxRetriesPerRequest: null` + `enableOfflineQueue: true`
 * 是 **BullMQ 的硬性要求**（阻塞命令要能无限等）⇒ **不能动**。缺陷只能在**观测层**补：
 * 观测是**只读、低频、可放弃**的，而 BullMQ 的消费命令不是。
 *
 * ## 为什么是 `Promise.race` 而不是 `commandTimeout`
 *
 * 全局 `commandTimeout` 会**误杀 BullMQ 自己的 `BRPOPLPUSH`**（它本来就该等多久都行）
 * ⇒ 队列会彻底不工作。观测必须**按调用**单独设上界。
 *
 * ## ⚠️ 已知残留风险（如实登记，不声称已消除）
 *
 * `Promise.race` **不取消**底层命令 —— 超时后 ioredis 里那条命令仍挂着，直到连接恢复。
 * 缓解：① 观测是低频 GET（人工刷新/徽标加载）；② 命令最终会被 `retryStrategy` 的重连流程清理；
 * ③ 本条**不**引入连接池重建（那是更大改动，且会波及 BullMQ 自身连接）。
 */

/**
 * 观测调用的默认上界（毫秒）。
 *
 * **推导**（R403：不允许魔法数）：取 `connectTimeout`（`app.module.ts:669`，10000ms）的**一半**。
 * 理由：一次**命令**往返必然**短于**一次**建连**（建连含 TCP 握手 + 认证 + 选库，命令只是一次 RTT）
 * ⇒ 5000ms 已是「健康往返」的极宽松上界（本地/内网实测 < 5ms，相差 3 个数量级）。
 *
 * 它同时是**用户体验**的交点：一个 5 秒还没返回的观测，即使最终成功，对运营决策也已无用
 * （人已经在刷新页面了）。可用 `AGENT_OBSERVATION_TIMEOUT_MS` 覆盖。
 */
export const DEFAULT_OBSERVATION_TIMEOUT_MS = 5_000;

/**
 * 观测端点**整次请求**的总预算（毫秒）。
 *
 * ⚠️ 与单调用上界**不是一回事**：`agent-backlog` 是**串行**探测（最多 200 个 session ×
 * 2 次往返 = 400 次），若每个调用各给 5s，最坏 2000s ⇒ 等于没修。
 * ⇒ 那个端点必须用**总预算**并提前停止（见 `BacklogProbeBudget`）。
 */
export const DEFAULT_OBSERVATION_BUDGET_MS = 8_000;

/** 超时错误的稳定标识（便于接线层区分「超时」与「Redis 返回错误」）。 */
export class ObservationTimeoutError extends Error {
  constructor(
    readonly label: string,
    readonly timeoutMs: number,
  ) {
    super(`observation timed out after ${timeoutMs}ms: ${label}`);
    this.name = "ObservationTimeoutError";
  }
}

/**
 * 给一个观测 promise 套上上界。
 *
 * ⚠️ **超时后不取消底层命令**（见文件头注的残留风险）。这里的实现刻意**不**用
 * `AbortController`：ioredis 的命令级取消需要 `COMMAND TIMEOUT` 之类的能力，
 * 且中途取消会与 BullMQ 共享的连接状态纠缠 —— 收益小于风险。
 *
 * @param label 诊断标签（进日志与错误消息；**不要**含凭据）
 * @param run 实际观测调用
 * @param timeoutMs 上界（缺省 `DEFAULT_OBSERVATION_TIMEOUT_MS`）
 */
export function withObservationTimeout<T>(
  label: string,
  run: () => Promise<T>,
  timeoutMs: number = DEFAULT_OBSERVATION_TIMEOUT_MS,
): Promise<T> {
  // 上界 ≤ 0 ⇒ **不设超时**（与判据「配错宁可漏报」一致：把「配错」变成「不保护」
  // 而不是「所有调用都立刻超时」—— 后者会让整个观测面永久降级）。
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return run();

  const promise = run();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ObservationTimeoutError(label, timeoutMs)),
      timeoutMs,
    );
    // 不要让一个待触发的超时器把进程吊住。
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
    // ⚠️ 底层 promise 若在上限后才 reject，不能让它是「未处理的拒绝」
    //    （否则 Node 会打印 unhandledRejection，把一条**已处理**的超时变成噪声/告警）。
    promise.catch(() => {});
  });
}

/**
 * 观测端点的**总预算**（用于串行探测：`agent-backlog`）。
 *
 * 用法：循环里每次调用前 `budget.expired()`，超了就**停止探测**并返回已得的部分 +
 * `truncated: true`（⚠️ 截断必须可见 —— R395 的纪律）。
 */
export class ObservationBudget {
  private readonly deadline: number;

  constructor(
    readonly budgetMs: number = DEFAULT_OBSERVATION_BUDGET_MS,
    /** 起点（缺省 `Date.now()`；测试可注入）。 */
    now: number = Date.now(),
  ) {
    // 预算 ≤ 0 或非法 ⇒ **不做预算限制**（同 `withObservationTimeout` 的取舍）。
    this.deadline =
      Number.isFinite(budgetMs) && budgetMs > 0
        ? now + budgetMs
        : Number.POSITIVE_INFINITY;
  }

  /** 是否已超总预算。 */
  expired(now: number = Date.now()): boolean {
    return now >= this.deadline;
  }

  /** 剩余预算（毫秒）；不限预算时为 `Infinity`。 */
  remainingMs(now: number = Date.now()): number {
    return Math.max(0, this.deadline - now);
  }

  /**
   * 单次调用可用的上界 = `min(单调用上界, 剩余预算)`。
   *
   * 为什么不是直接给 `DEFAULT_OBSERVATION_TIMEOUT_MS`：在串行循环的后段，
   * 剩余预算可能已经小于单调用上界 ⇒ 若仍等满 5s，整次请求就会**超出总预算**
   * （那正是本条要治的病）。
   */
  sliceMs(
    perCallMs: number = DEFAULT_OBSERVATION_TIMEOUT_MS,
    now: number = Date.now(),
  ): number {
    const remaining = this.remainingMs(now);
    if (!Number.isFinite(remaining)) return perCallMs;
    return Math.max(0, Math.min(perCallMs, remaining));
  }
}
