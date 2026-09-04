import { createHmac, timingSafeEqual } from "crypto";

/**
 * N23: per-execution one-shot callback tokens.
 *
 * Task code running inside an executor subprocess must be able to call back
 * into the Admin API (POST /api/executions/callback) WITHOUT ever seeing the
 * executor shared token (SEC-01 env whitelist). The executor-node mints a
 * short-lived HMAC token bound to a single executionId and injects it into
 * the child process as `AUTOFLOW_CALLBACK_TOKEN`; the Admin API re-derives
 * the same HMAC from its own copy of the secret and verifies it statelessly
 * (no DB round-trip, no new table).
 *
 * Token format (all ASCII, dot-separated):
 *
 *   v1.<executionId>.<expiresAtUnixSec>.<hmacHex>
 *
 *   key      = HMAC-SHA256(secret, "autocodeflow:execution-callback:v1")
 *   hmacHex  = HMAC-SHA256(key, "v1.<executionId>.<expiresAtUnixSec>")
 *
 * The domain-separation step means the HMAC key is never the raw shared
 * token itself, so a leaked signing key cannot be replayed against other
 * HMAC users of the same secret. `secret` is resolved identically on both
 * sides: EXECUTION_CALLBACK_SECRET env when set, otherwise the executor
 * shared token (admin-api additionally accepts the DB-rotated
 * executor.sharedToken as a candidate). N26 (round-8): when every
 * fleet-global candidate fails, admin-api additionally tries the
 * PER-EXECUTOR tokenHash stored for the callback's executorAddress — the
 * executor-node adopts that hash at register time and uses it as its
 * signing secret, so per-node `--secret` deployments verify too.
 *
 * A token authorizes callbacks for EXACTLY its executionId and nothing else;
 * expiry is enforced fail-closed.
 */

export const EXECUTION_CALLBACK_TOKEN_PREFIX = "v1.";
const DOMAIN_SEPARATOR = "autocodeflow:execution-callback:v1";
const SIG_HEX_LENGTH = 64;

export interface ExecutionCallbackTokenClaims {
  executionId: string;
  /** Unix seconds at which the token stops being accepted. */
  expiresAtSec: number;
}

/** Derive the per-secret signing key (domain-separated from the raw secret). */
function deriveSigningKey(secret: string): Buffer {
  return createHmac("sha256", secret).update(DOMAIN_SEPARATOR).digest();
}

/** Compute the hex signature over the token's signed payload. */
function computeSignature(secret: string, payload: string): string {
  return createHmac("sha256", deriveSigningKey(secret))
    .update(payload)
    .digest("hex");
}

/**
 * Mint a per-execution callback token. Exported for tests and for any
 * server-side tooling; the production signer lives in executor-node and
 * uses this exact algorithm (pinned by a shared test vector on both sides).
 */
export function signExecutionCallbackToken(
  secret: string,
  executionId: string,
  expiresAtSec: number,
): string {
  const payload = `${EXECUTION_CALLBACK_TOKEN_PREFIX}${executionId}.${expiresAtSec}`;
  return `${payload}.${computeSignature(secret, payload)}`;
}

/**
 * Structural parse only — NO signature check. Returns null for anything
 * that is not a well-formed `v1.` token (i.e. not a per-execution token,
 * so callers fall through to the legacy shared-token path).
 */
export function parseExecutionCallbackToken(
  token: string,
): ExecutionCallbackTokenClaims | null {
  if (!token.startsWith(EXECUTION_CALLBACK_TOKEN_PREFIX)) return null;
  const body = token.slice(EXECUTION_CALLBACK_TOKEN_PREFIX.length);
  const parts = body.split(".");
  if (parts.length !== 3) return null;
  const [executionId, expRaw, sig] = parts;
  if (!executionId || executionId.includes(" ")) return null;
  if (!/^\d+$/.test(expRaw)) return null;
  if (!/^[0-9a-f]{64}$/.test(sig)) return null;
  return { executionId, expiresAtSec: parseInt(expRaw, 10) };
}

function safeHexEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Verify a per-execution callback token against a list of candidate
 * secrets (tried in order; first structural match wins). Fail-closed:
 * malformed, expired, or unsigned-by-any-candidate tokens return null.
 *
 * @returns the embedded claims when valid, null otherwise.
 */
export function verifyExecutionCallbackToken(
  token: string,
  candidateSecrets: string[],
  nowSec: number = Math.floor(Date.now() / 1000),
): ExecutionCallbackTokenClaims | null {
  const claims = parseExecutionCallbackToken(token);
  if (!claims) return null;
  if (!Number.isFinite(claims.expiresAtSec) || claims.expiresAtSec <= nowSec) {
    return null;
  }
  const payload = token.slice(0, token.lastIndexOf("."));
  const sig = token.slice(token.lastIndexOf(".") + 1);
  if (sig.length !== SIG_HEX_LENGTH) return null;
  for (const secret of candidateSecrets) {
    if (!secret) continue;
    if (safeHexEqual(computeSignature(secret, payload), sig)) {
      return claims;
    }
  }
  return null;
}
