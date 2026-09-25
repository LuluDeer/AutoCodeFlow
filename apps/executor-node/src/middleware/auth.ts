/**
 * SEC-03: Executor token management with expiration and rotation support.
 * This mirrors the auth.py implementation in executor-python.
 */
import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { AxiosResponse } from 'axios';
import { config } from '../config';
import { buildAdminApiUrl } from '../admin-api-url';
import { executorStartupId } from '../startup-identity';
import { unwrapAdminResponseData, adoptExecutorTokenHash } from '../admin-envelope';
import {
  sharedAxios,
  DEFAULT_TIMEOUT_MS,
  RETRY_BACKOFF_MS,
  httpStatusOf,
} from '../admin-http-agent';

/**
 * NETOPT-G P1-1：token 获取的重试次数。
 *
 * 与 admin-client 的 MIN_ATTEMPTS 同值（3），但**不复用**其常量：两者语义不同
 * （那边是"每副本一次 + 单台补偿"，这里是"对同一个 token 端点的纯重试"），
 * 且 auth.ts 不应依赖 admin-client（会形成循环依赖，见 admin-http-agent.ts 注释）。
 */
const TOKEN_FETCH_ATTEMPTS = 3;

/**
 * 带最小重试的 token 获取（NETOPT-G P1）。
 *
 * 只对**瞬时**故障重试（连接层错误 / 5xx）；4xx 是确定性拒绝（令牌被吊销、
 * 地址未注册等），重试无益且会给 admin 侧加压，直接上抛交给既有 catch 走
 * static-token 回退。
 *
 * 注意：**不**做 failover——token 是 per-executor 的凭据，换一台 admin 取回来
 * 的仍是同一份身份，与 admin-client 的多副本 failover 语义不同。
 */
async function fetchTokenWithRetry(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<AxiosResponse<unknown>> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < TOKEN_FETCH_ATTEMPTS; attempt++) {
    try {
      return await sharedAxios.post(url, body, {
        timeout: DEFAULT_TIMEOUT_MS,
        headers,
      });
    } catch (err: unknown) {
      lastError = err;
      const status = httpStatusOf(err);
      const isDeterministic = typeof status === 'number' && status < 500;
      const isLast = attempt === TOKEN_FETCH_ATTEMPTS - 1;
      if (isDeterministic || isLast) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
    }
  }
  // 循环要么 return、要么 throw；此行为类型完备性兜底。
  throw lastError ?? new Error('token fetch failed');
}

// 5-2（audit-r4）：static token 改为**每次调用读取**——与 python 侧
// _get_static_token() 每次读 env 的行为对齐。旧实现 `const STATIC_TOKEN =
// config.token` 在模块加载期固化：routes/config.ts 热重载（直接改
// process.env / config）后已加载常量不更新，形成「配置页说已改、认证还在用
// 旧值」的静默漂移。env 优先、回退 config（含 CLI --token 注入路径）。
export function readStaticToken(): string | null {
  const envVal =
    process.env.EXECUTOR_SHARED_TOKEN || process.env.EXECUTOR_SECRET || '';
  if (envVal.trim()) return envVal;
  const cfgVal = config.token;
  return cfgVal && cfgVal.trim() ? cfgVal : null;
}

export function getStaticToken(): string | null {
  return readStaticToken();
}

/**
 * S-3（audit-r4）：dev-mode allow-all 的显式开关。无 token 时默认 fail-closed；
 * 仅 EXECUTOR_ALLOW_NO_TOKEN=true（兼容 1/yes/on）显式放行未认证请求
 * （与 executor-python auth.py::_allow_no_token_dev_mode 同款语义）。
 */
export function allowNoTokenDevMode(): boolean {
  const raw = (process.env.EXECUTOR_ALLOW_NO_TOKEN || '').trim().toLowerCase();
  if (raw) return ['1', 'true', 'yes', 'on'].includes(raw);
  return false;
}

// Dynamic token storage (refreshed periodically)
let dynamicToken: string | null = null;
let tokenExpiresAt: Date | null = null;
const TOKEN_REFRESH_INTERVAL = 30 * 60 * 1000; // 30 minutes
let tokenFetchFailedAt: number | null = null;
const TOKEN_FETCH_BACKOFF_MS = 30_000;

// N41: fired (fire-and-forget) after every SUCCESSFUL fetchToken. main.ts
// uses it to re-register with rich metadata when the startup register
// failed — the /token endpoint's register side effect rebuilds the row
// WITHOUT type/capabilities/maxConcurrent/version, and only a real
// register call restores them.
type TokenAcquiredListener = () => void;
let tokenAcquiredListener: TokenAcquiredListener | null = null;

export function setOnTokenAcquired(listener: TokenAcquiredListener | null): void {
  tokenAcquiredListener = listener;
}

