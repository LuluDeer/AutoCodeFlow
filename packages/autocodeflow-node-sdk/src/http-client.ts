import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
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
 */
export class HttpClient {
  private readonly client?: AxiosInstance;

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
    // 10s default matches the python SDK (callback.py) so a hung admin-api
    // can't stall the task process until the executor's timeout kill; callers
    // can still override per-request via axios config.
    this.client = axios.create({ baseURL, timeout: 10_000 });

    // Attach auth + trace headers on every outgoing request.
    this.client.interceptors.request.use((config) => {
      config.headers = config.headers ?? {};
      config.headers['Authorization'] = `Bearer ${this.token}`;
      if (this.traceId) {
        config.headers['X-Trace-Id'] = this.traceId;
      }
      return config;
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

  async get<T = unknown>(
    url: string,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    const response: AxiosResponse<T> = await this.requireEnabled().get<T>(url, config);
    return response.data;
  }

  async post<T = unknown>(
    url: string,
    data?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    const response: AxiosResponse<T> = await this.requireEnabled().post<T>(
      url,
      this.withExecutorAddress(url, data),
      config,
    );
    return response.data;
  }

  async put<T = unknown>(
    url: string,
    data?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    const response: AxiosResponse<T> = await this.requireEnabled().put<T>(
      url,
      data,
      config,
    );
    return response.data;
  }

  async delete<T = unknown>(
    url: string,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    const response: AxiosResponse<T> = await this.requireEnabled().delete<T>(
      url,
      config,
    );
    return response.data;
  }
}
