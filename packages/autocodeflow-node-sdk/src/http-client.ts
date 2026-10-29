import axios, {
  AxiosInstance,
  AxiosRequestConfig,
  AxiosResponse,
  AxiosError,
  Method,
} from 'axios';
import { TaskEnv } from './types';

/**
 * Thin wrapper around Axios that:
 * - automatically sets `Authorization: Bearer <token>`
 * - automatically sets `X-Trace-Id` when a trace ID is available
 * - exposes typed `get / post / put / delete` helpers
 *
 * N23: since the per-execution callback token landed, executor-node injects
 * `AUTOFLOW_ADMIN_API_URL` + `AUTOFLOW_CALLBACK_TOKEN` into task
 * subprocesses, so a client built via `TaskContext.fromEnv()` is normally
 * *enabled* — but the token only authorizes callbacks for its own
 * executionId and expires with the task. A client built without
 * `baseURL`/`token` (old executor versions, dev executor without a secret)
 * stays *disabled*: construction succeeds, but any request method throws a
 * clear error explaining that callback capability is unavailable.
 *
 * N27: executor-node additionally injects `AUTOFLOW_EXECUTOR_ADDRESS` (the
 * address it registered with). `post()` to `/api/executions/callback`
 * auto-fills `executorAddress` on items that omit it, so task code never
 * has to hardcode an address that changes with redeployment.
 *
 * ADR-017 阶段 3 / protocol v6: executor-node also injects
 * `AUTOFLOW_DEVICE_FINGERPRINT` (its stable install identity, the same value
 * it reports on register/heartbeat). When known it is stamped onto the same
 * callback items — the shared/legacy callback token is a fleet-wide secret
 * bound to no executor row, and pull mode lets several rows share one
 * address, so `executorAddress` alone cannot say which row a callback came
 * from; the fingerprint can. Both fields follow the same optional rule: when
 * the executor does not inject them the keys are **omitted entirely** (never
 * sent as an empty string).
 *
 * U14: admin-api wraps every response body in a `{ code, message, data }`
 * envelope (global ResponseInterceptor). The request helpers unwrap it and
 * resolve with the inner `data`, so `results`-style lookups on a callback
 * response work; rejected requests get the envelope's `message` appended to
 * the axios error message.
 *
 * B-4（中台↔执行器深度审查）：与 python 回调客户端（autocodeflow-http
 * client.py）的可靠性契约**对齐**——旧实现是纯 axios 薄包装（无重试、无熔断），
 * 而 autocodeflow-http 有完整「重试 + 熔断 + Retry-After 头解析」契约；两侧行为
 * 不对齐会让跨 SDK 消费方对可靠性产生错误预期。
 *
 * BUG-15 复审澄清 parity 前提：这里说的「python 侧契约」**仅指
 * autocodeflow-http**（Admin API 回调 HTTP 客户端）。任务内 python SDK
 * （autoflow-sdk）**自批次 B 起**（NETOPT-10-1）report()/report_failure()
 * 已有 3 次有界重试（5xx/429/TransportError、4xx 单发）——本包 send() 对
 * `/api/executions/callback` 的 POST 同步豁免（见 isTerminalCallbackUrl），
 * 其余非幂等仍不重试。本包现补齐同款语义：
 * - 重试：仅幂等方法（GET/HEAD/OPTIONS，`safeMethodsOnly`）在可重试错误上重试
 *   （429/500/502/503/504 或网络层错误：超时/连接拒绝/断网），指数退避
 *   （minWaitMs×2^n，封顶 maxWaitMs），尊重 `Retry-After` 头（delta-seconds
 *   或 HTTP-date，取 max(退避, Retry-After)）；
 * - 熔断：failureThreshold 次连续可熔断错误 → open（快速失败，
 *   `CircuitBreakerOpenError`）；resetTimeoutMs 后 half-open 放行单个探测请求，
 *   成功即 closed，失败重新 open——与 python 的 `_CircuitBreaker` 同构；
 * - 非幂等方法（POST/PUT/DELETE）**不自动重试**，但同样计入熔断失败
 *   （与 python `_should_retry` 语义一致）；唯一例外是终态回调直报通道
 *   POST `/api/executions/callback`（NETOPT-F P2-4，见 isTerminalCallbackUrl）。
 */

/**
 * SDK-BASE-01: 剥掉 base URL 尾部的 `/api`（含尾斜杠与重复形式）。
 *
 * 请求路径本身是绝对的 `/api/executions/callback`，axios 对 baseURL 与绝对
 * 路径做简单串接，所以 base 若已带 `/api` 会产生 `/api/api/...` → 404。
 * 对齐 python SDK（autoflow_sdk/callback.py 的 `endswith("/api")` 分支）。
 *
 * 只剥离**整段** `/api`，不碰 `/apiary` 这类前缀相同的无关路径。
 */
export function stripTrailingApiSuffix(baseURL?: string): string | undefined {
  if (!baseURL) return baseURL;
  let out = baseURL.replace(/\/+$/, "");
  // 允许 `.../api/api/` 这类重复写法一并收敛
  while (/\/api$/i.test(out)) {
    out = out.slice(0, -4).replace(/\/+$/, "");
  }
  return out;
}

// ---------------------------------------------------------------------------
// B-4：重试 + 熔断配置（默认值与 python autocodeflow-http/client.py 对齐）
// ---------------------------------------------------------------------------

