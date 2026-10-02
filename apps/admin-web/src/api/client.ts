import axios from 'axios';
// TOAST-01：走 utils/toast 出口（App 实例优先，暗色主题下 toast 样式正确）
import { message as antMessage } from '../utils/toast';
import { useAuthStore } from '../store/auth';
import type { AuthUser as AuthStateUser } from '../store/auth';
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

/**
 * DUP-TOAST（本轮审计）：给「拦截器已弹过 toast」的 reject 值打标，
 * utils/error.showApiError 据此跳过页面 catch 里的重复兜底 toast。
 * 注意：只在**实际弹过 toast**的分支打标（401 静默跳登录分支不打标，
 * 保持该路径页面兜底提示的原有行为）。
 */
function markToastedByClient(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    (value as Record<string, unknown>)['__toastedByClient'] = true;
  }
}

// Q-02: read token from the Zustand auth store — single source of truth.
client.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// ─── A-4（R3-A 审计）: 多标签页互踢修复 ─────────────────────────────────────
// zustand persist 的落盘 key（store/auth.ts）。后端 refresh 是「轮换即吊销」
// （auth.service.refreshToken 先吊销旧 jti 再签发），refresh token 只在当前
// tab 的内存里可用一次；tab A 轮换后把新值写回 localStorage，tab B 内存里
// 的旧值再去 refresh 必 401 → 被踢回 /login。修复两件事：
//   ① refresh 前从 localStorage 重读最新持久化 token（读到更新的就用新的
//      并同步内存）；
//   ② storage 事件监听同步（另一 tab 登录/登出/轮换时本 tab 内存跟随），
//      防 localStorage 与内存漂移。
const AUTH_PERSIST_KEY = 'autoflow-auth';

interface PersistedAuthState {
  token: string | null;
  refreshToken: string | null;
  user: unknown;
}

/** 读取 persist 落盘的认证状态；key 缺失/损坏 → null（调用方自行回落）。 */
function readPersistedAuthState(): PersistedAuthState | null {
  try {
    const raw = localStorage.getItem(AUTH_PERSIST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: Partial<PersistedAuthState> };
    if (!parsed?.state) return null;
    return {
      token: typeof parsed.state.token === 'string' ? parsed.state.token : null,
      refreshToken:
        typeof parsed.state.refreshToken === 'string'
          ? parsed.state.refreshToken
          : null,
      user: parsed.state.user ?? null,
    };
  } catch {
    return null;
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    // storage 事件只在「其他 tab」写入时触发（本 tab 自写不触发，无回环）。
    if (event.key !== AUTH_PERSIST_KEY) return;
    const persisted = readPersistedAuthState();
    // 落盘被清空/损坏/另一 tab 已登出（token+refresh 双空）——按「已登出」
    // 对齐本 tab 内存（fail-safe，与 store 的 logout() 同落点）。
    if (!persisted || (!persisted.token && !persisted.refreshToken)) {
      useAuthStore.getState().logout();
      return;
    }
    const { setToken, setRefreshToken, setUser } = useAuthStore.getState();
    if (persisted.token && useAuthStore.getState().token !== persisted.token) {
      setToken(persisted.token);
    }
    if (
      persisted.refreshToken &&
      useAuthStore.getState().refreshToken !== persisted.refreshToken
    ) {
      setRefreshToken(persisted.refreshToken);
    }
    if (persisted.user && useAuthStore.getState().user !== persisted.user) {
      setUser(persisted.user as AuthStateUser);
    }
  });
}

// Track in-flight refresh to avoid concurrent refresh storms
let refreshPromise: Promise<string> | null = null;

async function tryRefreshToken(): Promise<string> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const { setToken, setRefreshToken } = useAuthStore.getState();
    // A-4: refresh 前以 localStorage 为准重读最新 refresh token —— 另一 tab
    // 可能已完成轮换并写回新值。读到不同的 token 视为另一 tab 的更新：先
    // 同步内存（access token 一并带上，避免旧 access 被继续外发），再用新值
    // 去 refresh。单飞 refreshPromise 结构不变（重读仍在单飞闭包内执行）。
    const persisted = readPersistedAuthState();
    let refreshToken = useAuthStore.getState().refreshToken;
    if (persisted?.refreshToken && persisted.refreshToken !== refreshToken) {
      setRefreshToken(persisted.refreshToken);
      if (persisted.token) setToken(persisted.token);
      refreshToken = persisted.refreshToken;
    }
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
    // NETOPT-7①（2026-09-20）：主动取消（TasksTab 翻页/卸载 abort、TaskFormPage effect abort、
    // TanStack refetch 压制）产生的 CanceledError 不是网络故障：既不能走安全方法重试
    // （重试用同一已 aborted 的 signal 会立即再抛、白睡 1s），也不能落下方 !err.response
    // 分支弹假「网络连接失败」。该检查必须在访问 err.config 之前——派发前已 abort 的
    // CanceledError 可能没有 config，下方 _retryCount 访问会抛 TypeError。
    if (axios.isCancel(err) || err?.code === 'ERR_CANCELED') return Promise.reject(err);
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
    // DUP-TOAST（本轮审计）：拦截器统一弹错后，页面 catch 里的 showApiError
    // 兜底原先还会对同一失败再弹一次（message.error + getErrMsg 的组合
    // 全站约 90 处）——同一次失败连弹两条。这里在实际 reject 的值上打标去重。
    // reject 形态是 `err.response?.data || err`（envelope 对象或 axios error
    // 本身），标必须打在页面 catch **实际收到**的那个值上；响应体为字符串
    // 原语时挂不上属性（不打标，页面兜底会补一条，可接受的边界）。
    const rejectValue: unknown = err.response?.data || err;
    // P1-3（生产审查）：把 HTTP 状态码以数字型 `__status` 挂在页面 catch 实际
    // 收到的 rejectValue 上。此前 utils/error.isNotFoundError 只会读原始 axios
    // error 的 `response.status`，而本拦截器 reject 的是 `err.response?.data`
    // （.response 已剥掉）——404 判定恒为 false，「404 → 跳回列表」分支从未
    // 生效。与 markToastedByClient 同点合并打标：同样只在 rejectValue 是对象时
    // 可挂；响应体为字符串原语挂不上（isNotFoundError 退回旧的
    // response?.status 路径，可接受边界，与上方注释口径一致）。
    if (err.response && rejectValue !== null && typeof rejectValue === 'object') {
      (rejectValue as Record<string, unknown>)['__status'] = status;
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
      markToastedByClient(rejectValue);
    } else if (!err.response) {
      // Network error
      antMessage.error(i18n.t('http.error.network'), 4);
      markToastedByClient(rejectValue);
    }
    // 401 静默跳登录分支未弹 toast，不打标——页面兜底行为与之前逐位一致。
    return Promise.reject(rejectValue);
  },
);
