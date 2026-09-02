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

if (!API_TOKEN) {
  process.stderr.write(
    '[autocodeflow-mcp] WARNING: AUTOCODEFLOW_API_TOKEN is not set.\n',
  );
}

/**
 * 请求超时预算（N12）：admin-api 卡死时 MCP 工具不得无限挂起。
 * 导出以便测试注入更短的超时（apiRequest 的 timeoutMs 参数）。
 */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Perform an HTTP request against the admin API and strip the global
 * `{ code, message, data }` response envelope.
 */
export async function apiRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const signal = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_TOKEN}`,
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