export const SAFE_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'HEAD',
  'OPTIONS',
]);

/** NETOPT-F P2-4: reportSuccess/reportFailure 直报通道（POST
 *  `/api/executions/callback`）豁免 safeMethodsOnly——对齐 autoflow-sdk
 *  callback.py（CALLBACK_MAX_ATTEMPTS=3：5xx/429/网络错误有界退避，4xx
 *  契约拒绝仍单发）。任务代码同步通道没有 executor 侧落盘重放兜底，一次
 *  瞬时抖动即丢终态、admin 侧该行滞留 RUNNING 直到 stale sweep 回收
 *  （真实 failureReason 丢失）。
 *  NETOPT-G P3: 路径判定用段界正则而非裸 startsWith——兄弟路由
 *  /api/executions/callback-extra 不应被误判为回调端点而豁免重试。
 *  R177-A1: 判定前先经 requestPath 归一化（查询串 / 绝对 URL 不再失配），并
 *  **收紧到端点本身**：admin-api 只在 @Post('callback') 挂了这一个端点
 *  （apps/admin-api/src/modules/task/execution-callback.controller.ts:100），
 *  /api/executions/callback/xxx 这样的子路径并不存在，把它也算作「可豁免重试
 *  的回调通道」只会让一个 404 被无谓重试 4 次。收紧后与 withExecutorAddress
 *  的尾锚语义一致——两个谓词不再互相矛盾（此前 /callback/sub 对前者为真、
 *  对后者为假）。 */
export function isTerminalCallbackUrl(url: string, method: Method): boolean {
  return (
    method.toUpperCase() === 'POST' &&
    /^\/api\/executions\/callback\/?$/.test(requestPath(url))
  );
}

/** 与 python `_RETRYABLE_HTTP_STATUSES = {429, 500, 502, 503, 504}` 对齐。 */
export const RETRYABLE_HTTP_STATUSES: readonly number[] = [429, 500, 502, 503, 504];

/**
 * R191：**终态回调通道**的单次重试等待上限（毫秒）。
 *
 * 与 `maxWaitMs = 30s` 的默认值不同：回调通道的重试预算是**有 deadline 压力**的 ——
 * 执行器在 `timeoutSeconds` 到点时会 kill 进程，而终态回调恰恰是在「任务刚好结束」时报的，
 * 最可能撞上那个窗口。按默认预算算最坏 ≈ 4×10s(超时) + 3×30s(等待) ≈ **130s**，
 * 一旦超过剩余预算，**重试反而导致终态丢失**（回调没发出去就被杀）—— 那是「为可靠性做的重试，
 * 把可靠性搞坏了」。
 *
 * 取 5s 与 python SDK 的 `CALLBACK_RETRY_MAX_WAIT_S = 5.0` 对齐；此时最坏 ≈ 4×10 + 3×5 = **55s**，
 * 仍比 python(≈41s) 宽（node 默认多一次尝试，见下方 NETOPT-G P3 注），但已远离 130s 的量级。
 */
export const CALLBACK_MAX_WAIT_MS = 5_000;

/**
 * R191：本次请求的**单次重试等待上限**。纯函数（导出可测）。
 *
 * 终态回调通道有 deadline 压力（执行器 `timeoutSeconds` 到点 kill），故封顶更小；
 * 其余路径沿用 `retry.maxWaitMs`。**只影响等待，不改尝试次数**。
 */
export function effectiveRetryMaxWaitMs(
  url: string,
  method: Method,
  retry: Pick<HttpRetryConfig, 'maxWaitMs'>,
): number {
  return isTerminalCallbackUrl(url, method)
    ? Math.min(retry.maxWaitMs, CALLBACK_MAX_WAIT_MS)
    : retry.maxWaitMs;
}

/**
 * R177-A1: 把请求 URL 收敛成「纯路径」形态，供回调端点谓词判定。
 *
 * 缺陷现场：两个谓词（isTerminalCallbackUrl / withExecutorAddress）都直接拿
 * 调用方传进来的 url 套裸正则，于是两种完全合法的写法静默失配：
 * - 带查询串（/api/executions/callback?batch=2）：重试豁免失效，终态回调退回
 *   「单发即抛」，一次抖动就丢终态；executorAddress 盖章失效，admin 侧该行
 *   无法归属到执行器（N27 失效）。
 * - 绝对 URL（http://admin-api:3105/api/executions/callback）：^/api 锚点
 *   直接失配，同上。
 *
 * 只做三件事：剥 scheme://host、去 ?query、去 #fragment。不做 ../ 归一化
 * （调用方传的就是路径，归一化反而会掩盖可疑输入）。
 */
