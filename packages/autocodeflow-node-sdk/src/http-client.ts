import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { TaskEnv } from './types';

/**
 * Thin wrapper around Axios that:
 * - automatically sets `Authorization: Bearer <token>`
 * - automatically sets `X-Trace-Id` when a trace ID is available
 * - exposes typed `get / post / put / delete` helpers
 *
 * N23: the executor does not inject Admin API credentials into task
 * subprocesses (SEC-01). A client built without `baseURL`/`token` is
 * therefore *disabled*: construction succeeds, but any request method
 * throws a clear error explaining that callback capability is unavailable.
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
  ) {
    this.enabled = Boolean(baseURL && token);
    if (!this.enabled) {
      this.disabledReason =
        'HttpClient is disabled: Admin API credentials are missing ' +
        '(ADMIN_API_URL / EXECUTOR_TOKEN are not injected into task ' +
        'subprocesses by the executor — see SEC-01). Provide them ' +
        'explicitly via TaskContext.create() if callbacks are required.';
      return;
    }
    this.client = axios.create({ baseURL });

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
    return new HttpClient(env.adminApiUrl, env.executorToken, env.traceId);
  }

  // ------------------------------------------------------------------ methods

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
      data,
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
