/**
 * 派发世代（attemptSeq）的进程内登记表。
 *
 * 单独成模块而不是挂在 callback.ts 上：execute.ts / pull.ts 既有测试用
 * `jest.mock('./callback', () => ({ pushCallback: jest.fn() }))` 只暴露回调入口，
 * 从那里再引入盖章函数会让存量替身缺方法（accept 500）。本模块无副作用、
 * 依赖零，任何装配下都可用。
 *
 * 盖章点仍收口在 callback.ts 的 withExecutorAddress，保证所有回调出口
 * （主路径 / kill / 停机 / pull 拒绝 / 死信重放）都携带同一个派发世代。
 */
const dispatchAttemptSeq = new Map<string, number>();

/** 只接受有限整数（与 protocol.json ExecuteRequest.attemptSeq 的 integer 闸同口径）。 */
export function noteDispatchAttemptSeq(
  executionId: string,
  attemptSeq: unknown,
): void {
  if (typeof attemptSeq === "number" && Number.isInteger(attemptSeq)) {
    dispatchAttemptSeq.set(executionId, attemptSeq);
  }
}

/** 执行终态释放上下文时一并摘除登记，避免长驻进程无界累积。 */
export function forgetDispatchAttemptSeq(executionId: string): void {
  dispatchAttemptSeq.delete(executionId);
}

/** 盖章点读取；未登记返回 undefined，调用方据此完全省略该键。 */
export function getDispatchAttemptSeq(executionId: string): number | undefined {
  return dispatchAttemptSeq.get(executionId);
}