export function requestPath(url: string): string {
  let path = String(url ?? '');
  const schemeHost = /^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\/[^/?#]*/.exec(path);
  if (schemeHost) {
    path = path.slice(schemeHost[0].length);
    if (!path.startsWith('/')) path = '/' + path;
  }
  const cut = path.search(/[?#]/);
  return cut >= 0 ? path.slice(0, cut) : path;
}

export interface HttpRetryConfig {
  /** 最大重试次数（不含首次请求；默认 3 → 至多 4 次尝试）。
   *  NETOPT-G P3: 旧注释"对齐 python max_retries"引错常量——python
   *  CALLBACK_MAX_ATTEMPTS=3 是**总尝试次数**（重试 2 次），node 默认
   *  maxRetries=3 是重试 3 次（总 4 次尝试），比 python 多一次。行为无害
   *  （多一次退避更稳），此处如实标注差异，勿再引 python 常量背书。 */
  maxRetries: number;
  /** 首次退避基数（ms；默认 1000，对齐 python min_wait=1.0s）。 */
  minWaitMs: number;
  /** 退避上限（ms；默认 30000，对齐 python max_wait=30.0s）。 */
  maxWaitMs: number;
  /** 可重试的 HTTP 状态码（默认 429/500/502/503/504）。 */
  retryableStatuses: readonly number[];
  /** 仅幂等方法（GET/HEAD/OPTIONS）自动重试；非幂等只计入熔断（对齐 python）。 */
  safeMethodsOnly: boolean;
  /**
   * DX-01（2026-10-29 SDK/DX 审计）：是否启用进程内熔断器（默认开）。
   *
   * `false` = 完全跳过 `tryAcquire()` / `onFailure()` / `onSuccess()`，即
   * **不会**再因为「连续 N 次可熔断失败」把后续请求挡成 `CircuitBreakerOpenError`
   * ——容错上限等价于 ∞。`{ retry: null }` 会把它归一成 `false`（见
   * `normalizeRetry`）；也可单独用 `{ retry: { breakerEnabled: false } }`
   * 只关熔断、保留重试。
   */
  breakerEnabled: boolean;
}

export const DEFAULT_HTTP_RETRY: HttpRetryConfig = {
  maxRetries: 3,
  minWaitMs: 1_000,
  maxWaitMs: 30_000,
  retryableStatuses: RETRYABLE_HTTP_STATUSES,
  safeMethodsOnly: true,
  breakerEnabled: true,
};

/**
 * B-4 / DX-01：把调用方传入的 `retry` 归一成**确定的**运行时配置（纯函数，导出可测）。
 *
 * 三态语义——`null` 与 `undefined` **必须**分开，这是本轮审计的缺陷现场：
 *
 * | 入参 | 语义 | 产物 |
 * |---|---|---|
 * | `undefined`（或整份 options 缺省） | 「没提这件事」→ 走默认 | `maxRetries=3` + `breakerEnabled=true` |
 * | `null` | 「明确别替我重试、别替我熔断」→ 关闭可靠性层 | `maxRetries=0`（**零**重试，总尝试 1 次）+ `breakerEnabled=false`（容错上限 ∞） |
 * | `{…}` | 在默认值上逐键覆盖（`{maxRetries:0}` 只关重试、熔断仍开） | `{…DEFAULT, …入参}` |
 *
 * 为什么 `null` 不是 `undefined`：两者在 JS 里虽然都 falsy，但**意图相反**。
 * 旧实现写的是 `options?.retry ? {…} : {…DEFAULT}`——`null` 和 `undefined`
 * 一起落进 else 分支，于是 README/构造签名承诺的「`retry: null` 关闭重试与
 * 熔断」是**空操作**（实测仍是 `maxRetries:3` 且熔断生效）。`undefined` 必须
 * 保持「走默认」的语义不变（既有调用点全按位置传 `undefined`），所以只能把
 * `null` 单独拎出来给一个显式产物。这是 OSS 通行做法：`octokit` 的
 * `retry: false` 与 `retry: { retries: 0 }` 等价且文档明说「关闭 ≠ 不配置」。
 *
 * 产物的「显式 0/∞」写法：`maxRetries: 0` 是**零**（`send()` 里
 * `attempt < maxAttempts - 1` 恒 false → 一次都不重试），`breakerEnabled: false`
 * 是**上限 ∞**（不做失败累计、不快速失败）。两者都是可断言的确定值，而不是
 * 「靠某个别处的默认值恰好不生效」。
 */
export function normalizeRetry(
  retry?: Partial<HttpRetryConfig> | null,
): HttpRetryConfig {
  if (retry === null) {
    return { ...DEFAULT_HTTP_RETRY, maxRetries: 0, breakerEnabled: false };
  }
  if (retry === undefined) {
    return { ...DEFAULT_HTTP_RETRY };
  }
  return { ...DEFAULT_HTTP_RETRY, ...retry };
}

/** B-4：熔断 open 时快速失败抛出的错误（对齐 python CircuitOpenError）。 */
export class CircuitBreakerOpenError extends Error {
  constructor() {
    super(
      'Circuit breaker is open — the Admin API is failing fast; ' +
        'requests are blocked until the reset timeout elapses',
    );
    this.name = 'CircuitBreakerOpenError';
  }
}

/**
 * R177-A1（轴 1 错误面 + 轴 3 两包一致性）：凭据缺失时抛出的**有类型**错误。
 *
 * 缺陷现场：requireEnabled() 抛的是 new Error(disabledReason)——消费方无法
 * 用 instanceof 判断「这是配置错，不是网络错、不是服务端 4xx」，只能匹配英文
 * 文案。python SDK 早在 CallbackDisabledError 上做了这件事，本包缺。
 *
 * 兼容性：继承 Error，name 改为 'HttpClientDisabledError'，message 逐字节
 * 保留原文案——既有的 toThrow(/HttpClient is disabled/) 断言与
 * instanceof Error 判断全部照旧成立。
 */
export class HttpClientDisabledError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'HttpClientDisabledError';
  }
}

/**
 * B-4：进程内熔断器（对齐 python `_CircuitBreaker`：failure_threshold=5，
 * reset_timeout=60s，half-open 单探测并发）。
 *
 * 三态：
 * - closed：请求放行；可熔断失败累计到 threshold → open；
 * - open：请求快速失败（tryAcquire 返回 false）；reset_timeout 后转 half-open；
 * - half-open：仅放行一个探测请求；成功 → closed（清零），失败 → open 重计时。
 */
export class CircuitBreaker {
  private state: 'closed' | 'open' | 'half_open' = 'closed';
  private failures = 0;
  private openedAt = 0;
  private probeInFlight = false;

  constructor(
    private readonly failureThreshold: number = 5,
    private readonly resetTimeoutMs: number = 60_000,
  ) {}

  /** 请求前调用：open 且未到复位时间 → false（调用方直接抛 CircuitBreakerOpenError）。 */
  tryAcquire(): boolean {
    if (this.state === 'open') {
      if (Date.now() - this.openedAt >= this.resetTimeoutMs) {
        this.state = 'half_open';
        this.probeInFlight = true;
        return true; // 恰放行一个探测请求
      }
      return false;
    }
    if (this.state === 'half_open') {
      if (this.probeInFlight) return false;
      this.probeInFlight = true;
      return true;
    }
    return true;
  }

  /** 请求成功（含探测成功）：closed 归零；half_open → closed。 */
  onSuccess(): void {
    this.failures = 0;
    if (this.state === 'half_open') {
      this.state = 'closed';
      this.probeInFlight = false;
    }
  }

  /** 可熔断失败：half_open 探测失败 → 回 open 重计时；closed 累计超阈值 → open。 */
  onFailure(): void {
    if (this.state === 'half_open') {
      this.state = 'open';
      this.openedAt = Date.now();
      this.probeInFlight = false;
      this.failures = 0;
      return;
    }
    this.failures++;
    if (this.failures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = Date.now();
      this.failures = 0;
    }
  }

  /**
   * NETOPT-6①（PK-09 parity）：half-open 探测以**不可熔断**结果结束时释放探测槽。
   *
   * python autocodeflow-http client.py 的 `_request` 用
   * ``finally: if probe_acquired: release_probe()`` 保证探测槽在所有路径
   * （成功 / 可熔断失败 / 不可熔断失败）上都释放；本包旧实现里探测请求收到
   * 4xx 这类不可重试错误时既不走 `onSuccess` 也不走 `onFailure`，
   * `probeInFlight` 永久为 true → half_open 态再无请求可放行 → 该 HttpClient
   * 进程内永久砖死（后续全部抛 `CircuitBreakerOpenError`）。
   *
   * 注意：**只允许实际占用探测槽的那个请求**调用（`send()` 在 tryAcquire
   * 返回 true 且此刻状态为 half_open 时记录持有）；并发被拒的请求不得调用，
   * 否则会提前释放他人在飞的探测槽。状态为 closed/open 时调用是无害 no-op
   * （probeInFlight 仅在 half_open 态为 true）。
   */
  onProbeSettled(): void {
    this.probeInFlight = false;
  }

  /** 测试/观测钩子。 */
  getState(): 'closed' | 'open' | 'half_open' {
    return this.state;
  }

  /** 测试钩子：强制 open（供熔断测试快速进入开断态）。 */
  forceOpenForTest(): void {
    this.state = 'open';
    this.openedAt = Date.now();
  }

  /** 测试钩子：复位（供熔断测试清理实例间状态）。 */
  resetForTest(): void {
    this.state = 'closed';
    this.failures = 0;
    this.openedAt = 0;
    this.probeInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// B-4 工具函数（独立导出便于单测）
// ---------------------------------------------------------------------------

/** 网络层错误（无 HTTP 响应）——axios code 判定，对齐 python Timeout/Connect/NetworkError。 */
export function isNetworkLevelError(error: unknown): boolean {
  const code = (error as AxiosError)?.code;
  if (!code) return false;
  return [
    'ECONNABORTED', // 超时（axios timeout）
    'ECONNREFUSED',
    'ECONNRESET',
    'ENETUNREACH',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ENOTFOUND',
    'EHOSTUNREACH',
    'ERR_NETWORK',
  ].includes(code);
}

// ---------------------------------------------------------------------------
// R31-E1: 稳定错误码透传（消费 admin-api 全量错误码化的错误体）
// ---------------------------------------------------------------------------
// admin-api 的错误响应体形如
//   { code: <数字 HTTP 状态>, message: <中文兜底>, errorCode: '<稳定码>', params: {...} }
// 此前响应拦截器只把 `message` 拼进 `err.message`，`errorCode` / `params`
// 被直接丢弃——任务脚本只能字符串匹配中文兜底文案来分支（文案改一个字就
// 静默断掉），也拿不到插值参数。这里把两者**原样挂到被 reject 的 Error 上**：
//
// - 只**新增**只读属性：`err.message` 的拼接语义逐字节不变（既有调用方零影响）；
// - 无码时（老后端 / 非本机制的错误体）**不添加**任何属性——不制造
//   `errorCode: undefined` 这种"有键无值"的形态，`'errorCode' in err` 仍可靠；
// - 挂载失败（异常对象被冻结 / 不可扩展）绝不吞掉原始错误，只是不带码。

/**
 * 带稳定错误码的 HTTP 错误。
 *
 * axios 的 `AxiosError` 在运行时被**就地标记**为本类型（不新建类，故
 * `instanceof Error` / `instanceof AxiosError` / 既有的 `rejects.toBe(err)`
 * 断言全部保持）。用法：`catch (e) { if (getErrorCode(e) === 'TASK_NOT_FOUND') … }`
 * 或 `const err = e as HttpClientError`。
 */
export interface HttpClientError extends Error {
  /** 服务端稳定错误码（如 `TASK_NOT_FOUND`）；无码时该键不存在。 */
  readonly errorCode?: string;
  /** 错误码的插值参数（模板里的 `{{name}}` ← `params.name`）；无参时该键不存在。 */
  readonly params?: Record<string, unknown>;
}

/** 从任意错误上读稳定码；无码 / 非字符串 → `undefined`（永不抛）。 */
export function getErrorCode(error: unknown): string | undefined {
  const value = (error as { errorCode?: unknown } | null | undefined)?.errorCode;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** 从任意错误上读插值参数；无参 / 非普通对象 → `undefined`（永不抛）。 */
export function getErrorParams(
  error: unknown,
): Record<string, unknown> | undefined {
  const value = (error as { params?: unknown } | null | undefined)?.params;
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 只读定义（可枚举，便于日志 / `JSON.stringify` 落到 meta 里）。 */
function defineErrorField(
  target: object,
  key: 'errorCode' | 'params',
  value: unknown,
): void {
  try {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: false,
    });
  } catch {
    // 冻结 / 不可扩展的异常对象：宁可不带码，也绝不吞掉原始错误。
  }
}

/**
 * 把错误响应体里的 `errorCode` / `params` 挂到错误对象上，返回同一个对象
 * （拦截器 `Promise.reject(attachErrorCode(error))` 即可，保持引用不变）。
 *
 * 只做「有值才挂」：既有的错误体（只有 `message`）对象形状完全不变。
 */
export function attachErrorCode(error: unknown): unknown {
  if (error === null || typeof error !== 'object') return error;
  const data = (error as { response?: { data?: unknown } }).response?.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return error;
  }
  const payload = data as { errorCode?: unknown; params?: unknown };
  const errorCode =
    typeof payload.errorCode === 'string' && payload.errorCode.length > 0
      ? payload.errorCode
      : undefined;
  if (errorCode !== undefined) {
    defineErrorField(error, 'errorCode', errorCode);
  }
  const params = payload.params;
  if (params !== null && typeof params === 'object' && !Array.isArray(params)) {
    defineErrorField(error, 'params', params);
  }
  return error;
}

/** 是否可重试错误（状态码在可重试集，或网络层错误）——与 python 可重试异常集对齐。 */
export function isRetryableError(
  error: unknown,
  retryableStatuses: readonly number[] = RETRYABLE_HTTP_STATUSES,
): boolean {
  const status = (error as AxiosError)?.response?.status;
  if (typeof status === 'number' && retryableStatuses.includes(status)) {
    return true;
  }
  return isNetworkLevelError(error);
}

/**
 * NETOPT-G P2-1: 回调通道（POST /api/executions/callback）的 5xx 全量可重试判定
 * ——对齐 python callback.py 的 `status_code >= 500 or == 429`。RETRYABLE_HTTP_
 * STATUSES 只列常见 5xx（429/500/502/503/504），501/505/507/508/599 等非常见
 * 码 python 会同源退避重试、node 此前单发即抛——"一次抖动丢终态"洞在非常见
 * 码上残留。仅在 isTerminalCallbackUrl 为真时叠加本判定（safe-GET 路径保持
 * 原集合，避免把 501 也纳入常规重试面）。
 */
export function isCallbackRetryableStatus(error: unknown): boolean {
  const status = (error as AxiosError)?.response?.status;
  return typeof status === 'number' && (status >= 500 || status === 429);
}

/**
 * 解析 `Retry-After` 头（delta-seconds 或 HTTP-date），失败返回 null。
 * 与 python `_parse_retry_after` 语义对齐（只读头部，不做网络时间同步）。
 */
export function parseRetryAfterHeader(error: unknown): number | null {
  const value = (error as AxiosError)?.response?.headers?.['retry-after'];
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const secs = parseInt(raw, 10);
    return Number.isFinite(secs) ? secs * 1000 : null;
  }
  // HTTP-date（如 Wed, 21 Oct 2015 07:28:00 GMT）
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? Math.max(0, parsed - Date.now()) : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HttpClient {
  private readonly client?: AxiosInstance;
  // B-4: 声明处给默认值（禁用态 early-return 时也满足 strictPropertyInitialization）
  private readonly retry: HttpRetryConfig = { ...DEFAULT_HTTP_RETRY };
  private readonly breaker: CircuitBreaker = new CircuitBreaker();

  /** Whether this client has the credentials needed to reach the Admin API. */
  readonly enabled: boolean;

  /** Reason for being disabled (populated only when `enabled === false`). */
  readonly disabledReason?: string;

  constructor(
    baseURL?: string,
    private readonly token?: string,
    private readonly traceId?: string,
    /**
     * N27: the executor address to stamp on callback items. Injected by
     * executor-node as `AUTOFLOW_EXECUTOR_ADDRESS`; the per-execution
     * callback path (`v1.` token) requires `executorAddress` on every
     * item, and task code has no other reliable source for it.
     */
    private readonly executorAddress?: string,
    /**
     * B-4: 可靠性配置（重试 + 熔断，默认与 python SDK 对齐）。调用方可按需
     * 覆盖；`retry: null` 显式关闭重试/熔断（保持旧薄包装行为）。
     *
     * DX-01（2026-10-29）：`null` 是**关闭**、`undefined` 是**走默认**——
     * 两者在那之前共用一条分支，于是 `null` 成了空操作。现由 `normalizeRetry`
     * 归一成可断言的确定形态（`maxRetries=0` + `breakerEnabled=false`）。
     */
    options?: { retry?: Partial<HttpRetryConfig> | null },
    /**
     * ADR-017 阶段 3 (protocol v6): the executor's stable install identity to
     * stamp on callback items, injected by executor-node as
     * `AUTOFLOW_DEVICE_FINGERPRINT`. Same optional semantics as
     * `executorAddress`: absent on older executors or a failed probe, in
     * which case the key is omitted from callback items entirely.
     *
     * APPENDED AFTER `options` deliberately: `options` was the established
     * 5th parameter, and every existing call site passes it positionally
     * (`new HttpClient(url, token, traceId, address, { retry })`). Inserting
     * this field before it would silently turn those configs into a
     * fingerprint.
     */
    private readonly deviceFingerprint?: string,
  ) {
    this.enabled = Boolean(baseURL && token);
    if (!this.enabled) {
      this.disabledReason =
        'HttpClient is disabled: Admin API credentials are missing ' +
        '(AUTOFLOW_ADMIN_API_URL / AUTOFLOW_CALLBACK_TOKEN — or the legacy ' +
        'ADMIN_API_URL / EXECUTOR_TOKEN — were not present in the ' +
        'environment; older executors never inject them, see SEC-01/N23). ' +
        'Provide them explicitly via TaskContext.create() if callbacks ' +
        'are required.';
      return;
    }
    // B-4: 收敛配置（retry: null → 关断重试/熔断，即旧薄包装行为）。
    // DX-01：归一逻辑集中在导出纯函数 normalizeRetry 里，单测直接喂 null /
    // undefined / 对象三态断言产物，不必绕过 private 字段。
    this.retry = normalizeRetry(options?.retry);
    this.breaker.resetForTest();
    // 10s default matches the python SDK (callback.py) so a hung admin-api
    // can't stall the task process until the executor's timeout kill; callers
    // can still override per-request via axios config.
    //
    // SDK-BASE-01（本轮审计）：请求路径是绝对的 `/api/executions/callback`
    // （context.ts 的 reportSuccess/reportFailure），而 axios 对 baseURL 与
    // 绝对路径的拼接就是简单串接。于是当操作者把 ADMIN_API_URL 配成带 `/api`
    // 后缀的惯用形式时（`http://host:3105/api`），实际请求会变成
    // `/api/api/executions/callback` → 404，回调通道整体失联且没有任何诊断。
    // python SDK 早已显式容忍这种 base（callback.py: ``if
    // self.admin_api_url.endswith("/api")``），本包此前漏了同样的处理——
    // 这里统一剥掉尾部的 `/api`（可重复），与 python 行为对齐。
    //
    // P3-10 登记注释（2026-10-26）——与 mcp-server api.ts 的 normalizeApiBase
    // 归一**方向相反且各自正确**：本处是**剥** /api——本包请求路径常量已自带
    // `/api` 前缀，baseURL 再带就是双前缀 404；mcp-server 是**补** /api——
    // 它的请求路径不带前缀，baseURL 必须补齐。两侧消费的路径集不同，行为
    // 不可互换；改任何一侧前先读对方注释。
    this.client = axios.create({ baseURL: stripTrailingApiSuffix(baseURL), timeout: 10_000 });

    // Attach auth + trace headers on every outgoing request.
    this.client.interceptors.request.use((config) => {
      config.headers = config.headers ?? {};
      config.headers['Authorization'] = `Bearer ${this.token}`;
      if (this.traceId) {
        config.headers['X-Trace-Id'] = this.traceId;
      }
      return config;
    });

    // U14: keep failure messages readable. admin-api errors arrive in the
    // same `{ code, message, data }` envelope (HttpExceptionFilter); surface
    // the server-side reason in the rejected Error instead of axios's bare
    // "Request failed with status code 401".
    //
    // R31-E1: 同一个拦截器顺带把 `errorCode` / `params` 挂到被 reject 的错误上
    // ——此前这两个字段在这里被丢弃，脚本无法按码分支（见上方 attachErrorCode）。
    // 顺序刻意放在 message 拼接**之后**：即使某个字段的挂载抛错（已在
    // attachErrorCode 内部吞掉），message 的既有语义也已经落地。
    this.client.interceptors.response.use(undefined, (error: unknown) => {
      const data = (error as { response?: { data?: unknown } })?.response?.data;
      const message =
        data && typeof data === 'object'
          ? (data as { message?: unknown }).message
          : undefined;
      if (typeof message === 'string' && message) {
        const err = error as Error;
        if (!err.message.includes(message)) {
          err.message = `${err.message}: ${message}`;
        }
      }
      return Promise.reject(attachErrorCode(error));
    });
  }

  // ------------------------------------------------------------------ factory

  /**
   * Create an `HttpClient` pre-configured for the Admin API using the
   * values found in a `TaskEnv` object. Returns a disabled client when
   * credentials are absent (see N23).
   */
  static forAdminApi(env: TaskEnv): HttpClient {
    return new HttpClient(
      env.adminApiUrl,
      env.executorToken,
      env.traceId,
      env.executorAddress,
      undefined, // options (retry/breaker keep their B-4 defaults)
      env.deviceFingerprint,
    );
  }

  // ------------------------------------------------------------------ methods

  /**
   * N27: the Admin API's per-execution callback path requires
   * `executorAddress` on every item. When this client knows the executor
   * address (injected `AUTOFLOW_EXECUTOR_ADDRESS`), items that omit it are
   * stamped with it automatically; explicitly provided values are never
   * overwritten. Requests to other endpoints pass through untouched.
   *
   * ADR-017 阶段 3 (protocol v6): the same choke point stamps
   * `deviceFingerprint` (`AUTOFLOW_DEVICE_FINGERPRINT`) — it is the callback
   * face's row identity when the shared/legacy token is used. Either field
   * is skipped entirely when unknown (never written as an empty string), and
   * either one is left untouched when the item already carries it.
   */
  private withExecutorAddress(url: string, data?: unknown): unknown {
    // R177-A1: 与 isTerminalCallbackUrl 共用 requestPath 归一化——查询串 /
    // 绝对 URL 不再让盖章静默失效（此前带 ?batch=2 的回调 POST 会漏 stamp，
    // admin 侧该行无法归属到执行器，N27 失效）。
    if (!/\/executions\/callback\/?$/.test(requestPath(url))) {
      return data;
    }
    if (!this.executorAddress && !this.deviceFingerprint) {
      return data;
    }
    if (!Array.isArray(data)) return data;
    return data.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
      const record = item as Record<string, unknown>;
      const stamped: Record<string, unknown> = { ...record };
      let changed = false;
      if (this.executorAddress && !record.executorAddress) {
        stamped.executorAddress = this.executorAddress;
        changed = true;
      }
      if (this.deviceFingerprint && !record.deviceFingerprint) {
        stamped.deviceFingerprint = this.deviceFingerprint;
        changed = true;
      }
      return changed ? stamped : item;
    });
  }

  /** Throws a descriptive error when the client lacks Admin API credentials. */
  private requireEnabled(): AxiosInstance {
    if (!this.client || !this.enabled) {
      // R177-A1: 有类型的配置错，而不是裸 Error（对齐 python CallbackDisabledError）
      throw new HttpClientDisabledError(
        this.disabledReason ?? 'HttpClient is disabled',
      );
    }
    return this.client;
  }

  /**
   * U14: admin-api's global ResponseInterceptor wraps every successful body
   * in a `{ code, message, data }` envelope. Unwrap it so callers get the
   * actual payload — e.g. `POST /api/executions/callback` resolves to
   * `{ results: [...] }` instead of the envelope (where the lookup used to
   * come back `undefined`). Bodies that do not match the envelope shape are
   * returned unchanged.
   *
   * PK-06 (DEEP_REVIEW 0ef3bbe): criterion unified with acf-cli / mcp-server
   * — "payload is an object, has a `data` key, and `code` is a number".
   * Rationale: the ResponseInterceptor's envelope `code` is always numeric
   * (`response.statusCode ?? 200`), so a numeric `code` identifies the
   * envelope precisely; the presence of `message` is no longer part of the
   * test. The old strict-triple check treated a string `code` (e.g.
   * `{code:"200",message:"x",data:{...}}` — a third-party payload that just
   * happens to carry all three keys) as an envelope and unwrapped it, while
   * cli/mcp passed it through — the same payload unwrapped differently on
   * different ends. Mirrors `unwrap_envelope` in the python SDK's
   * callback.py.
   */
  private static unwrapEnvelope<T>(payload: unknown): T {
    if (
      payload !== null &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      'data' in payload &&
      typeof (payload as { code?: unknown }).code === 'number'
    ) {
      return ((payload as { code?: unknown; data?: unknown }).data ??
        (null as unknown)) as T;
    }
    return payload as T;
  }

  /**
   * B-4：统一请求入口——熔断 + 有界重试（对齐 python SDK）。
   *
   * - 每次尝试前先过熔断器（open 且未到复位时间 → 快速失败，不计失败数）；
   * - 可熔断失败（5xx 重试集 / 网络层错误）一律计入熔断（含非幂等方法）；
   * - 仅幂等方法且 `safeMethodsOnly` 时自动重试（指数退避 × Retry-After），
   *   非幂等方法不重试、原样抛出。
   * - DX-01：`breakerEnabled === false`（由 `{retry: null}` 或显式
   *   `{retry:{breakerEnabled:false}}` 归一而来）时，整条熔断路径都跳过——
   *   不 tryAcquire、不累计失败、不抛 CircuitBreakerOpenError。此时错误类型
   *   与「薄包装」一致：只剩 axios 错误本身。
   *
   * 注意：保持按方法名直调 axios 实例（`client.get(url, config)` /
   * `client.post(url, data, config)`），而不是统一走 `client.request({...})`
   * ——既有单测按方法名 mock 并断言调用形状，改走 request 会让 mock 静默失配。
   */
  private async send<T>(
    method: Method,
    url: string,
    data?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    const client = this.requireEnabled();
    const isSafe =
      !this.retry.safeMethodsOnly ||
      SAFE_METHODS.has(method.toUpperCase()) ||
      // NETOPT-F P2-4: callback 直报通道豁免（对齐 autoflow-sdk）。
      isTerminalCallbackUrl(url, method);
    const maxAttempts = this.retry.maxRetries + 1;
    const effectiveMaxWaitMs = effectiveRetryMaxWaitMs(url, method, this.retry);
    // DX-01：熔断开关在进入循环前取一次（this.retry 是 readonly，不会中途变）。
    // 关闭时下面三处 breaker 调用全部短路——`breaker` 实例仍在（测试钩子照常
    // 可用），只是不再参与请求决策。
    const breakerEnabled = this.retry.breakerEnabled;
    // BREAKER-MASK（审计 P3，2026-10-17）：重试途中熔断器打开时，保留真实错误。
    //
    // 缺陷现场：一次 503/超时失败会 `onFailure()` 计熔断；若这次失败恰好把熔断
    // 器推过阈值，下一次循环回到 `tryAcquire()` 就会抛 CircuitBreakerOpenError
    // ——调用方看到的是「熔断器打开」，而**真正的原因**（503 / 连接超时）被
    // 覆盖掉。排障时最需要的信息恰恰是后者（熔断只是它的一种后果）。
    //
    // 现在记住本轮最后一次真实传输错误：循环头被熔断器拒绝时，若已有真实错误
    // 就抛它（熔断器状态仍如实反映在 breaker 上），只有「一次都没发出去就被
    // 熔断器挡住」才抛 CircuitBreakerOpenError（那才是纯熔断语义）。
    let lastTransportError: unknown;

    for (let attempt = 0; ; attempt++) {
      if (breakerEnabled && !this.breaker.tryAcquire()) {
        // BREAKER-MASK：有真实传输错误时优先暴露它（熔断器打开是它的后果，
        // 不是根因）；纯熔断（从未发出请求）才抛 CircuitBreakerOpenError。
        if (lastTransportError !== undefined) throw lastTransportError;
        throw new CircuitBreakerOpenError();
      }
      // NETOPT-6①（PK-09 parity）：本尝试是否占用了 half-open 探测槽。
      // tryAcquire 在 half_open 态返回 true 即恰为本次占用探测槽（并发被拒的
      // 请求在 tryAcquire 处已抛出，不会走到这里）。占用后**所有**出路都必须
      // 释放探测槽：成功 → onSuccess（含清槽）；可熔断失败 → onFailure（half_open
      // 态清槽）；不可熔断失败（如 4xx）→ onProbeSettled。否则探测请求收到
      // 4xx 时 probeInFlight 永久为 true，客户端进程内砖死——镜像 python
      // autocodeflow-http client.py 的 try/finally release_probe()。
      // DX-01：熔断关闭时不存在探测槽（tryAcquire 没被调用过），恒 false。
      const holdsProbe =
        breakerEnabled && this.breaker.getState() === 'half_open';
      let response: AxiosResponse<T>;
      try {
        response = await this.dispatch<T>(client, method, url, data, config);
      } catch (error) {
        // NETOPT-G P2-1: 回调通道 5xx 全量可重试（对齐 python >=500）——非常见
        // 5xx 不在 RETRYABLE_HTTP_STATUSES，叠加回调判定后 501/505/507/508/599
        // 也走有界退避（同时计入熔断，与 python 5xx 计熔断一致）。
        const callbackChannel = isTerminalCallbackUrl(url, method);
        const breakable =
          isRetryableError(error, this.retry.retryableStatuses) ||
          (callbackChannel && isCallbackRetryableStatus(error));
        // DX-01：`breakable` 仍用于 canRetry 判定；只有「记账/快速失败」这一半
        // 归熔断器管，故 breaker 关闭时 onFailure 一并短路。
        if (breakable) {
          if (breakerEnabled) this.breaker.onFailure();
        } else if (holdsProbe) this.breaker.onProbeSettled();
        const canRetry =
          breakable && isSafe && attempt < maxAttempts - 1;
        if (!canRetry) throw error;
        // BREAKER-MASK: 记住真实错误——若下一轮被熔断器挡住，抛的是它。
        lastTransportError = error;
        // 指数退避（封顶 maxWaitMs），并与 Retry-After 头取大（同样封顶）
        const backoff = Math.min(
          effectiveMaxWaitMs,
          this.retry.minWaitMs * 2 ** attempt,
        );
        const retryAfter = parseRetryAfterHeader(error);
        const waitMs = Math.min(
          effectiveMaxWaitMs,
          retryAfter === null ? backoff : Math.max(backoff, retryAfter),
        );
        await sleep(waitMs);
        continue;
      }
      if (breakerEnabled) this.breaker.onSuccess();
      return HttpClient.unwrapEnvelope<T>(response.data);
    }
  }

  /** B-4：按方法名直调 axios 实例（带请求体的走 (url, data, config)）。 */
  private async dispatch<T>(
    client: AxiosInstance,
    method: Method,
    url: string,
    data?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    const m = method.toLowerCase();
    if (m === 'post' || m === 'put' || m === 'patch') {
      return client[m]<T>(url, data, config);
    }
    return client[m as 'get' | 'delete' | 'head' | 'options']<T>(url, config);
  }

  async get<T = unknown>(
    url: string,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    return this.send<T>('GET', url, undefined, config);
  }

  async post<T = unknown>(
    url: string,
    data?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    return this.send<T>('POST', url, this.withExecutorAddress(url, data), config);
  }

  async put<T = unknown>(
    url: string,
    data?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    return this.send<T>('PUT', url, data, config);
  }

  async delete<T = unknown>(
    url: string,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    return this.send<T>('DELETE', url, undefined, config);
  }
}
