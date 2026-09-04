/**
 * Heartbeat reachability state shared between the scheduler (writer via
 * recordHeartbeat) and the /health endpoint (reader). Kept in its own module
 * so scheduler.ts does not import the route tree, which would pull task
 * execution and its config-dependent initializers into every scheduler
 * import (and create a scheduler <-> health import cycle).
 */
let lastHeartbeatTime: string | null = null;
let adminApiReachable: boolean | null = null;

export function recordHeartbeat(success: boolean): void {
  if (success) lastHeartbeatTime = new Date().toISOString();
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
