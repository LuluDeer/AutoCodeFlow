/**
 * Thin HTTP client wrapper for the AutoCodeFlow Admin API.
 */
import axios, { AxiosInstance } from 'axios';
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
function unwrap<T>(raw: unknown): T {
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

export async function patch<T>(path: string, body?: unknown): Promise<T> {
  const r = await getClient().patch<unknown>(path, body);
  return unwrap<T>(r.data);
}

export async function del<T>(path: string): Promise<T> {
  const r = await getClient().delete<unknown>(path);
  return unwrap<T>(r.data);
}
