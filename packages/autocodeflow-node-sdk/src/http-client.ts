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
 * U14: admin-api wraps every response body in a `{ code, message, data }`
 * envelope (global ResponseInterceptor). The request helpers unwrap it and
 * resolve with the inner `data`, so `results`-style lookups on a callback
 * response work; rejected requests get the envelope's `message` appended to
 * the axios error message.
 *
 * B-4（中台↔执行器深度审查）：与 python SDK（autocodeflow-http client.py）的
 * 可靠性契约**对齐**——旧实现是纯 axios 薄包装（无重试、无熔断），而 python
 * SDK 有完整「重试 + 熔断 + Retry-After 头解析」契约；两侧行为不对齐会让跨
 * SDK 消费方对可靠性产生错误预期。本包现补齐同款语义：
 * - 重试：仅幂等方法（GET/HEAD/OPTIONS，`safeMethodsOnly`）在可重试错误上重试
 *   （429/500/502/503/504 或网络层错误：超时/连接拒绝/断网），指数退避
 *   （minWaitMs×2^n，封顶 maxWaitMs），尊重 `Retry-After` 头（delta-seconds
 *   或 HTTP-date，取 max(退避, Retry-After)）；
 * - 熔断：failureThreshold 次连续可熔断错误 → open（快速失败，
 *   `CircuitBreakerOpenError`）；resetTimeoutMs 后 half-open 放行单个探测请求，
 *   成功即 closed，失败重新 open——与 python 的 `_CircuitBreaker` 同构；
 * - 非幂等方法（POST/PUT/DELETE）**不自动重试**，但同样计入熔断失败
 *   （与 python `_should_retry` 语义一致）。
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

/** 与 python `_RETRYABLE_HTTP_STATUSES = {429, 500, 502, 503, 504}` 对齐。 */
export const RETRYABLE_HTTP_STATUSES: readonly number[] = [429, 500, 502, 503, 504];

export interface HttpRetryConfig {
  /** 最大重试次数（不含首次请求；默认 3 → 至多 4 次尝试，对齐 python max_retries）。 */
  maxRetries: number;
  /** 首次退避基数（ms；默认 1000，对齐 python min_wait=1.0s）。 */
  minWaitMs: number;
  /** 退避上限（ms；默认 30000，对齐 python max_wait=30.0s）。 */
  maxWaitMs: number;
  /** 可重试的 HTTP 状态码（默认 429/500/502/503/504）。 */
  retryableStatuses: readonly number[];
  /** 仅幂等方法（GET/HEAD/OPTIONS）自动重试；非幂等只计入熔断（对齐 python）。 */
  safeMethodsOnly: boolean;
}

export const DEFAULT_HTTP_RETRY: HttpRetryConfig = {
  maxRetries: 3,
  minWaitMs: 1_000,
  maxWaitMs: 30_000,
  retryableStatuses: RETRYABLE_HTTP_STATUSES,
  safeMethodsOnly: true,
};

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
     */
    options?: { retry?: Partial<HttpRetryConfig> | null },
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
    // B-4: 收敛配置（retry: null → 关断重试/熔断，即旧薄包装行为）
    this.retry = options?.retry
      ? { ...DEFAULT_HTTP_RETRY, ...options.retry }
      : { ...DEFAULT_HTTP_RETRY };
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
      return Promise.reject(error);
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
    );
  }

  // ------------------------------------------------------------------ methods

  /**
   * N27: the Admin API's per-execution callback path requires
   * `executorAddress` on every item. When this client knows the executor
   * address (injected `AUTOFLOW_EXECUTOR_ADDRESS`), items that omit it are
   * stamped with it automatically; explicitly provided values are never
   * overwritten. Requests to other endpoints pass through untouched.
   */
  private withExecutorAddress(url: string, data?: unknown): unknown {
    if (!this.executorAddress || !/\/executions\/callback\/?$/.test(url)) {
      return data;
    }
    if (!Array.isArray(data)) return data;
    return data.map((item) => {
      if (
        item &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        !(item as { executorAddress?: unknown }).executorAddress
      ) {
        return { ...(item as object), executorAddress: this.executorAddress };
      }
      return item;
    });
  }

  /** Throws a descriptive error when the client lacks Admin API credentials. */
  private requireEnabled(): AxiosInstance {
    if (!this.client || !this.enabled) {
      throw new Error(this.disabledReason ?? 'HttpClient is disabled');
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
      !this.retry.safeMethodsOnly || SAFE_METHODS.has(method.toUpperCase());
    const maxAttempts = this.retry.maxRetries + 1;

    for (let attempt = 0; ; attempt++) {
      if (!this.breaker.tryAcquire()) {
        throw new CircuitBreakerOpenError();
      }
      let response: AxiosResponse<T>;
      try {
        response = await this.dispatch<T>(client, method, url, data, config);
      } catch (error) {
        const breakable = isRetryableError(error, this.retry.retryableStatuses);
        if (breakable) this.breaker.onFailure();
        const canRetry =
          breakable && isSafe && attempt < maxAttempts - 1;
        if (!canRetry) throw error;
        // 指数退避（封顶 maxWaitMs），并与 Retry-After 头取大（同样封顶）
        const backoff = Math.min(
          this.retry.maxWaitMs,
          this.retry.minWaitMs * 2 ** attempt,
        );
        const retryAfter = parseRetryAfterHeader(error);
        const waitMs = Math.min(
          this.retry.maxWaitMs,
          retryAfter === null ? backoff : Math.max(backoff, retryAfter),
        );
        await sleep(waitMs);
        continue;
      }
      this.breaker.onSuccess();
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
