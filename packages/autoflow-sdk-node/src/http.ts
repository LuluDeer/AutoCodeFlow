import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';

/**
 * AutoFlowHTTP — HTTP client for task execution.
 * Provides get/post/put/delete with automatic error handling.
 */
export class AutoFlowHTTP {
  private client: AxiosInstance;

  constructor(config?: AxiosRequestConfig) {
    this.client = axios.create({
      timeout: 30_000,
      ...config,
    });
  }

  async get<T = unknown>(url: string, options?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.client.get<T>(url, options);
  }

  async post<T = unknown>(url: string, data?: unknown, options?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.client.post<T>(url, data, options);
  }

  async put<T = unknown>(url: string, data?: unknown, options?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.client.put<T>(url, data, options);
  }

  async delete<T = unknown>(url: string, options?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.client.delete<T>(url, options);
  }
}