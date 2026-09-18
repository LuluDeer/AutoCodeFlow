import axios from 'axios';
import { message as antMessage } from 'antd';
import { useAuthStore } from '../store/auth';
// F-1：拦截器非 React 组件，直接引用 i18n 单例（与 utils/locale.ts 同模式），
// 使 403/404/409/429/5xx/网络错误提示随当前语言切换，而非全站硬编码中文。
import i18n from '../i18n';

const API_URL_INTERNAL = import.meta.env.VITE_API_URL_INTERNAL || '/api';
const API_URL_EXTERNAL = import.meta.env.VITE_API_URL_EXTERNAL || '';

export function getApiBaseUrl(): string {
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
    // Discard refresh results from a session that has logged out or changed.
    if (useAuthStore.getState().refreshToken !== refreshToken) throw new Error('Auth session changed');
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
    // 401 跳登录时带上当前路由，登录成功后回跳（LoginPage 读 ?redirect=）
    //
    // SESSION-EXPIRED（本轮审计）：401 且刷新令牌也失败时，用户会被直接丢到
    // /login，而下方 toast 分支显式跳过了 401（`status !== 401`）——于是整个
    // 过程**零提示**：正在填的表单凭空消失、页面变白，用户无法区分「会话过期」
    // 「密码被改」「账号被禁用」还是「系统故障」。这里带一个 reason 参数，
    // 由登录页说明原因（与 ?redirect= 同一条 URL，同属站内可控值）。
    const redirectToLogin = (reason?: 'expired') => {
      const current = window.location.pathname + window.location.search;
      const params = new URLSearchParams();
      if (current && current !== '/login') params.set('redirect', current);
      if (reason) params.set('reason', reason);
      const qs = params.toString();
      window.location.href = `/login${qs ? `?${qs}` : ''}`;
    };
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
        redirectToLogin('expired');
      }
    } else if (err.response?.status === 401) {
      useAuthStore.getState().logout();
      redirectToLogin('expired');
    }
    // F-32（DEEP_REVIEW 0ef3bbe）：本层是全站**唯一**的重试层（安全方法 1 次、1s 退避）。
    // TanStack Query 侧已显式 retry:false（见 api/queryClient.ts），避免"axios 1 次 ×
    // Query 2 次"叠加成一次失败 6 发请求 + 多条重复 toast。
    // Retry only safe methods: a failed response may still have caused side effects.
    if (!originalRequest._retryCount) originalRequest._retryCount = 0;
    const status = err.response?.status;
    const isSafeMethod = ['get', 'head', 'options'].includes((originalRequest.method || 'get').toLowerCase());
    if (isSafeMethod && originalRequest._retryCount < 1 && (!err.response || (status >= 500 && status < 600))) {
      originalRequest._retryCount++;
      await new Promise<void>(resolve => setTimeout(resolve, 1000));
      return _client(originalRequest);
    }
    // Show a user-friendly toast for common HTTP errors (skip 401 which is handled above)
    if (status && status !== 401) {
      // F-1：HTTP 状态文案走 i18n（key: http.error.<code>），业务 message/error 仍优先。
      const httpKey =
        status === 403 ? 'http.error.403' :
        status === 404 ? 'http.error.404' :
        status === 409 ? 'http.error.409' :
        status === 429 ? 'http.error.429' :
        status === 500 ? 'http.error.500' :
        status === 503 ? 'http.error.503' :
        'http.error.unknown';
      const msg =
        err.response?.data?.message ||
        err.response?.data?.error ||
        i18n.t(httpKey, { status });
      antMessage.error(msg, 4);
    } else if (!err.response) {
      // Network error
      antMessage.error(i18n.t('http.error.network'), 4);
    }
    return Promise.reject(err.response?.data || err);
  },
);
