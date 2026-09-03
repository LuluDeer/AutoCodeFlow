/**
 * R9 (round-8 P1 closure): the executor's process-life identity.
 *
 * `startupId` is the idempotency key admin-api uses to tell "same process
 * re-fetching its token" apart from "a restarted executor" (N4 register
 * semantics, now extended to POST /api/executors/token). It lives in its own
 * module because middleware/auth.ts needs it for the token request body, and
 * importing it from scheduler.ts would create a cycle:
 *   auth -> scheduler -> admin-client -> auth
 * (the same reason heartbeat-state.ts exists — see its header comment).
 *
 * scheduler.ts re-exports both constants so existing importers (main.ts,
 * specs) keep working unchanged.
 */
import { randomUUID } from 'crypto';

export const executorStartedAt = new Date().toISOString();
export const executorStartupId = randomUUID();
