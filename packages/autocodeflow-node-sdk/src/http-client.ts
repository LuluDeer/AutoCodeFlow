import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { TaskEnv } from './types';

/**
 * Thin wrapper around Axios that:
 * - automatically sets `Authorization: Bearer <token>`
 * - automatically sets `X-Trace-Id` when a trace ID is available
 * - exposes typed `get / post / put / delete` helpers
 */
export class HttpClient {
  private readonly client: AxiosInstance;

  constructor(
    baseURL: string,
    private readonly token: string,
    private readonly traceId?: string,
  ) {
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
   * values found in a `TaskEnv` object.
   */
  static forAdminApi(env: TaskEnv): HttpClient {
    return new HttpClient(env.adminApiUrl, env.executorToken, env.traceId);
  }

  // ------------------------------------------------------------------ methods

  async get<T = unknown>(
    url: string,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    const response: AxiosResponse<T> = await this.client.get<T>(url, config);
    return response.data;
  }

  async post<T = unknown>(
    url: string,
    data?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    const response: AxiosResponse<T> = await this.client.post<T>(
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
    const response: AxiosResponse<T> = await this.client.put<T>(
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
    const response: AxiosResponse<T> = await this.client.delete<T>(
      url,
      config,
    );
    return response.data;
  }
}
