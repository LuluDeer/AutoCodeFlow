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

export async function get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const r = await getClient().get<T>(path, { params });
  return r.data;
}

export async function post<T>(path: string, body?: unknown): Promise<T> {
  const r = await getClient().post<T>(path, body);
  return r.data;
}

export async function patch<T>(path: string, body?: unknown): Promise<T> {
  const r = await getClient().patch<T>(path, body);
  return r.data;
}

export async function del<T>(path: string): Promise<T> {
  const r = await getClient().delete<T>(path);
  return r.data;
}
