/**
 * Thin HTTP client wrapper for the AutoCodeFlow Admin API.
 */
import axios, { AxiosInstance, AxiosError } from 'axios';
import { getApiUrl, getToken } from './config';

let _client: AxiosInstance | null = null;

function getClient(): AxiosInstance {
  if (!_client) {
    _client = axios.create({
      baseURL: getApiUrl(),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getToken()}`,
      },
      timeout: 30_000,
    });
  }
  return _client;
}

/** Reset client (needed after config changes in same process). */
export function resetClient(): void {
  _client = null;
}

// The admin-api applies a global ResponseInterceptor that wraps every
// successful response in `{ code, message, data }`. Mirror admin-web's
// client and strip that envelope so callers can keep using `data.list`,
// `data.total`, etc. without unwrapping manually.
export function unwrap<T>(raw: unknown): T {
  if (raw && typeof raw === 'object' && 'data' in (raw as Record<string, unknown>)) {
    const envelope = raw as { code?: unknown; data?: unknown };
    if ('code' in envelope || 'message' in envelope) {
      return (envelope.data ?? (null as unknown)) as T;
    }
  }
  return raw as T;
}

export async function get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const r = await getClient().get<unknown>(path, { params });
  return unwrap<T>(r.data);
}

export async function post<T>(path: string, body?: unknown): Promise<T> {
  const r = await getClient().post<unknown>(path, body);
  return unwrap<T>(r.data);
}

export async function put<T>(path: string, body?: unknown): Promise<T> {
  const r = await getClient().put<unknown>(path, body);
  return unwrap<T>(r.data);
}

export async function patch<T>(path: string, body?: unknown): Promise<T> {
  const r = await getClient().patch<unknown>(path, body);
  return unwrap<T>(r.data);
}

export async function del<T>(path: string): Promise<T> {
  const r = await getClient().delete<unknown>(path);
  return unwrap<T>(r.data);
}

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------
// The API returns errors as `{ statusCode, message, error }` (NestJS) or the
// `{ code, message, data }` envelope. class-validator may send `message` as a
// string[]. Axios itself only surfaces "Request failed with status code 400",
// so without this helper the actual cause never reaches the terminal.

function detailFromData(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const d = data as Record<string, unknown>;
  const m = d.message;
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) return m.map(String).join('; ');
  if (typeof d.error === 'string') return d.error;
  return '';
}

/**
 * Render any thrown error as a single readable line, distinguishing
 * 401 (not authenticated) from 403 (authenticated but not allowed) and
 * surfacing the backend message instead of axios' generic text.
 */
export function formatApiError(e: unknown): string {
  if (axios.isAxiosError(e)) {
    const err = e as AxiosError;
    const status = err.response?.status;
    const detail = detailFromData(err.response?.data);
    switch (status) {
      case 400:
        return `Bad request (400): ${detail || 'invalid parameters — the API rejects fields not declared in its DTO whitelist'}`;
      case 401:
        return `Unauthorized (401): ${detail || 'token missing, expired or invalid'} — run "acf login" or pass --token / set ACF_TOKEN`;
      case 403:
        return `Forbidden (403): ${detail || 'your account is not allowed to perform this operation (some endpoints require the ADMIN role)'}`;
      case 404:
        return `Not found (404): ${detail || 'resource does not exist'}`;
      case 409:
        return `Conflict (409): ${detail || 'resource already exists'}`;
      default:
        if (status) {
          return `API error (${status}): ${detail || err.message}`;
        }
        return `Network error: ${err.message} (is the API reachable at ${getApiUrl()}?)`;
    }
  }
  return e instanceof Error ? e.message : String(e);
}
