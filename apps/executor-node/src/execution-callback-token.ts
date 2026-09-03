/**
 * N23: per-execution one-shot callback tokens (executor-node side).
 *
 * Task code spawned by this executor must be able to call back into the
 * Admin API (POST /api/executions/callback) WITHOUT ever seeing the
 * executor shared token — SEC-01 keeps EXECUTOR_SHARED_TOKEN /
 * EXECUTOR_SECRET out of child environments. Instead, the executor mints a
 * short-lived HMAC token bound to a single executionId and injects it as
 * `AUTOFLOW_CALLBACK_TOKEN` via the explicit extra-env channel in
 * execute.ts (never via the process.env whitelist).
 *
 * Token format (must stay byte-for-byte compatible with admin-api's
 * apps/admin-api/src/modules/task/execution-callback-token.util.ts —
 * pinned by an identical test vector in both suites):
 *
 *   v1.<executionId>.<expiresAtUnixSec>.<hmacHex>
 *
 *   key      = HMAC-SHA256(secret, "autocodeflow:execution-callback:v1")
 *   hmacHex  = HMAC-SHA256(key, "v1.<executionId>.<expiresAtUnixSec>")
 *
 * `secret` resolution order (N26, round-8):
 *   1. EXECUTION_CALLBACK_SECRET — fleet-wide dedicated HMAC secret;
 *   2. the per-executor tokenHash admin-api returned at register time
 *      (config.executorTokenHash, adopted in main.ts) — lets nodes
 *      installed with their own `--secret` mint tokens the admin can
 *      verify against the exact hash it stores;
 *   3. the executor shared token (config.token) — legacy fallback for
 *      admins that only know the shared secret.
 * The domain-separation step means the raw shared token is never used
 * directly as an HMAC key, and a per-execution token can never be forged
 * into a shared token.
 *
 * INVARIANT: the signing secret must equal admin-api's current stored
 * tokenHash. R9 (round-8 P1 closure) keeps the two in sync: the executor
 * adopts the admin-returned tokenHash at register, on every POST /token
 * fetch (middleware/auth.ts fetchToken) and on every heartbeat
 * (scheduler.sendHeartbeat) — see admin-envelope.ts adoptExecutorTokenHash.
 * A rotation performed directly in the admin UI is picked up by the
 * executor on its next heartbeat (≤ heartbeatIntervalSeconds); tokens
 * minted before that pickup fail verification — documented in
 * docs/sdk-guide.md.
 */
import * as crypto from 'crypto';
import { config } from './config';

const DOMAIN_SEPARATOR = 'autocodeflow:execution-callback:v1';

export const EXECUTION_CALLBACK_TOKEN_PREFIX = 'v1.';

/** Extra lifetime beyond the task timeout so a task finishing right at the
 *  deadline can still deliver its final callback. */
export const CALLBACK_TOKEN_GRACE_SECONDS = 900;

/** Secret used to derive per-execution callback tokens: dedicated env
 *  first, then the per-executor tokenHash received at register time
 *  (N26), then the executor shared token the node already holds. */
export function resolveCallbackSecret(): string {
  const cfg = config as {
    executionCallbackSecret?: string;
    executorTokenHash?: string;
    token?: string;
  };
  return cfg.executionCallbackSecret || cfg.executorTokenHash || cfg.token || '';
}

function computeSignature(secret: string, payload: string): string {
  const key = crypto
    .createHmac('sha256', secret)
    .update(DOMAIN_SEPARATOR)
    .digest();
  return crypto.createHmac('sha256', key).update(payload).digest('hex');
}

/** Sign a token for (executionId, expiresAtSec) with an explicit secret. */
export function signExecutionCallbackToken(
  secret: string,
  executionId: string,
  expiresAtSec: number,
): string {
  const payload = `${EXECUTION_CALLBACK_TOKEN_PREFIX}${executionId}.${expiresAtSec}`;
  return `${payload}.${computeSignature(secret, payload)}`;
}

/**
 * Mint a per-execution callback token valid for `ttlSeconds`.
 * Returns null when no secret is configured (dev executors without a
 * token) — callers then simply omit AUTOFLOW_CALLBACK_TOKEN and the SDK
 * stays in its disabled state, exactly as before N23.
 */
export function createExecutionCallbackToken(
  executionId: string,
  ttlSeconds: number,
  secret: string = resolveCallbackSecret(),
): string | null {
  if (!secret || !executionId) return null;
  const ttl = Math.max(1, Math.floor(ttlSeconds));
  const expiresAtSec = Math.floor(Date.now() / 1000) + ttl;
  return signExecutionCallbackToken(secret, executionId, expiresAtSec);
}
