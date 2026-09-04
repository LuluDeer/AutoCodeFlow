/**
 * R9 (round-8 P1 closure): admin-api response-envelope helpers.
 *
 * The admin-api applies a global ResponseInterceptor that wraps every
 * successful response in `{ code, message, data }` (see
 * apps/admin-api/src/common/interceptors/response.interceptor.ts). The
 * executor's own HTTP helpers must strip that envelope before reading
 * fields — the same `unwrap()` pattern already used by acf-cli
 * (packages/acf-cli/src/client.ts) and mcp-server
 * (packages/mcp-server/src/api.ts). Reading `response.data.token` directly
 * yields `undefined` on every enveloped response: that bug made
 * middleware/auth.ts fetch a fresh token every 30s, and because the token
 * endpoint rotated on every call it put the DB tokenHash on a ~30s rotation
 * cycle that broke the N26 per-execution callback-token invariant
 * (docs/VERIFY-round8-e2e.md §1.5).
 */
import { config } from './config';

/**
 * Unwrap the `{ code, message, data }` envelope added by the admin-api
 * ResponseInterceptor. Bare (non-enveloped) payloads — older admins, direct
 * service calls, unit-test fixtures — are returned as-is, so callers can
 * read `token`/`tokenHash` from either shape.
 */
export function unwrapAdminResponseData(raw: unknown): Record<string, any> | null {
  if (raw && typeof raw === 'object' && 'data' in (raw as Record<string, unknown>)) {
    const envelope = raw as { code?: unknown; message?: unknown; data?: unknown };
    if ('code' in envelope || 'message' in envelope) {
      return (envelope.data ?? null) as Record<string, any> | null;
    }
  }
  return raw as Record<string, any> | null;
}

/**
 * N26/W3 adoption: if an admin-api response (register, POST /token, or
 * heartbeat) carries the executor's current stored `tokenHash`, refresh
 * `config.executorTokenHash` so the per-execution callback-token HMAC key
 * follows admin-side rotations instead of going stale. Accepts both the
 * enveloped and the bare response shape. No-op when the field is absent.
 */
export function adoptExecutorTokenHash(raw: unknown): void {
  const payload = unwrapAdminResponseData(raw);
  const tokenHash = payload?.tokenHash;
  if (typeof tokenHash === 'string' && tokenHash) {
    config.executorTokenHash = tokenHash;
  }
}
