/**
 * R16（2026-11-05）：心跳的 `runningTaskCount` 采纳规则（纯判定，无 IO）。
 *
 * ## 缺陷（真机两连接复现 20/20 轮）
 *
 * 心跳是**客户端快照覆盖写**（`executor-heartbeat-report.collaborator.ts:192-210` 只做范围校验），
 * 派发是**原子 `+1` 带容量谓词**（`executor-dispatch-slot.collaborator.ts:105-118`）。
 * 心跳从 `findOne` 到 `repo.update` 之间隔着若干 await；窗口内落地的派发占坑会被覆盖写抹掉
 * ⇒ 计数被改小 ⇒ `runningTaskCount < max` 放行超额 ⇒ **超卖**。
 *
 * ## 规则
 *
 * `采用值 = max(客户端上报值, 服务端在途占坑数)`，其中在途 = 该执行器名下**非终态**执行行
 * （`pending` / `running` / `waiting`，见 `task/execution-terminal.ts:45-49` 的 OPEN 集合）。
 *
 * · **取大**而不是丢弃客户端值：客户端值是执行器对自身占用的唯一自述（它还跑着中心端不知道的
 *   子进程/本地任务），服务端执行行只覆盖"中心端派出去的那些"。
 * · **取大**仍能降计数：执行终态化后服务端在途数随之下降 ⇒ 下一轮心跳可把计数拉回真实值，
 *   不会出现"计数只增不降"的饥饿态（I2）。
 */
export function resolveHeartbeatRunningTaskCount(input: {
  reported: number;
  serverInFlight: number;
}): { value: number; clamped: boolean } {
  const reported = Number.isFinite(input.reported) ? input.reported : 0;
  const inFlight = Number.isFinite(input.serverInFlight) ? input.serverInFlight : 0;
  if (inFlight > reported) return { value: inFlight, clamped: true };
  return { value: reported, clamped: false };
}