function notifyTokenAcquired(): void {
  const listener = tokenAcquiredListener;
  if (!listener) return;
  // Non-blocking: the listener runs outside the token/request path. Errors
  // are swallowed here — the listener owns its retry semantics.
  Promise.resolve()
    .then(listener)
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);

      console.warn(`[auth] onTokenAcquired listener failed: ${msg}`);
    });
}

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
    const staticToken = readStaticToken();
    if (staticToken) {
      headers['Authorization'] = `Bearer ${staticToken}`;
    }

    // NETOPT-G P1-1（跨境链路韧性）：改用共享 axios 实例 + 最小重试。
    //
    // 旧实现是 `axios.post(...)`（模块级默认实例）——既**没有**带 keepAlive 的
    // httpsAgent（对 https 目标等于每次冷 TLS 握手），也**没有**任何重试。而这是
    // 执行器获取 per-executor 令牌的**唯一路径**：它失败一次，所有依赖 token 的
    // 请求（心跳 / pull / 回调）就**连带全部失败**——故障面比心跳本身更大。
    // 生产日志的 108 次 TLS 握手中断 + 211 次 socket hang up 有相当一部分落在
    // 这条路径上（它以 30 分钟周期 + 30s 退避被调用，抖动窗口正撞其上）。
    //
    // 重试对 token 端点是安全的：admin-api 按 `startupId` 做了幂等——同
    // startupId 重复请求返回**当前** token 而非轮换（见下方 R9 注释），因此
    // 重试不会造成令牌轮换风暴。
    const response = await fetchTokenWithRetry(
      buildAdminApiUrl(getAdminApiUrl(), '/api/executors/token'),
      {
        address: config.executorAddressPublic || config.executorAddress,
        appName: config.appName,
        // R9 (round-8 P1 W2): the process-life identity lets admin-api make
        // this endpoint idempotent — a same-startupId re-fetch returns the
        // CURRENT token instead of rotating (N4 register semantics).
        startupId: executorStartupId,
      },
      headers,
    );

    // R9: the token endpoint is a Nest POST — it answers 201, not 200. The
    // old `=== 200` check silently dropped every successful response.
    if (response.status >= 200 && response.status < 300) {
      // R9 (round-8 P1 root fix): admin-api's global ResponseInterceptor wraps
      // the payload in {code,message,data}. Reading response.data.token
      // directly yielded undefined forever, so every getCurrentToken() call
      // re-hit POST /token — which used to rotate on every call — putting the
      // stored tokenHash on a ~30s rotation cycle and breaking the N26
      // per-execution callback-token invariant (docs/VERIFY-round8-e2e.md §1.5).
      const payload = unwrapAdminResponseData(response.data);
      const token =
        typeof payload?.token === 'string' && payload.token.length > 0
          ? payload.token
          : null;
      if (!token) {

        console.warn('[auth] fetchToken: admin response carried no token');
        return null;
      }
      // R9 (W3): adopt the tokenHash that matches this token so the HMAC
      // source secret for per-execution callback tokens stays in sync with
      // whatever admin-api currently stores (see admin-envelope.ts).
      adoptExecutorTokenHash(response.data);
      notifyTokenAcquired();
      return token;
    }
  } catch (_err: unknown) {
    // Fall back to static token if dynamic token fetch fails
    // Log at warn level so token refresh failures are visible in diagnostics
    const msg = _err instanceof Error ? _err.message : String(_err);

    console.warn(`[auth] fetchToken failed: ${msg}`);
  }
  return null;
}

// E-27（DEEP_REVIEW 0ef3bbe）：并发刷新去重——token 过期瞬间的一批并发回调/心跳
// 旧实现各自独立走 refreshTokenIfNeeded，各自发一次 POST /token（最多 N 次并发
// 放大 + 多余延迟）。模块级 in-flight promise 复用：第一个调用者执行实际刷新，其余
// 并发调用者 await 同一 promise，只发一次 /token，全体等待同一结果。
let refreshInFlight: Promise<void> | null = null;
// E-27: 每次真实 fetch（POST /token）成功时自增的单调序号。forceTokenRefresh
// 的等待者在进入时记下当前序号，等待结束后若序号已推进，就说明等待期间确实发生过
// 一次真实 fetch——其结果正是它需要的，直接复用（forced 刷新必 fetch；scheduled
// 刷新可能因 token 未过期/退避中决定不 fetch，此时序号不动，等待者照常走强制刷新）。
//
// 为什么用序号而不是时间戳：旧实现存的是"刷新成功的时刻"，但那个时刻取自
// performTokenRefresh() 开头捕获的 `now`，早于任何等待者的入场时间，于是判据
// `lastSuccessfulRefreshAt >= waitedSince` 只在"刷新启动与等待者入场落在同一毫秒"
// 时成立——跨毫秒边界就全体 fall-through，N 个并发 401 各自再发一次 /token，
// 单飞去重形同虚设（CI 上稳定复现为 1/8 概率、POST 次数 2→4）。单调序号没有
// 时钟粒度问题：只要在等待期间发生过 fetch，序号必然推进。
let refreshFetchSeq = 0;

