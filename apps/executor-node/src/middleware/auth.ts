/**
 * SEC-03: Executor token management with expiration and rotation support.
 * This mirrors the auth.py implementation in executor-python.
 */
import { Request, Response, NextFunction } from 'express';
import axios from 'axios';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config';
import { buildAdminApiUrl } from '../admin-api-url';
import { executorStartupId } from '../startup-identity';
import { unwrapAdminResponseData, adoptExecutorTokenHash } from '../admin-envelope';

// Static token: env vars take priority, then CLI --token arg (via config)
const STATIC_TOKEN = config.token;

export function getStaticToken(): string | null {
  return STATIC_TOKEN || null;
}

// Dynamic token storage (refreshed periodically)
let dynamicToken: string | null = null;
let tokenExpiresAt: Date | null = null;
const TOKEN_REFRESH_INTERVAL = 30 * 60 * 1000; // 30 minutes
let tokenFetchFailedAt: number | null = null;
const TOKEN_FETCH_BACKOFF_MS = 30_000;

// N41: fired (fire-and-forget) after every SUCCESSFUL fetchToken. main.ts
// uses it to re-register with rich metadata when the startup register
// failed — the /token endpoint's register side effect rebuilds the row
// WITHOUT type/capabilities/maxConcurrent/version, and only a real
// register call restores them.
type TokenAcquiredListener = () => void;
let tokenAcquiredListener: TokenAcquiredListener | null = null;

export function setOnTokenAcquired(listener: TokenAcquiredListener | null): void {
  tokenAcquiredListener = listener;
}

function notifyTokenAcquired(): void {
  const listener = tokenAcquiredListener;
  if (!listener) return;
  // Non-blocking: the listener runs outside the token/request path. Errors
  // are swallowed here — the listener owns its retry semantics.
  Promise.resolve()
    .then(listener)
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(`[auth] onTokenAcquired listener failed: ${msg}`);
    });
}

function getAdminApiUrl(): string {
  if (config.adminApiUrlExternal) {
    return config.adminApiUrlExternal;
  }
  if (config.adminApiUrlInternal) {
    return config.adminApiUrlInternal;
  }
  return config.adminApiUrl;
}

async function fetchToken(): Promise<string | null> {
  try {
    const headers: Record<string, string> = {};
    // Issue1 fix: only add Authorization header when token is non-empty
    if (STATIC_TOKEN) {
      headers['Authorization'] = `Bearer ${STATIC_TOKEN}`;
    }

    const response = await axios.post(
      buildAdminApiUrl(getAdminApiUrl(), '/api/executors/token'),
      {
        address: config.executorAddressPublic || config.executorAddress,
        appName: config.appName,
        // R9 (round-8 P1 W2): the process-life identity lets admin-api make
        // this endpoint idempotent — a same-startupId re-fetch returns the
        // CURRENT token instead of rotating (N4 register semantics).
        startupId: executorStartupId,
      },
      { timeout: 10000, headers },
    );

    // R9: the token endpoint is a Nest POST — it answers 201, not 200. The
    // old `=== 200` check silently dropped every successful response.
    if (response.status >= 200 && response.status < 300) {
      // R9 (round-8 P1 root fix): admin-api's global ResponseInterceptor wraps
      // the payload in {code,message,data}. Reading response.data.token
      // directly yielded undefined forever, so every getCurrentToken() call
      // re-hit POST /token — which used to rotate on every call — putting the
      // stored tokenHash on a ~30s rotation cycle and breaking the N26
      // per-execution callback-token invariant (docs/VERIFY-round8-e2e.md §1.5).
      const payload = unwrapAdminResponseData(response.data);
      const token =
        typeof payload?.token === 'string' && payload.token.length > 0
          ? payload.token
          : null;
      if (!token) {
        // eslint-disable-next-line no-console
        console.warn('[auth] fetchToken: admin response carried no token');
        return null;
      }
      // R9 (W3): adopt the tokenHash that matches this token so the HMAC
      // source secret for per-execution callback tokens stays in sync with
      // whatever admin-api currently stores (see admin-envelope.ts).
      adoptExecutorTokenHash(response.data);
      notifyTokenAcquired();
      return token;
    }
  } catch (_err: unknown) {
    // Fall back to static token if dynamic token fetch fails
    // Log at warn level so token refresh failures are visible in diagnostics
    const msg = _err instanceof Error ? _err.message : String(_err);
    // eslint-disable-next-line no-console
    console.warn(`[auth] fetchToken failed: ${msg}`);
  }
  return null;
}

