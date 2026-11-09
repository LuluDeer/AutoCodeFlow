/**
 * R44（2026-11-05）：`execute` 主链的**第一个接缝** —— 熔断结果记录器。
 *
 * ## 为什么先抽它（见 `artifacts/autonomy/R44/seam-facts.md`）
 * · 调用点只有 **2 处**，且都在 `execute` 内（失败 `recordOutcome(...,false)` / 成功 `(...,!isError)`）；
 * · **不参与**审批 `consume` 的事务边界（拆了不破坏原子性）；
 * · 只有 3 个标量参数、`void` 返回、不与主链共享可变状态。
 * ⇒ 是 `approvals` / `sessions` / `boundary` 里**耦合最浅**的一处。
 *
 * 接口化的意义：把"记录结果"从「直接持有 `AgentBoundaryService`」收窄成一个 3 参数的小协议，
 * 主链不再需要知道熔断器的全部方法面；测试也能用 spy 直接证明**接缝真的在必经路径上**。
 */

/** 熔断/边界的结果记录（`ok=false` ⇒ 计入连续失败）。 */
export interface OutcomeRecorder {
  recordOutcome(sessionId: string, toolName: string, ok: boolean): void;
}

/** 生产实现：委托给既有的 `AgentBoundaryService.recordOutcome`（行为逐字不变）。 */
export function createBoundaryOutcomeRecorder(boundary: {
  recordOutcome(sessionId: string, toolName: string, ok: boolean): void;
}): OutcomeRecorder {
  return {
    recordOutcome(sessionId, toolName, ok) {
      boundary.recordOutcome(sessionId, toolName, ok);
    },
  };
}
