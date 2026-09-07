import axios, { AxiosInstance, AxiosResponse, AxiosError } from 'axios';
import { config } from './config';
import { logger } from './logger';
import { getCurrentToken, getStaticToken, forceTokenRefresh } from './middleware/auth';
import { normalizeAdminApiBaseUrl } from './admin-api-url';

let adminUrls: string[] = [];
let currentIndex = 0;

export function initAdminClients(urls: string[]): void {
  adminUrls = urls.map(normalizeAdminApiBaseUrl).filter(Boolean);
  currentIndex = 0;
  if (adminUrls.length === 0) {
    throw new Error('No admin URLs configured');
  }
  logger.info(`Initialized ${adminUrls.length} admin server(s): ${adminUrls.join(', ')}`);
}

export function getCurrentAdminUrl(): string {
  return adminUrls[currentIndex];
}

export function getAllAdminUrls(): string[] {
  return [...adminUrls];
}

export function failover(): void {
  currentIndex = (currentIndex + 1) % adminUrls.length;
  logger.warn(`Failed over to admin server: ${adminUrls[currentIndex]}`);
}

export interface AdminApiConnectivityCheckOptions {
  attempts?: number;
  initialDelayMs?: number;
  timeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function checkAdminApiConnectivity(
  options: AdminApiConnectivityCheckOptions = {},
): Promise<boolean> {
  const attempts = options.attempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 5_000;
  let delayMs = options.initialDelayMs ?? 1_000;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    for (let i = 0; i < adminUrls.length; i++) {
      const url = adminUrls[i];
      try {
        await axios.get(`${url}/api/health`, { timeout: timeoutMs });
        currentIndex = i;
        logger.info(`Admin API connectivity check succeeded: ${url}`);
        return true;
      } catch (error: unknown) {
        logger.warn(
          `Admin API connectivity check failed for ${url} (attempt ${attempt}/${attempts}): ${getErrorMessage(error)}`,
        );
      }
    }

    if (attempt < attempts) {
      logger.warn(`Admin API is not reachable yet; retrying in ${delayMs}ms`);
      await sleep(delayMs);
      delayMs *= 2;
    }
  }

  logger.warn(
    'Admin API connectivity check failed after startup retries; executor will continue and heartbeat will retry in the background.',
  );
  return false;
}

type TokenMode = 'current' | 'static';

function buildAuthHeaders(token: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (token) {
    // Use X-Executor-Token for admin-api heartbeat/callback endpoints
    headers['X-Executor-Token'] = token;
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

/** True when the error is an HTTP 401 ANSWER from admin-api (as opposed to a
 *  connect/timeout failure). Only meaningful for errors thrown by performRequest. */
function isUnauthorized(error: unknown): boolean {
  return (error as AxiosError | undefined)?.response?.status === 401;
}

async function performRequest<T = any>(
  token: string | null,
  method: 'get' | 'post' | 'put' | 'delete',
  path: string,
  data?: Record<string, any>,
  retryCount: number = adminUrls.length,
  extraHeaders?: Record<string, string>,
): Promise<AxiosResponse<T>> {
  const headers = extraHeaders
    ? { ...buildAuthHeaders(token), ...extraHeaders }
    : buildAuthHeaders(token);

  for (let i = 0; i < retryCount; i++) {
    try {
      const client: AxiosInstance = axios.create({
        baseURL: adminUrls[currentIndex],
        timeout: 10_000,
        headers,
      });

      const response = await client.request({
        method,
        url: path,
        data,
      });

      return response;
    } catch (error: any) {
      // R10 (round-10 gap #3): a 401 is an auth verdict, not a connectivity
      // failure — every admin replica reads the same DB, so failing over
      // cannot turn it valid. Surface it to request()'s re-auth handling
      // instead of burning the failover retries (and the 500ms sleeps) on it.
      if (isUnauthorized(error)) throw error;

      logger.warn(`Request to admin ${adminUrls[currentIndex]} failed: ${error.message}`);

      if (i < retryCount - 1) {
        failover();
        await new Promise(resolve => setTimeout(resolve, 500));
      } else {
        throw new Error(`All ${adminUrls.length} admin servers are unavailable`);
      }
    }
  }

  throw new Error('Request failed after all retries');
}

export async function request<T = any>(
  method: 'get' | 'post' | 'put' | 'delete',
  path: string,
  data?: Record<string, any>,
  retryCount: number = adminUrls.length,
  tokenMode: TokenMode = 'current',
  extraHeaders?: Record<string, string>,
): Promise<AxiosResponse<T>> {
  const token = tokenMode === 'static' ? getStaticToken() : await getCurrentToken();
  try {
    return await performRequest<T>(token, method, path, data, retryCount, extraHeaders);
  } catch (error) {
    // R10 (round-10 gap #3): stale-credential self-heal. A 401 on a
    // dynamic-token request means admin-api rotated our per-executor token
    // out from under us — the direct path is the admin-UI "rotate token"
    // button (POST /executors/:id/rotate-token), after which our bearer AND
    // our adopted tokenHash (the N26 per-execution callback HMAC secret) are
    // both stale. Without this heal the heartbeat keeps 401ing until the
    // 30-minute scheduled refresh, the executor gets marked OFFLINE after
    // 3 missed intervals, and task callbacks 401 the whole time.
    //
    // forceTokenRefresh() re-hits POST /token with the STATIC token and, via
    // fetchToken's envelope handling, adopts BOTH the fresh token and the
    // matching tokenHash in one round-trip — then we retry the original
    // request once. Storm guards: exactly one auth retry per request (a
    // second 401 propagates), forceTokenRefresh degrades to a no-op while
    // the 30s fetch-failure backoff is active, and admin-api's issueToken is
    // idempotent per (address, startupId) so concurrent 401s converge on the
    // same token instead of rotating.
    if (tokenMode === 'current' && isUnauthorized(error)) {
      const fresh = await forceTokenRefresh();
      if (fresh && fresh !== token) {
        return performRequest<T>(fresh, method, path, data, retryCount, extraHeaders);
      }
    }
    throw error;
  }
}

export async function get<T = any>(path: string): Promise<AxiosResponse<T>> {
  return request('get', path);
}

export async function post<T = any>(
  path: string,
  data?: Record<string, any>,
  extraHeaders?: Record<string, string>,
): Promise<AxiosResponse<T>> {
  return request('post', path, data, adminUrls.length, 'current', extraHeaders);
}

export async function postWithStaticToken<T = any>(path: string, data?: Record<string, any>): Promise<AxiosResponse<T>> {
  return request('post', path, data, adminUrls.length, 'static');
}

export async function put<T = any>(path: string, data?: Record<string, any>): Promise<AxiosResponse<T>> {
  return request('put', path, data);
}

export async function del<T = any>(path: string): Promise<AxiosResponse<T>> {
  return request('delete', path);
}