async function performTokenRefresh(): Promise<void> {
  const now = new Date();
  // Back off after a failed fetch — without this every request hangs for
  // the 10s fetch timeout while admin-api is unreachable.
  if (
    tokenFetchFailedAt !== null &&
    now.getTime() - tokenFetchFailedAt < TOKEN_FETCH_BACKOFF_MS
  ) {
    return;
  }
  // Refresh if no token, expired, or within 5 minutes of expiration
  if (tokenExpiresAt === null || now >= new Date(tokenExpiresAt.getTime() - 5 * 60 * 1000)) {
    const newToken = await fetchToken();
    if (newToken) {
      dynamicToken = newToken;
      tokenExpiresAt = new Date(now.getTime() + TOKEN_REFRESH_INTERVAL);
      tokenFetchFailedAt = null;
      refreshFetchSeq += 1;
    } else {
      tokenFetchFailedAt = now.getTime();
    }
  }
}

async function refreshTokenIfNeeded(): Promise<void> {
  // E-27: a refresh is already underway — await the SAME result instead of
  // firing a duplicate POST /token.
  if (refreshInFlight) {
    await refreshInFlight;
    return;
  }
  refreshInFlight = performTokenRefresh();
  try {
    await refreshInFlight;
  } finally {
    refreshInFlight = null;
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
  const staticToken = readStaticToken();
  if (staticToken) {
    validTokens.push(staticToken);
  }

  // If no tokens configured at all, refuse by default (fail-closed) — unless
  // EXECUTOR_ALLOW_NO_TOKEN=true explicitly opts into dev-mode allow-all.
  // An unauthenticated /api/execute is arbitrary code execution on this host.
  // S-3（audit-r4）：fail-closed 是默认姿态；REQUIRE_TOKEN=true 是更早的
  // 强制 fail-closed 开关，保持兼容（任一触发即 503）。
  if (validTokens.length === 0) {
    if (process.env.REQUIRE_TOKEN === 'true' || !allowNoTokenDevMode()) {
      res.status(503).json({
        error:
          'No executor token is configured; refusing unauthenticated execution ' +
          '(set EXECUTOR_ALLOW_NO_TOKEN=true only for local dev)',
      });
      return;
    }
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
  const tokenBuf = Buffer.from(token);
  const matched = validTokens.some((validToken) => {
    const validBuf = Buffer.from(validToken);
    // timingSafeEqual requires same-length buffers; mismatched lengths still reject
    return tokenBuf.length === validBuf.length && timingSafeEqual(tokenBuf, validBuf);
  });
  if (!matched) {
    res.status(401).json({ error: 'Invalid or missing executor token' });
    return;
  }

  next();
}

export async function getCurrentToken(): Promise<string | null> {
  await refreshTokenIfNeeded();
  return dynamicToken || readStaticToken();
}

/**
 * R10 (round-10 gap #3): force an immediate token re-fetch, bypassing the
 * 30-minute refresh schedule. Used by admin-client when an outbound request
 * comes back 401: the stored per-executor token was rotated out from under
 * this process (e.g. an admin-UI rotate-token), and the only way to converge
 * is to re-hit POST /token — which is authenticated with the STATIC token
 * (shared bootstrap) and whose response fetchToken already uses to adopt the
 * matching tokenHash (R9/W3). So one call here heals BOTH the bearer
 * credential and the N26 per-execution callback HMAC secret.
 *
 * Storm guards: the TOKEN_FETCH_BACKOFF_MS from the last FAILED fetch still
 * applies (admin unreachable / wrong shared token → this degrades to a no-op
 * returning the current token, and the caller must not retry). E-27 adds an
 * in-flight gate: concurrent 401s share ONE POST /token instead of each
 * fanning out its own, and admin-api's issueToken is idempotent per
 * (address, startupId) so every caller converges on the SAME token rather
 * than rotating.
 */
export async function forceTokenRefresh(): Promise<string | null> {
  // E-27: join any in-flight refresh (scheduled or forced) instead of stacking
  // another POST /token behind it — the same gate that dedups the per-request
  // path must cover the 401-heal path, otherwise N concurrent 401s still fan
  // out into N fetches.
  if (refreshInFlight) {
    const seqAtJoin = refreshFetchSeq;
    await refreshInFlight;
    // 等待期间若发生过一次真实 fetch（forced 刷新必 fetch；scheduled 刷新
    // 可能因 token 未过期/退避中决定不 fetch），其结果正是我们需要的——直接
    // 复用，避免并发 N 个 401 在等待结束后各自再发 N 次 /token（修复前
    // 等待者 fall-through 会各自再刷一次，N 并发放大为 N 次请求）。
    if (refreshFetchSeq > seqAtJoin) {
      return dynamicToken;
    }
  }
  // A *forced* refresh started by another 401 handler while we waited is
  // exactly the fetch we wanted (tokenExpiresAt was cleared for it), so reuse
  // its outcome. If what settled was only a scheduled refresh that decided NOT
  // to fetch, the token is still the rotated-out one — fall through and force
  // our own, which is the whole point of the self-heal.
  tokenExpiresAt = null;
  refreshInFlight = performTokenRefresh();
  try {
    await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
  return dynamicToken;
}
