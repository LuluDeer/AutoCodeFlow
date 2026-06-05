/**
 * SEC-03: Executor token management with expiration and rotation support.
 * This mirrors the auth.py implementation in executor-python.
 */
import { Request, Response, NextFunction } from 'express';
import axios from 'axios';
import { config } from '../config';

// Static token for backward compatibility (falls back if dynamic token not available)
const STATIC_TOKEN = process.env.EXECUTOR_SHARED_TOKEN || process.env.EXECUTOR_SECRET || '';

// Dynamic token storage (refreshed periodically)
let dynamicToken: string | null = null;
let tokenExpiresAt: Date | null = null;
const TOKEN_REFRESH_INTERVAL = 30 * 60 * 1000; // 30 minutes

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
      `${getAdminApiUrl()}/api/executors/token`,
      {
        address: config.executorAddressPublic || config.executorAddress,
        appName: process.env.APP_NAME || 'executor-node',
      },
      { timeout: 10000, headers },
    );

    if (response.status === 200) {
      return response.data.token;
    }
  } catch (err) {
    // Fall back to static token if dynamic token fetch fails
  }
  return null;
}

async function refreshTokenIfNeeded(): Promise<void> {
  const now = new Date();
  // Refresh if no token, expired, or within 5 minutes of expiration
  if (tokenExpiresAt === null || now >= new Date(tokenExpiresAt.getTime() - 5 * 60 * 1000)) {
    const newToken = await fetchToken();
    if (newToken) {
      dynamicToken = newToken;
      tokenExpiresAt = new Date(now.getTime() + TOKEN_REFRESH_INTERVAL);
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

  // If no tokens configured at all, allow all requests (dev mode)
  if (validTokens.length === 0) {
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
  if (!validTokens.includes(token)) {
    res.status(401).json({ error: 'Invalid or missing executor token' });
    return;
  }

  next();
}

export async function getCurrentToken(): Promise<string | null> {
  await refreshTokenIfNeeded();
  return dynamicToken || STATIC_TOKEN;
}
