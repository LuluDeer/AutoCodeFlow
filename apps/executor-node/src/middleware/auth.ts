/**
 * SEC-03: Executor token management with expiration and rotation support.
 * This mirrors the auth.py implementation in executor-python.
 */
import { Request, Response, NextFunction } from 'express';
import axios from 'axios';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config';
import { buildAdminApiUrl } from '../admin-api-url';

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
      },
      { timeout: 10000, headers },
    );

    if (response.status === 200) {
      return response.data.token;
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
