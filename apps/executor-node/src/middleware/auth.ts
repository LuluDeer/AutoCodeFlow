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
// ADR-017 阶段 3（复查补口）：指纹是 /executors/token 的**行定位键**，
// 必须随载荷上报（缺省 = 服务端按 address 回落，同址多行时会取错行）。
import { getDeviceFingerprint } from '../device-identity';
import { unwrapAdminResponseData, adoptExecutorTokenHash } from '../admin-envelope';
import {
  sharedAxios,
  DEFAULT_TIMEOUT_MS,
  RETRY_BACKOFF_MS,
  httpStatusOf,
} from '../admin-http-agent';
// P1-1: /token 409 冲突态经 heartbeat-state 暴露到 /health 与 /health/admin-status
//（该模块无路由依赖，auth→heartbeat-state 不会成环）。
import { setRegistrationConflict, isRegistrationConflictActive } from '../heartbeat-state';

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
      // constant-time-exempt: 重试次数与循环上界比较（整数计数器 vs 常量）；标识符带 TOKEN 只因它是「拉 token 的尝试次数」，不是凭据。
      const isLast = attempt === TOKEN_FETCH_ATTEMPTS - 1;
      if (isDeterministic || isLast) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
    }
  }
  // 循环要么 return、要么 throw；此行为类型完备性兜底。
  throw lastError ?? new Error('令牌获取失败');
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
 * POST /api/shutdown（本机优雅关停端点）的凭据校验。
 *
 * 与 /api/* 的 verifyToken 同一信任源——共享令牌（EXECUTOR_SHARED_TOKEN /
 * EXECUTOR_SECRET / --token）与当前动态令牌任一匹配即放行，constant-time
 * 比较；未配置任何凭据时 fail-closed（与 verifyToken 的 503 语义一致，
 * 防止本机任意进程随意关停执行器）。
 *
 * 为什么不复用 verifyToken：它会 await refreshTokenIfNeeded()——admin 不可达
 * 时一次 token 刷新要等到网络超时（最多 3 次重试），而"中台链路异常"恰恰是
 * 停机最常见的场景之一；关停路径不应依赖对 admin 的网络可达性。
 */
