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
 * Perform an HTTP request against the admin API and strip the global
 * `{ code, message, data }` response envelope.
 */
export async function apiRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_TOKEN}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${method} ${path} → ${res.status}: ${text}`);
  }
  // admin-api applies a global ResponseInterceptor that wraps every
  // successful response in `{ code, message, data }`. Strip the envelope so
  // tool consumers can keep returning the actual payload as-is.
  const raw = (await res.json()) as unknown;
  return unwrap<T>(raw);
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
