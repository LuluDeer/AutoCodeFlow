import { AxiosResponse, AxiosError } from 'axios';
import { logger } from './logger';
import { getCurrentToken, getStaticToken, forceTokenRefresh } from './middleware/auth';
import { normalizeAdminApiBaseUrl } from './admin-api-url';
import {
  sharedAxios,
  MIN_ATTEMPTS,
  RETRY_BACKOFF_MS,
  DEFAULT_TIMEOUT_MS,
  httpStatusOf,
  isTransientServerError,
} from './admin-http-agent';

// NETOPT-G P1-1：共享 axios 实例（含 keepAlive 的 http/https agent）现由
// `admin-http-agent.ts` 提供——因为执行器对 admin 有**两条**独立调用路径
// （本模块 + middleware/auth.ts::fetchToken），只修一处会漏掉令牌获取那条。
// 详见该模块注释。

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
        await sharedAxios.get(`${url}/api/health`, { timeout: timeoutMs });
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

/** True when the failure is the caller aborting its own request (E-07 shutdown
 *  abort of an in-flight long poll) rather than a transport fault. */
function isAborted(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error as AxiosError | undefined)?.code === 'ERR_CANCELED';
}

async function performRequest<T = any>(
  token: string | null,
  method: 'get' | 'post' | 'put' | 'delete',
  path: string,
  data?: Record<string, any>,
  retryCount: number = adminUrls.length,
  extraHeaders?: Record<string, string>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<AxiosResponse<T>> {
  const headers = extraHeaders
    ? { ...buildAuthHeaders(token), ...extraHeaders }
    : buildAuthHeaders(token);

  // NETOPT-G P1-2（单 admin 场景的重试下限）：retryCount 默认取
  // adminUrls.length——HA 部署（≥2 台）下 failover 本身即重试；但**单台
  // admin 时 retryCount=1，循环只跑一次：任何一次瞬时抖动（跨境链路上
  // `socket hang up` / TLS 握手中断 / 读超时）都会直接上抛
  // "All 1 admin servers are unavailable"，心跳被记成失败。
  //
  // 这不是理论问题：生产日志里 4.5% 的心跳（80/1759）就是这样失败的，而
  // 中台判死阈值是 90s——连续的瞬时失败会把执行器推成 OFFLINE，进而
  // dispatch() 不再给它派任务（executor.service.ts 只选 ONLINE）。
  //
  // 修复口径（**严格保持 HA 语义**）：总尝试次数 = max(retryCount, 1 台的
  // 补偿次数)。即
  //   - 多台（retryCount = N ≥ 2）：**逐字不变**——每台恰好试一次，总次数 N。
  //     用 Math.max(retryCount, MIN_ATTEMPTS) 是错的：2 台会变成 3 次，
  //     破坏"每副本一次"的既有契约（既有测试 `All 2 admin servers` 的调用
  //     次数断言即为此设）。
  //   - 单台（retryCount = 1）：把同一台重复试到 MIN_ATTEMPTS 次。
  // 重复尝试对幂等面（GET/心跳/register/callback）安全；对非幂等面（post
  // 任务派发）网络层失败本身即无副作用（对端未收到或已幂等处理）。
  const effectiveRetryCount =
    adminUrls.length <= 1 ? Math.max(retryCount, MIN_ATTEMPTS) : retryCount;

  for (let i = 0; i < effectiveRetryCount; i++) {
    try {
      const response = await sharedAxios.request({
        method,
        url: `${adminUrls[currentIndex]}${path}`,
        data,
        timeout: timeoutMs,
        headers,
        // E-07: 仅在调用方显式传入 signal 时才挂上（保持其余调用的请求形状
        // 逐字节不变，避免无谓的契约面扩大）。
        ...(signal ? { signal } : {}),
      });

      return response;
    } catch (error: any) {
      // E-07: 调用方主动中止（停机 abort 在飞长轮询）不是连通性故障——既不
      // 能 failover 重试（同一个已 aborted 的 signal 会立刻再拒一次，白烧
      // 500ms 退避 ×N），也不能记成 warn 噪声。直接上抛，由调用方按「预期
      // 中止」处理。
      if (isAborted(error, signal)) throw error;

      // R10 (round-10 gap #3): a 401 is an auth verdict, not a connectivity
      // failure — every admin replica reads the same DB, so failing over
      // cannot turn it valid. Surface it to request()'s re-auth handling
      // instead of burning the failover retries (and the 500ms sleeps) on it.
      if (isUnauthorized(error)) throw error;

      // NETOPT-G P1-3（5xx 快速重试）：admin-api 应用层故障（生产实测 16 次
      // 502/500，来自 Pod 重启/DB 连接池耗尽）与网络抖动同属**瞬时**故障，
      // 且同样会被记成心跳失败。4xx（除 401）是确定性拒绝，重试无益——不
      // 在此列（保持既有"立即上抛"语义，避免把配置类错误拖成重试风暴）。
      const status = httpStatusOf(error);
      const transientServerError = isTransientServerError(error);
      // 非 5xx 的 HTTP **应答**（4xx 等确定性拒绝）：重试无益且会掩盖真实
      // 状态码。旧实现把它吞成 `All N admin servers are unavailable`，调用方
      // 与运维都看不到"其实是 400/403"——排障时被误导去查网络。直接上抛原
      // 错误（保留 response.status），与 401 的处理同口径。
      const isDeterministicClientError =
        typeof status === 'number' && !transientServerError;

      if (isDeterministicClientError) throw error;

      logger.warn(
        `Request to admin ${adminUrls[currentIndex]} failed: ${error.message}` +
          (transientServerError ? ` (transient ${status}, will retry)` : ''),
      );

      if (i < effectiveRetryCount - 1) {
        // failover 只在**多台** admin 时才有意义：单台时 failover() 会把
        // currentIndex 取模回自己（日志会误导性地打印"Failed over to ..."
        // 同一地址）。单台场景退化为对同一台的退避重试。
        if (adminUrls.length > 1) {
          failover();
        }
        await new Promise(resolve => setTimeout(resolve, RETRY_BACKOFF_MS));
      } else if (transientServerError) {
        // 5xx 重试耗尽：保留最后一次的 response 形状（而不是把它抹成"服务器
        // 不可用"），让上层心跳/回调日志能显示真实状态码。
        throw error;
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
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<AxiosResponse<T>> {
  const token = tokenMode === 'static' ? getStaticToken() : await getCurrentToken();
  try {
    return await performRequest<T>(
      token,
      method,
      path,
      data,
      retryCount,
      extraHeaders,
      timeoutMs,
      signal,
    );
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
        return performRequest<T>(
          fresh,
          method,
          path,
          data,
          retryCount,
          extraHeaders,
          timeoutMs,
          signal,
        );
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

/**
 * ARCH-32: 长轮询专用 POST —— 服务端 /executors/pull 会阻塞至多
 * EXECUTOR_PULL_WAIT_MS（默认 25s），10s 默认超时必然误杀；40s 覆盖
 * 25s 窗口 + 余量，且小于反代通用 60s 读超时。
 *
 * E-07: 可选 `signal` —— 停机时调用方 abort 在飞长轮询，使服务端阻塞窗口
 * 立即结束，而不是「已 clearInterval 但窗口内的任务仍会被领取」。
 */
export async function postLong<T = any>(
  path: string,
  data?: Record<string, any>,
  timeoutMs = 40_000,
  signal?: AbortSignal,
): Promise<AxiosResponse<T>> {
  return request('post', path, data, adminUrls.length, 'current', undefined, timeoutMs, signal);
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