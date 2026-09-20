/**
 * Executor shutdown state shared between main.ts (writer) and the route tree
 * (reader). Kept in its own module so routes/execute.ts can consult the flag
 * without importing main.ts — a main <-> routes import would pull server
 * startup into every route import and create a cycle.
 *
 * NETOPT-9-1: the graceful-drain window used to be invisible to
 * acceptExecution — a push POST /execute arriving on an already-established
 * keep-alive connection during the 30s drain was still accepted with 200 and
 * registered into liveExecutions, only to be SIGKILLed when the grace expired
 * (final callback likely lost, admin left with a zombie RUNNING row). The
 * accept guard in routes/execute.ts consults this flag and returns 503 before
 * touching the capacity ledger.
 */
let shuttingDown = false;

export function isExecutorShuttingDown(): boolean {
  return shuttingDown;
}

export function setExecutorShuttingDown(value: boolean): void {
  shuttingDown = value;
}

/** Test hook (mirrors heartbeat-state's resetAdminStatusForTest). */
export function resetShutdownStateForTest(): void {
  shuttingDown = false;
}
