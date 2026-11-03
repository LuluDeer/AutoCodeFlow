/**
 * 派发响应的**确定性拒绝**判据（R3-ADMIN-WIRE · A3）。
 *
 * ## 问题（这是真缺陷，不是理论风险）
 *
 * 执行器对**恒定非法载荷**返回 `400`（契约 `errorStatusCodes.policyRejection`
 * 明确定义：载荷形状合法但取值违反执行器侧策略闸）。admin 侧派发路径
 * （`executor.service.ts` 的 `dispatch()`）此前对非 2xx 一律
 * `throw err`（axios 的 `err.message` 只有状态码串，如 `Request failed with
 * status code 400`），而 `classifyFailure` 的 7 条正则里没有「确定性拒绝」
 * 这一类 ⇒ 归 `unknown` ⇒ `unknown` 不在任何不可重试门禁里 ⇒ **走 BullMQ
 * 重试链，白烧 `maxRetry` 预算**。
 *
 * executor-parity 的 R2-1/P0 让 python 侧也与 node 一致返回 400 后，这条**在
 * 两端都暴露**（此前 python 返回 422，文案不同、可能被别的正则吞掉）。
 *
 * ## 为什么用「独立判据叠加」而不是改 `classifyFailure`
 *
 * `classifyFailure` 的 7 条正则产出 `failureReason`，那是**对外契约**
 * （前端 runbook / 通知模板 / 指标 series 都按它分流）。往里加第 8 条规则
 * 会改变既有故障的归因文本，波及面远超本项收益。
 * ⇒ 本模块只在 `failureReason` **之外**叠加一个正交维度：
 * **「这次派发失败是不是确定性拒绝」→ 是否值得重试**。
 *
 * 与既有 `inherentNonRetryable` 的处置同策（`task.processor.ts` 里
 * `APPLICATION_MISSING` / `SANDBOX_UNAVAILABLE` / `INTERPRETER_UNAVAILABLE`
 * 都是「重试不会成功」类），但判据来源不同：那三条靠**已归因的 failureReason**，
 * 本条靠**HTTP 状态码**（归因链看不到它）。
 *
 * ## 状态码分级（唯一事实源 = 契约 `errorStatusCodes`）
 *
 * | 状态码 | 契约段 | 语义 | 可重试 |
 * |---|---|---|---|
 * | **400** | `rejectedRequest` / `protocolViolation` / `policyRejection` | 载荷违反 schema 或取值违反策略闸 —— **同一份载荷重试 N 次结果相同** | **否** |
 * | **429** | `capacityRejection` | 执行器并发已满 —— 容量会释放，**瞬时** | 是（`retryable: true`） |
 * | **503** | `shuttingDownRejection` | 执行器正在 drain —— 停机窗口会过去，**瞬时** | 是（`retryable: true`） |
 * | 其它 | — | 契约未登记 | **不改变既有行为**（`unknown`） |
 *
 * ⚠️ **刻意只把 400 判为不可重试**。不把「所有 4xx」一概判死，理由：
 * - 401/403（凭据/权限）可能由**令牌轮换窗口**造成，重试在轮换完成后可成功；
 * - 404/409 等未在契约登记，语义随执行器实现而变，按「不臆测」处理。
 * 契约只登记了三档，判据就只认这三档——**扩大判定面等于替契约发明语义**。
 */

/** 确定性拒绝的 HTTP 状态码（契约三段同为 400）。 */
export const POLICY_REJECTION_HTTP_STATUS = 400;

/** 瞬时拒绝的 HTTP 状态码（契约 `retryable: true` 的两档）。 */
export const TRANSIENT_REJECTION_HTTP_STATUSES: readonly number[] = [429, 503];

/** 派发失败在「是否值得重试」这一维上的分类。 */
export type DispatchRejectionClass =
  /** 确定性拒绝：同一份载荷重试结果相同 ⇒ 不该烧预算。 */
  | "policy"
  /** 瞬时拒绝：容量/停机窗口，重试有真实价值。 */
  | "transient"
  /** 契约未登记：不改变既有行为。 */
  | "unknown";

export interface DispatchRejectionVerdict {
  /** HTTP 状态码（调用方已知是响应错误时才有意义）。 */
  status: number;
  /** 分类。 */
  class: DispatchRejectionClass;
  /** 是否值得重试。`unknown` 恒为 `true`（不改变既有行为）。 */
  retryable: boolean;
}

/**
 * 由 HTTP 状态码判定「是否值得重试」（**纯函数**）。
 *
 * 判据唯一事实源是契约 `errorStatusCodes` 的三档登记，见文件头注表格。
 *
 * @param status HTTP 响应状态码
 */
export function classifyDispatchStatus(status: number): DispatchRejectionVerdict {
  if (status === POLICY_REJECTION_HTTP_STATUS) {
    return { status, class: "policy", retryable: false };
  }
  if (TRANSIENT_REJECTION_HTTP_STATUSES.includes(status)) {
    return { status, class: "transient", retryable: true };
  }
  // 契约未登记的档位：**不改变既有行为**（仍然走 BullMQ 重试链）。
  return { status, class: "unknown", retryable: true };
}

/**
 * 判定结果在错误对象上的**挂载键**。
 *
 * 用 `Symbol` 而非字符串键：① 不会被 `JSON.stringify` 序列化进日志/回调
 * （状态码进日志没有价值，反而污染既有载荷）；② 不会与 axios 错误自身的
 * 字段（`code` / `status` / `response`）撞名。
 */
const DISPATCH_REJECTION_KEY = Symbol.for(
  "autocodeflow.dispatchRejection",
);

/**
 * 把判定结果挂到错误对象上（**就地标注**，返回同一个错误便于链式使用）。
 *
 * 为什么要挂到错误上而不是新开一条参数通道：`dispatch()` 与
 * `task.processor` 之间隔着 BullMQ 的 `throw`/`catch`，**唯一不新增签名的
 * 传递路径就是错误对象本身**（`dispatch()` 的调用点有 3 处，改签名会波及
 * 全部调用点与其 spec）。
 *
 * @param err 错误对象（非对象时静默跳过——不能因为标注失败影响主链）
 * @param status HTTP 状态码
 */
export function annotateDispatchRejection<T>(err: T, status: number): T {
  if (!err || (typeof err !== "object" && typeof err !== "function")) {
    return err;
  }
  try {
    Object.defineProperty(err, DISPATCH_REJECTION_KEY, {
      value: classifyDispatchStatus(status),
      enumerable: false, // 不进 JSON.stringify，不污染既有载荷
      configurable: true,
      writable: true,
    });
  } catch {
    // 冻结对象等极端情形：标注失败绝不影响主链（判据退化为「无判定」）。
  }
  return err;
}

/**
 * 从错误对象上读回判定结果；未标注过则返回 `null`。
 *
 * `null` 的语义是「**本次失败与 HTTP 状态码无关**」（网络错误、超时、
 * 本地校验失败…）⇒ 调用方必须保持既有行为，不得据此拦截重试。
 */
export function readDispatchRejection(
  err: unknown,
): DispatchRejectionVerdict | null {
  if (!err || (typeof err !== "object" && typeof err !== "function")) {
    return null;
  }
  const verdict = (err as Record<symbol, unknown>)[DISPATCH_REJECTION_KEY];
  if (!verdict || typeof verdict !== "object") return null;
  const v = verdict as DispatchRejectionVerdict;
  return typeof v.status === "number" ? v : null;
}
