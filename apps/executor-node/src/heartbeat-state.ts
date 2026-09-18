/**
 * Heartbeat reachability state shared between the scheduler (writer via
 * recordHeartbeat), main.ts (registration verdict via recordRegistration) and
 * the /health endpoints (reader). Kept in its own module so scheduler.ts does
 * not import the route tree, which would pull task execution and its
 * config-dependent initializers into every scheduler import (and create a
 * scheduler <-> health import cycle).
 *
 * CONTRACT（desktop 结构化状态读取端，见 executor-desktop
 * executor-process.ts 的 admin-status 轮询）：/health/admin-status 的
 * `registration` / `heartbeatStatus` 是 desktop 判断「在线/离线」的**唯一
 * 结构化判据**；日志文本推断仅作旧 bundle 的降级回退。语义变更必须与
 * desktop 侧同步（F-2 审查项：日志文案调整不得再让桌面状态推断静默失效）。
 */
let lastHeartbeatTime: string | null = null;
let adminApiReachable: boolean | null = null;
let registration: 'unknown' | 'registered' | 'failed' = 'unknown';
let lastHeartbeatOutcome: 'ok' | 'failed' | 'unknown' = 'unknown';

/** 注册判定（main.ts 在 register 成功/失败处写入；N41 补注册同样走这里）。 */
export function recordRegistration(ok: boolean): void {
  registration = ok ? 'registered' : 'failed';
}

export function recordHeartbeat(success: boolean): void {
  if (success) {
    lastHeartbeatTime = new Date().toISOString();
    lastHeartbeatOutcome = 'ok';
  } else {
    lastHeartbeatOutcome = 'failed';
  }
  adminApiReachable = success;
}

export function setAdminApiReachable(reachable: boolean): void {
  adminApiReachable = reachable;
}

export function getHeartbeatState(): {
  lastHeartbeatTime: string | null;
  adminApiReachable: boolean | null;
} {
  return { lastHeartbeatTime, adminApiReachable };
}

/** F-2: /health/admin-status 的结构化状态视图（desktop 语义解析，非日志文本）。 */
export function getAdminStatus(): {
  registration: 'unknown' | 'registered' | 'failed';
  heartbeatStatus: 'ok' | 'failed' | 'unknown';
  lastHeartbeatTime: string | null;
  adminApiReachable: boolean | null;
} {
  return {
    registration,
    heartbeatStatus: lastHeartbeatOutcome,
    lastHeartbeatTime,
    adminApiReachable,
  };
}

/** 测试钩子：重置结构化状态（对齐 scheduler 的 resetVersionDriftWarnStateForTest 先例）。 */
export function resetAdminStatusForTest(): void {
  lastHeartbeatTime = null;
  adminApiReachable = null;
  registration = 'unknown';
  lastHeartbeatOutcome = 'unknown';
}