async function refreshTokenIfNeeded(): Promise<void> {
  const now = new Date();
  // Back off after a failed fetch — without this every request hangs for
  // the 10s fetch timeout while admin-api is unreachable.
  if (
    tokenFetchFailedAt !== null &&
    now.getTime() - tokenFetchFailedAt < TOKEN_FETCH_BACKOFF_MS
  ) {
    return;
  }
  // Refresh if no token, expired, or within 5 minutes of expiration
  if (tokenExpiresAt === null || now >= new Date(tokenExpiresAt.getTime() - 5 * 60 * 1000)) {
    const newToken = await fetchToken();
    if (newToken) {
      dynamicToken = newToken;
      tokenExpiresAt = new Date(now.getTime() + TOKEN_REFRESH_INTERVAL);
      tokenFetchFailedAt = null;
    } else {
      tokenFetchFailedAt = now.getTime();
    }
  }
}

export async function verifyToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Try to refresh token if needed
  await refreshTokenIfNeeded();

  // Get valid tokens: dynamic first, then static
  const validTokens: string[] = [];
  if (dynamicToken) {
    validTokens.push(dynamicToken);
  }
  if (STATIC_TOKEN) {
    validTokens.push(STATIC_TOKEN);
  }

  // If no tokens configured at all, allow all requests (dev mode) — unless
  // REQUIRE_TOKEN=true, where fail-closed wins over dev convenience: an
  // unauthenticated /api/execute is arbitrary code execution on this host.
  if (validTokens.length === 0) {
    if (process.env.REQUIRE_TOKEN === 'true') {
      res.status(503).json({ error: 'Executor has no token configured (REQUIRE_TOKEN=true)' });
      return;
    }
    next();
    return;
  }

  const authHeader = req.headers.authorization || '';
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    res.status(401).json({ error: 'Invalid or missing executor token' });
    return;
  }

  const token = parts[1];
  const tokenBuf = Buffer.from(token);
  const matched = validTokens.some((validToken) => {
    const validBuf = Buffer.from(validToken);
    // timingSafeEqual requires same-length buffers; mismatched lengths still reject
    return tokenBuf.length === validBuf.length && timingSafeEqual(tokenBuf, validBuf);
  });
  if (!matched) {
    res.status(401).json({ error: 'Invalid or missing executor token' });
    return;
  }

  next();
}

export async function getCurrentToken(): Promise<string | null> {
  await refreshTokenIfNeeded();
  return dynamicToken || STATIC_TOKEN;
}

/**
 * R10 (round-10 gap #3): force an immediate token re-fetch, bypassing the
 * 30-minute refresh schedule. Used by admin-client when an outbound request
 * comes back 401: the stored per-executor token was rotated out from under
 * this process (e.g. an admin-UI rotate-token), and the only way to converge
 * is to re-hit POST /token — which is authenticated with the STATIC token
 * (shared bootstrap) and whose response fetchToken already uses to adopt the
 * matching tokenHash (R9/W3). So one call here heals BOTH the bearer
 * credential and the N26 per-execution callback HMAC secret.
 *
 * Storm guards: the TOKEN_FETCH_BACKOFF_MS from the last FAILED fetch still
 * applies (admin unreachable / wrong shared token → this degrades to a no-op
 * returning the current token, and the caller must not retry), and
 * admin-api's issueToken is idempotent per (address, startupId), so several
 * concurrent 401s re-fetching at once all converge on the SAME token instead
 * of rotating.
 */
export async function forceTokenRefresh(): Promise<string | null> {
  tokenExpiresAt = null;
  await refreshTokenIfNeeded();
  return dynamicToken;
}