export function matchesExecutorCredential(candidate: unknown): boolean {
  if (typeof candidate !== 'string' || !candidate) return false;
  const validTokens: string[] = [];
  const staticToken = readStaticToken();
  if (staticToken) validTokens.push(staticToken);
  if (dynamicToken) validTokens.push(dynamicToken);
  if (validTokens.length === 0) return false;
  const providedBuf = Buffer.from(candidate);
  return validTokens.some((validToken) => {
    const validBuf = Buffer.from(validToken);
    // timingSafeEqual requires same-length buffers; mismatched lengths still reject
    return providedBuf.length === validBuf.length && timingSafeEqual(providedBuf, validBuf);
  });
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

// ---------------------------------------------------------------------------
// P1-1（本轮审计，2026-10-26）：/token 409 慢性冲突的退避升级与可观测。
//
// 生产实证：同 push 地址存在旧指纹行（容器重建后安装身份漂移）时，admin 对
// register/token 双路恒 409（executor.service.ts 的 EXECUTOR_ADDRESS_TAKEN）。
// 旧实现把 409 与网络错同等对待——只吃 30s 单一退避、以心跳节拍无限重试
// （真机 7h 实测 883 次 fetchToken failed），健康面看不到任何冲突痕迹；更糟的
// 是静态 token 心跳照常 201，admin 侧冲突行永远 OFFLINE 不了，接管自愈
// （canTakeOverAbandonedAddressRow，要求 OFFLINE + 静默超窗）被自己的心跳锁死。
//
// 修复口径：
//   ① 409（且仅 409）单独走**指数退避**：30s 起步 ×2 递增、封顶 10min
//      （TOKEN_CONFLICT_BACKOFF_MS）；任何非 409 结果（成功、网络错、其它 4xx
//      /5xx）都复位冲突退避——冲突解除后必须立即恢复既有 30s 节奏，不得继承
//      上一轮的长间隔。
//   ② 冲突期间置位 registrationConflict（heartbeat-state 模块），经 /health 与
//      /health/admin-status 暴露，运维/桌面可观测；成功取回 token 即清除。
//   ③ 409 期间不再叠加普通 fetchToken 退避计时（两个退避语义独立：普通失败
//      30s 固定，冲突指数）。
// ---------------------------------------------------------------------------

/** 冲突退避起步间隔（与普通失败退避同值，语义：第一次 409 行为与旧实现一致）。 */
const TOKEN_CONFLICT_BACKOFF_BASE_MS = 30_000;
/** 冲突退避封顶（10min）：冲突自愈（接管窗 5min，admin EXECUTOR_ADDRESS_TAKEOVER_
 *  SILENCE_MS）后至多 10min 内收敛，避免无限增长到小时级。 */
const TOKEN_CONFLICT_BACKOFF_MAX_MS = 10 * 60 * 1000;
/** 上次 409 的时间戳（epoch ms）——普通失败退避计时复用同一字段。 */
let tokenConflictBackoffMs = TOKEN_CONFLICT_BACKOFF_BASE_MS;

function recordTokenConflict(): void {
  // P1-1: 指数退避调度——**第一次** 409 的下一次重试间隔 = BASE(30s)，与旧实现
  // 的普通失败节奏一致（旧实现第一次失败后 30s 才重试）；**后续**每次 409 把
  // 间隔 ×2，封顶 10min。上限取值依据：封顶必须 > admin 接管窗（5min，
  // EXECUTOR_ADDRESS_TAKEOVER_SILENCE_MS）+ 执行器重试到点的时间差，否则冲突
  // 自愈后第一拍仍撞 409（行还没到接管条件）就把节奏锁死在低位。
  tokenConflictBackoffMs = isRegistrationConflictActive()
    ? Math.min(tokenConflictBackoffMs * 2, TOKEN_CONFLICT_BACKOFF_MAX_MS)
    : TOKEN_CONFLICT_BACKOFF_BASE_MS;
  tokenFetchFailedAt = Date.now();
  setRegistrationConflict(true);
  console.warn(
    `[auth] fetchToken rejected with 409 (executor address conflicts with another ` +
      `installation on admin side). Next attempt in ` +
      `${Math.round(tokenConflictBackoffMs / 1000)}s ` +
      `(exponential backoff, cap ${TOKEN_CONFLICT_BACKOFF_MAX_MS / 60_000}min). ` +
      `Check EXECUTOR_ADDRESS_PUBLIC uniqueness or resolve the admin-side ` +
      `address row conflict.`,
  );
}

function clearTokenConflict(): void {
  tokenConflictBackoffMs = TOKEN_CONFLICT_BACKOFF_BASE_MS;
  setRegistrationConflict(false);
}

/** 冲突退避是否仍在生效窗口内（performTokenRefresh 的快速短路判定）。 */
function withinConflictBackoff(nowMs: number): boolean {
  return (
    tokenFetchFailedAt !== null &&
    nowMs - tokenFetchFailedAt < tokenConflictBackoffMs
  );
}

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
        // ADR-017 phase 3 (review back-fill): the stable device fingerprint is
        // the ROW LOOKUP KEY. Without it admin-api's issueToken() falls back to
        // `findOne({where:{address}})`, which returns an arbitrary row when two
        // pull-mode executors share an address (ADR-017 §5) — the token would
        // then be rotated on SOMEONE ELSE'S row (that peer 401s, its execution
        // sticks in RUNNING until the stale sweep). Omitted when collection
        // failed (null) → admin's legacy address path, unchanged behavior.
        deviceFingerprint: getDeviceFingerprint() ?? undefined,
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
      // per-execution callback-token invariant (docs/archive/verifies/verify-round8-e2e.md §1.5).
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
      // P1-1: 成功即复位冲突态——退避间隔回 30s、registrationConflict 撤销。
      clearTokenConflict();
      notifyTokenAcquired();
      return token;
    }
  } catch (_err: unknown) {
    // P1-1: 409（地址冲突）是 admin 的**确定性**身份裁决——单独走指数退避，
    // 不与普通网络错共享同一节奏。判定用 httpStatusOf（axios 错误形态，
    // fetchTokenWithRetry 对 4xx 不重试直接上抛，status 一定在 response 上）。
    const conflictStatus = httpStatusOf(_err);
    if (conflictStatus === 409) {
      recordTokenConflict();
      console.warn('[auth] fetchToken failed: 409 Conflict (executor address already taken)');
      return null;
    }
    // 非 409 的失败路径复位冲突计数：冲突解除（无论以成功还是其它错误呈现）
    // 后不得继承上一轮冲突的长退避——否则一次网络抖动之后的重试间隔仍是 10min。
    clearTokenConflict();
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
  // P1-1: 统一用 Date.now()（而不是 `new Date()`）——退避锚点
  // （recordTokenConflict / 普通失败路径）写的也是 Date.now()。两处此前各用
  // 一把钟（new Date 走 V8 内建、Date.now 可被 jest.spyOn 打桩），单测里锚点
  // 是桩时刻、判定是真实时钟，退避窗口永远错位；生产上两者等价，但同一状态机
  // 必须单源取时。Python 侧 _refresh_token_if_needed 已是 time.monotonic() 单源。
  const nowMs = Date.now();
  // P1-1: 冲突（409）退避优先判定——409 期间重试间隔按指数增长（30s→10min），
  // 与普通失败退避（固定 30s）分开计量。冲突记录复用 tokenFetchFailedAt 字段
  // （两者都以「上次失败时刻」为退避锚点），但窗口用冲突间隔回答。
  if (withinConflictBackoff(nowMs)) {
    return;
  }
  // Back off after a failed fetch — without this every request hangs for
  // the 10s fetch timeout while admin-api is unreachable.
  // P1-1: 非 409 失败仍用固定 TOKEN_FETCH_BACKOFF_MS；冲突分支已在上面短路，
  // 所以这里的窗口只对普通失败生效。
  if (
    !isRegistrationConflictActive() &&
    tokenFetchFailedAt !== null &&
    nowMs - tokenFetchFailedAt < TOKEN_FETCH_BACKOFF_MS
  ) {
    return;
  }
  // Refresh if no token, expired, or within 5 minutes of expiration
  if (tokenExpiresAt === null || nowMs >= tokenExpiresAt.getTime() - 5 * 60 * 1000) {
    const newToken = await fetchToken();
    if (newToken) {
      dynamicToken = newToken;
      tokenExpiresAt = new Date(nowMs + TOKEN_REFRESH_INTERVAL);
      tokenFetchFailedAt = null;
      refreshFetchSeq += 1;
    } else if (!isRegistrationConflictActive()) {
      // P1-1: 409 路径已在 recordTokenConflict 里设置锚点与冲突间隔；
      // 只有普通失败才在这里记「上次失败时刻」（固定 30s 窗口锚点）。
      tokenFetchFailedAt = nowMs;
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
    res.status(401).json({ error: '执行器令牌无效或缺失' });
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
    res.status(401).json({ error: '执行器令牌无效或缺失' });
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

/** P1-1（测试出口）：重置 409 冲突退避状态机——退避间隔、失败锚点、冲突标志。
 *  既有单测按 resetModules 逐用例重建模块注册表，天然隔离；该钩子给同一注册表
 *  内连续驱动多次 409 → 退避递增的用例用（对齐 scheduler 的
 *  resetVersionDriftWarnStateForTest 先例）。 */
export function __resetTokenConflictStateForTest(): void {
  clearTokenConflict();
  tokenFetchFailedAt = null;
}
