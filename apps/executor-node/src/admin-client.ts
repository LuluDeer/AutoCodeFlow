import axios, { AxiosInstance, AxiosResponse, AxiosError } from 'axios';
import http from 'http';
import https from 'https';
import { logger } from './logger';
import { getCurrentToken, getStaticToken, forceTokenRefresh } from './middleware/auth';
import { normalizeAdminApiBaseUrl } from './admin-api-url';

// O-23: previously performRequest called axios.create() on every invocation
// (and again on every failover retry). Each factory call produced a brand-new
// client with a fresh connection pool — the keep-alive socket was discarded
// when the response returned, so every heartbeat / long-poll round-trip paid a
// fresh TCP handshake (and on TLS endpoints a full TLS re-handshake). A single
// long-lived instance with a keepAlive agent reuses sockets across all requests
// and replicas. Per-request baseURL (failover), timeout (default 20s vs 40s
// long-poll), headers (static vs current token) are still supplied in
// client.request() so the existing retry/failover/auth semantics stay
// byte-for-byte identical.
const sharedHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 32 });

/**
 * NETOPT-G P1-1（跨境链路韧性）：**必须**显式提供 httpsAgent。
 *
 * 旧实现只设了 `httpAgent`——而生产/桌面部署的 admin URL 是 `https://`
 * （例如 `https://redirct.yskj.cc.cd`）。Node 的 http/https 是两个独立模块，
 * axios 对 https 目标只认 `httpsAgent`，`httpAgent` 被完全忽略：于是
 * `keepAlive/maxSockets` 对 TLS 连接**从未生效**，每条请求都新建 socket、走
 * 完整 TCP+TLS 握手，响应后即刻关闭。跨境链路上这直接表现为两类高频告警
 * （生产实测 108 次 + 211 次）：
 *   - `Client network socket disconnected before secure TLS connection was
 *     established`（握手阶段被中间设备/链路掐断）；
 *   - `socket hang up`（复用了一个对端已静默关闭的半开连接）。
 *
 * 显式配置的三项各自的作用：
 *  - `keepAlive: true` + `keepAliveMsecs`：复用 TLS 会话，省掉每次握手的
 *    RTT（跨境 RTT 高，握手成本被放大）；
 *  - `timeout`（socket 级空闲超时）：让**池中已死**的 socket 及时被淘汰，
 *    而不是在下次复用时才以 `socket hang up` 的形式暴露——这是半开连接
 *    问题的根因修复，仅靠请求级 timeout 无法解决（请求发出前连接就已坏）；
 *  - `maxSockets`：与 http 侧同值，防长轮询（40s）+ 心跳 + 回调并发打满。
 *
 * 用 `https.Agent` 的 HTTPS 目标才走这一池；纯 http:// 部署仍走 httpAgent，
 * 两条路径互不影响（测试里 admin URL 多为 http://，故断言面不变）。
 */
const sharedHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 32,
  keepAliveMsecs: 10_000,
  // 池中 socket 的空闲上限：略高于最长请求（长轮询 40s），保证在飞请求不被
  // 误杀，同时让死连接在 45s 内被回收。
  timeout: 45_000,
});

const sharedAxios: AxiosInstance = axios.create({
  httpAgent: sharedHttpAgent,
  httpsAgent: sharedHttpsAgent,
});

let adminUrls: string[] = [];
let currentIndex = 0;

/**
 * NETOPT-G P1-2：单次请求的**最少**尝试次数。
 *
 * 为什么是 3：跨境链路上单次瞬时故障（TLS 握手中断/半开 socket/读超时）的
 * 观测概率约 4.5%（生产 80/1759 心跳），两次独立尝试后仍同时失败的概率降到
 * ~0.2%，足以把"偶发失败被记成离线"压到噪声级；再高则放大 admin-api 侧的
 * 5xx 压力（故障期重试风暴），3 是收敛与压力的折中。
 *
 * 与 adminUrls.length 取 max：HA 多台时保持"每台一次"的原语义不变。
 */
const MIN_ATTEMPTS = 3;

/**
 * 默认请求超时。原为 10s——但对跨境 HTTPS 链路偏紧：TLS 握手 + 反代转发在
 * 业务高峰时段偶发超过 10s（生产日志有 37 次 `timeout of 10000ms exceeded`，
 * 但成功请求 RTT 中位数仅 3.6s，说明是长尾而非普遍变慢）。放到 20s 覆盖长尾，
 * 同时远小于中台 90s 判死阈值，不会把心跳窗口本身拖爆。
 * 长轮询有独立超时（postLong 的 40s），不受此值影响。
 */
const DEFAULT_TIMEOUT_MS = 20_000;

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
      const status = (error as AxiosError | undefined)?.response?.status;
      const isTransientServerError =
        typeof status === 'number' && status >= 500 && status <= 599;
      // 非 5xx 的 HTTP **应答**（4xx 等确定性拒绝）：重试无益且会掩盖真实
      // 状态码。旧实现把它吞成 `All N admin servers are unavailable`，调用方
      // 与运维都看不到"其实是 400/403"——排障时被误导去查网络。直接上抛原
      // 错误（保留 response.status），与 401 的处理同口径。
      const isDeterministicClientError =
        typeof status === 'number' && !isTransientServerError;

      if (isDeterministicClientError) throw error;

      logger.warn(
        `Request to admin ${adminUrls[currentIndex]} failed: ${error.message}` +
          (isTransientServerError ? ` (transient ${status}, will retry)` : ''),
      );

      if (i < effectiveRetryCount - 1) {
        // failover 只在**多台** admin 时才有意义：单台时 failover() 会把
        // currentIndex 取模回自己（日志会误导性地打印"Failed over to ..."
        // 同一地址）。单台场景退化为对同一台的退避重试。
        if (adminUrls.length > 1) {
          failover();
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      } else if (isTransientServerError) {
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