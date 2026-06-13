import axios from 'axios';
import { message as antMessage } from 'antd';
import { useAuthStore } from '../store/auth';

const API_URL_INTERNAL = import.meta.env.VITE_API_URL_INTERNAL || '/api';
const API_URL_EXTERNAL = import.meta.env.VITE_API_URL_EXTERNAL || '';

function getApiBaseUrl(): string {
  const useExternal = localStorage.getItem('autoflow_use_external_api') === 'true';
  if (useExternal && API_URL_EXTERNAL) {
    return API_URL_EXTERNAL;
  }
  return API_URL_INTERNAL;
}

// Re-type the axios instance so TypeScript reflects the response interceptor's unwrapping:
// the interceptor strips AxiosResponse<T> down to T, but axios's own types don't model that.
// We cast to a narrower interface that returns Promise<T> directly.
const _client = axios.create({
  baseURL: getApiBaseUrl(),
  timeout: 30000,
});

type RequestConfig = Parameters<typeof _client.get>[1];

export const client = _client as unknown as {
  get<T = unknown>(url: string, config?: RequestConfig): Promise<T>;
  post<T = unknown>(url: string, data?: unknown, config?: RequestConfig): Promise<T>;
  put<T = unknown>(url: string, data?: unknown, config?: RequestConfig): Promise<T>;
  patch<T = unknown>(url: string, data?: unknown, config?: RequestConfig): Promise<T>;
  delete<T = unknown>(url: string, config?: RequestConfig): Promise<T>;
  interceptors: typeof _client.interceptors;
  defaults: typeof _client.defaults;
  (config: Parameters<typeof _client>[0]): Promise<unknown>;
};

export function setApiEnvironment(useExternal: boolean): void {
  localStorage.setItem('autoflow_use_external_api', String(useExternal));
  client.defaults.baseURL = useExternal && API_URL_EXTERNAL ? API_URL_EXTERNAL : API_URL_INTERNAL;
}

export function getApiEnvironment(): boolean {
  return localStorage.getItem('autoflow_use_external_api') === 'true';
}

export function getAvailableEnvironments(): { internal: string; external: string | null } {
  return {
    internal: API_URL_INTERNAL,
    external: API_URL_EXTERNAL || null,
  };
}

// Q-02: read token from the Zustand auth store — single source of truth.
client.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Track in-flight refresh to avoid concurrent refresh storms
let refreshPromise: Promise<string> | null = null;

async function tryRefreshToken(): Promise<string> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const { refreshToken, setToken, setRefreshToken } = useAuthStore.getState();
    if (!refreshToken) throw new Error('No refresh token');

    // Use a plain axios call to bypass our own response interceptor
    // and avoid an infinite 401 retry loop on the refresh endpoint itself.
    const resp = await axios.post(
      `${getApiBaseUrl()}/auth/refresh`,
      { refreshToken },
      { timeout: 10_000 },
    );
    // axios wraps the body in resp.data; our interceptor unwraps to resp.data for client calls
    const body = resp.data ?? resp;
    const accessToken: string = body.data?.accessToken ?? body.accessToken;
    const newRefresh: string | undefined = body.data?.refreshToken ?? body.refreshToken;
    if (!accessToken) throw new Error('Refresh response missing accessToken');
    setToken(accessToken);
    if (newRefresh) setRefreshToken(newRefresh);
    return accessToken;
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

client.interceptors.response.use(
  // Unwrap both axios layer (res.data) and the API envelope ({ code, data, message })
  (res) => {
    const body = res.data;
    if (body && typeof body === 'object' && 'code' in body && 'data' in body) {
      return body.data;
    }
    return body;
  },
  async (err) => {
    const originalRequest = err.config;
    // Avoid infinite retry loop on the refresh endpoint itself
    if (err.response?.status === 401 && !originalRequest._retried && !originalRequest.url?.includes('/auth/refresh')) {
      originalRequest._retried = true;
      try {
        const newToken = await tryRefreshToken();
        originalRequest.headers = originalRequest.headers ?? {};
        originalRequest.headers['Authorization'] = `Bearer ${newToken}`;
        return client(originalRequest);
      } catch {
        useAuthStore.getState().logout();
        window.location.href = '/login';
      }
    } else if (err.response?.status === 401) {
      useAuthStore.getState().logout();
      window.location.href = '/login';
    }
    // Retry once on transient failures (network error or 5xx)
    if (!originalRequest._retryCount) originalRequest._retryCount = 0;
    const status = err.response?.status;
    if (originalRequest._retryCount < 1 && (!err.response || (status >= 500 && status < 600))) {
      originalRequest._retryCount++;
      await new Promise<void>(resolve => setTimeout(resolve, 1000));
      return _client(originalRequest);
    }
    // Show a user-friendly toast for common HTTP errors (skip 401 which is handled above)
    if (status && status !== 401) {
      const msg =
        err.response?.data?.message ||
        err.response?.data?.error ||
        (status === 403 ? '没有操作权限' :
         status === 404 ? '请求的资源不存在' :
         status === 409 ? '操作冲突，请刷新后重试' :
         status === 429 ? '操作过于频繁，请稍后再试' :
         status === 500 ? '服务器内部错误，请稍后重试' :
         status === 503 ? '服务暂时不可用，请稍后重试' :
         `请求失败（${status}）`);
      antMessage.error(msg, 4);
    } else if (!err.response) {
      // Network error
      antMessage.error('网络连接失败，请检查网络或稍后重试', 4);
    }
    return Promise.reject(err.response?.data || err);
  },
);
