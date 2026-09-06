/**
 * HTTP client for the AutoCodeFlow Admin API (used by the MCP server).
 * Kept free of MCP/zod imports so it can be unit-tested in isolation.
 */
import fetch from 'node-fetch';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
export const API_URL = process.env.AUTOCODEFLOW_API_URL || 'http://localhost:3105';
export const API_TOKEN = process.env.AUTOCODEFLOW_API_TOKEN || '';

/**
 * BUG-14 (SEC-01 复审): 可选的 refresh token 自愈。
 *
 * MCP server 是长驻进程，access token 默认 15m 过期——此前过期后所有工具
 * 永久 401，只能重启进程换新 token。设置 AUTOCODEFLOW_API_REFRESH_TOKEN 后：
 * 401（/auth/* 自身除外）触发单飞 POST /auth/refresh，成功则换发并重放原
 * 请求一次；admin-api 的 refresh 是原子轮换（DR-07），响应携带的新
 * refreshToken 保存在内存中供下一次过期使用（进程生命周期内持续自愈；
 * 不落盘——MCP 无凭据存储职责，进程重启重新注入 env）。
 * env 在每次 401 时懒读取，便于测试注入。
 */

/** 请求超时预算（N12）：admin-api 卡死时 MCP 工具不得无限挂起。
 * 导出以便测试注入更短的超时（apiRequest 的 timeoutMs 参数）。 */
export const REQUEST_TIMEOUT_MS = 30_000;

let currentToken = API_TOKEN;
let currentRefreshToken = process.env.AUTOCODEFLOW_API_REFRESH_TOKEN || '';
let refreshInFlight: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  const envRefresh = process.env.AUTOCODEFLOW_API_REFRESH_TOKEN || '';
  const refreshToken = currentRefreshToken || envRefresh;
  if (!refreshToken) return false;
  try {
    const res = await fetch(`${API_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    const data = unwrap<{ accessToken?: string; refreshToken?: string }>(
      await res.json(),
    );
    if (typeof data?.accessToken === 'string' && data.accessToken.length > 0) {
      currentToken = data.accessToken;
      // 原子轮换：新 refreshToken 必须跟进，否则下一次过期刷新必 401
      if (
        typeof data.refreshToken === 'string' &&
        data.refreshToken.length > 0
      ) {
        currentRefreshToken = data.refreshToken;
      }
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Perform an HTTP request against the admin API and strip the global
 * `{ code, message, data }` response envelope.
 */
export async function apiRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
  _retried = false,
): Promise<T> {
  const signal = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${currentToken}`,
      },
      signal,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    // AbortSignal.timeout 触发时 node-fetch 抛 AbortError；以 signal 状态判定，
    // 不依赖错误名在不同实现下的差异。
    if (signal.aborted) {
      const budget = timeoutMs >= 1000 ? `${timeoutMs / 1000}s` : `${timeoutMs}ms`;
      throw new Error(`API request timed out after ${budget}: ${method} ${path}`);
    }
    throw err;
  }
  if (!res.ok) {
    // BUG-13 同款自愈（/_retried 钉死单次重放；/auth/* 自身不触发）
    if (
      res.status === 401 &&
      !_retried &&
      !path.includes('/auth/') &&
      (currentRefreshToken || process.env.AUTOCODEFLOW_API_REFRESH_TOKEN)
    ) {
      refreshInFlight ??= refreshAccessToken().finally(() => {
        refreshInFlight = null;
      });
      const healed = await refreshInFlight;
      if (healed) {
        return apiRequest<T>(method, path, body, timeoutMs, true);
      }
    }
    const text = await res.text();
    throw buildHttpError(method, path, res.status, text);
  }
  // admin-api applies a global ResponseInterceptor that wraps every
  // successful response in `{ code, message, data }`. Strip the envelope so
  // tool consumers can keep returning the actual payload as-is.
  const raw = (await res.json()) as unknown;
  return unwrap<T>(raw);
}

/**
 * Extract the human-readable message from an error body — admin-api errors
 * arrive as `{ code, message, data }` envelopes or NestJS
 * `{ statusCode, message, error }` objects, and class-validator sends
 * `message` as a string[]. Mirrors the CLI's formatApiError copy (N12).
 */
function extractDetail(text: string): string {
  try {
    const d = JSON.parse(text) as Record<string, unknown> | null;
    if (d && typeof d === 'object') {
      const m = d.message;
      if (typeof m === 'string' && m) return m;
      if (Array.isArray(m) && m.length) return m.map(String).join('; ');
      if (typeof d.error === 'string' && d.error) return d.error;
    }
  } catch {
    /* not JSON — fall through to the raw-text fallback */
  }
  return '';
}

function buildHttpError(method: string, path: string, status: number, text: string): Error {
  const detail = extractDetail(text);
  if (!detail) {
    // 解析不出 message 时保持旧行为：透传原始文本，不吞信息。
    return new Error(`API ${method} ${path} → ${status}: ${text}`);
  }
  switch (status) {
    case 401:
      return new Error(
        `Unauthorized (401): ${detail} — token missing, expired or invalid; refresh AUTOCODEFLOW_API_TOKEN (e.g. run "acf login")`,
      );
    case 403:
      return new Error(
        `Forbidden (403): ${detail} — your account is not allowed to perform this operation (some endpoints require the ADMIN role)`,
      );
    default:
      return new Error(`API error (${status}): ${detail}`);
  }
}

/** Strip the `{ code, message, data }` envelope added by the admin-api ResponseInterceptor. */
export function unwrap<T>(raw: unknown): T {
  if (raw && typeof raw === 'object' && 'data' in (raw as Record<string, unknown>)) {
    const envelope = raw as { code?: unknown; message?: unknown; data?: unknown };
    if ('code' in envelope || 'message' in envelope) {
      return (envelope.data ?? (null as unknown)) as T;
    }
  }
  return raw as T;
}

/** Convenience helpers keeping call sites compact and testable. */
export function apiGet<T>(path: string): Promise<T> {
  return apiRequest<T>('GET', path);
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return apiRequest<T>('POST', path, body);
}

export function apiPut<T>(path: string, body?: unknown): Promise<T> {
  return apiRequest<T>('PUT', path, body);
}

export function apiDelete<T>(path: string): Promise<T> {
  return apiRequest<T>('DELETE', path);
}
