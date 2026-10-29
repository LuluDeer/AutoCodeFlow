import axios from 'axios';
// TOAST-01：走 utils/toast 出口（App 实例优先，暗色主题下 toast 样式正确）
import { message as antMessage } from '../utils/toast';
import { useAuthStore } from '../store/auth';
import type { AuthUser as AuthStateUser } from '../store/auth';
// F-1：拦截器非 React 组件，直接引用 i18n 单例（与 utils/locale.ts 同模式），
// 使 403/404/409/429/5xx/网络错误提示随当前语言切换，而非全站硬编码中文。
import i18n from '../i18n';
// LANG-ERR-01：拦截器是**最常见的用户可见失败出口**（403/404/409/429/5xx 的 toast
// 都在这里弹，且弹完就打 __toastedByClient 标抑制页面兜底），因此它必须和
// utils/error.getErrMsg 走同一条「码 → 当前语言」路径，否则整条码化在前端等于白做。
import { translateByErrorCode } from '../utils/error';

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
 * W3（遗留 E3）：请求级「跳过全局错误 toast」私有标记。
 *
 * 为什么需要：SSE 换票（POST /auth/sse-ticket）走的是共享 client，失败一次
 * 拦截器就弹一条 toast；而换票失败会**按退避节奏反复重试**（3s→6s→…→30s，
 * 全部大于 1500ms 的 toast 去重窗口）。于是后端 5xx/网络抖动时，值班同学会
 * 被同一件事按分钟级节奏反复打扰，而这件事的可见反馈本应由 SSE 客户端自己
 * 收敛成「首次一次、恢复 live 后重算」。标记只影响全局 toast，不影响打标
 * （仍 markToastedByClient，避免页面兜底再补一条重复提示）。
 */
declare module 'axios' {
  export interface AxiosRequestConfig {
    /** 带此标记的请求失败时不弹全局 toast（仍打 __toastedByClient 标） */
    skipGlobalToast?: boolean;
  }
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

/**
 * TOAST-I18N（2026-10-13 生产报障）：识别「框架样板文案」，避免它盖掉 i18n 文案。
 *
 * F-1 的设计是「业务 message 优先，HTTP 状态文案走 i18n（http.error.<code>）」。
 * 但 NestJS 的框架级异常**总是**自带 message，于是 `err.response.data.message`
 * 恒为真，i18n 分支永远轮不到——`http.error.429` 等键实际是**死配置**。
 * 用户报障现场看到的正是这句裸英文：
 *
 *     ThrottlerException: Too Many Requests
 *
 * 而同一状态码在 zh 里本该显示「操作过于频繁，请稍后再试」。
 *
 * 判定口径：只认**框架自己生成**的样板串（状态名 / 异常类名前缀），其余一律当
 * 业务文案原样透出（后端大量业务错误是中文描述，必须保留）。列表故意保守——
 * 宁可漏判（回落旧行为、显示后端原文）也不误判（吃掉业务文案）。不在表内的
 * 文案行为与改动前逐位一致，不会更坏。
 */
const FRAMEWORK_BOILERPLATE_MESSAGES = new Set([
  // @nestjs/common 内置 HttpException 的状态名（initMessage 生成）
  'Bad Request',
  'Unauthorized',
  'Forbidden',
  'Not Found',
  'Conflict',
  'Internal Server Error',
  'Service Unavailable',
  'Too Many Requests',
  // 本仓守卫/过滤器的固定英文文案（roles.guard / http-exception.filter）
  'Forbidden resource',
  'Internal server error',
  'Resource already exists',
  'Related resource not found',
]);

function isFrameworkBoilerplateMessage(msg: string): boolean {
  if (FRAMEWORK_BOILERPLATE_MESSAGES.has(msg)) return true;
  // 形如 `ThrottlerException: Too Many Requests`——任何 NestJS 异常类的
  // `${name}: ${message}` 形态（UnauthorizedException…）都是框架产物，
  // 不是业务语义。
  return /^[A-Za-z]+Exception: /.test(msg);
}

/**
 * 从后端错误体里取「值得直接展示给用户」的业务文案；取不到（缺失/空/纯框架
 * 样板）时返回空串，由调用方回落 i18n 的 http.error.<code>。
 *
 * `message` 可能是字符串（http-exception.filter 的产物）或字符串数组（NestJS
 * ValidationPipe 原始形态）——数组按 '; ' 拼接，与 filter 自己的
 * `Validation failed: a; b` 格式一致，也避免把数组当 ReactNode 直接渲染。
 */
function pickBusinessMessage(
  message: unknown,
  error: unknown,
): string {
  const normalize = (v: unknown): string => {
    if (typeof v === 'string') return v.trim();
    if (Array.isArray(v)) {
      return v.filter((x): x is string => typeof x === 'string' && !!x.trim())
        .join('; ')
        .trim();
    }
    return '';
  };
  for (const candidate of [normalize(message), normalize(error)]) {
    if (candidate && !isFrameworkBoilerplateMessage(candidate)) return candidate;
  }
  return '';
}

/**
 * TOAST-DEDUPE（2026-10-13 生产报障）：短窗内**同文案**只弹一条。
 *
 * 现场症状是「弹出非常多的 ThrottlerException」：应用列表页 26 个并发请求同时
 * 429，每个失败各弹一条**完全相同**的 toast，瞬间叠成一面墙（antd 默认
 * maxCount 很大，且不按内容去重）。同一次故障的 26 条重复提示对用户零信息增量，
 * 只是把真正要看的那句话淹没。
 *
 * 口径：窗口内同文案抑制（1500ms 足以覆盖一次并发扇出的同时到达，又短到不会
 * 吃掉用户「再点一次」的反馈）。不同文案不受影响。
 *
 * 注意：被抑制的请求**仍要**打 `__toastedByClient` 标（见调用点），否则页面
 * catch 的 showApiError 兜底会把它补弹回来，去重形同虚设。
 */
const TOAST_DEDUPE_WINDOW_MS = 1500;
const recentToasts = new Map<string, number>();

/** 测试用：清空去重窗口（模块级状态会跨用例残留）。 */
export function __resetToastDedupe(): void {
  recentToasts.clear();
}

function shouldShowToast(msg: string, now: number = Date.now()): boolean {
  const last = recentToasts.get(msg);
  if (last !== undefined && now - last < TOAST_DEDUPE_WINDOW_MS) return false;
  recentToasts.set(msg, now);
  // 防无界增长：顺手清掉已出窗的键（一次扇出的键数不会多）。
  if (recentToasts.size > 50) {
    for (const [key, at] of recentToasts) {
      if (now - at >= TOAST_DEDUPE_WINDOW_MS) recentToasts.delete(key);
    }
  }
  return true;
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
    // F-13（UIAUDIT P3-6）：另一 tab 登录了**另一个账号**（user.id 变化）→
    // 本 tab 整页 reload。已挂载页面的 TanStack 缓存/视图状态都是前账号的读面
    // （有的页面还有本地 state 副本），只换 token 不清缓存会残留前账号数据
    // 直到下一次 refetch/导航。整页 reload 一次性归还干净初始态——与
    // redirectToLogin 的整页语义对齐（logout 分支同理）。
    // 登出（persisted.user 为空）不走这里：上方分支已按登出处理；本 tab 从
    // 未登录（内存 user 为 null）→ id 不存在「变化」，也不 reload。
    const currentUserId = useAuthStore.getState().user?.id;
    const persistedUserId = (persisted.user as { id?: unknown } | null)?.id;
    if (
      currentUserId != null &&
      persistedUserId != null &&
      persistedUserId !== currentUserId
    ) {
      window.location.reload();
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
    // F-12（UIAUDIT P3-5）：旧判据 `user !== persisted.user` 恒为 true——
    // persisted.user 每次 storage 事件都重新 JSON.parse，对象引用永不可能与
    // 内存 user 相等，短路失效 → 每次跨 tab 认证写入都多一次 setUser（幂等但
    // 多一次重渲染）。改为序列化串比较：同一份 persist 载荷的 user 写入/读回
    // 键序一致，串相等即「没变」，真正变化（如 profile 回写 totpEnabled）才写。
    if (
      persisted.user &&
      JSON.stringify(useAuthStore.getState().user) !==
        JSON.stringify(persisted.user)
    ) {
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

    // F-6（UIUX 审计 P2-5）：「另一 tab 的轮换已生效」判据——不比对「自己
    // 发起时的 RT」，而比对「当前存储 RT（内存/落盘）是否已不是自己这枚」。
    // 是 → 别人的刷新已成功，自己这枚已被后端轮换吊销。
    const supersededByAnotherTab = (): boolean => {
      const memory = useAuthStore.getState().refreshToken;
      if (memory && memory !== refreshToken) return true;
      const disk = readPersistedAuthState()?.refreshToken;
      return !!disk && disk !== refreshToken;
    };
    /** F-6：采纳另一 tab 落盘的新会话（token+RT 一并同步），返回其 access。 */
    const adoptPersistedSession = (): string | null => {
      const fresh = readPersistedAuthState();
      if (!fresh?.token) return null;
      setToken(fresh.token);
      if (fresh.refreshToken) setRefreshToken(fresh.refreshToken);
      return fresh.token;
    };

    // Use a plain axios call to bypass our own response interceptor
    // and avoid an infinite 401 retry loop on the refresh endpoint itself.
    // axios 1.20 泛型默认下 ReturnType<typeof axios.post> 解析为 unknown，
    // 这里显式建模响应体（封套 {data:{...}} 与裸 {...} 两种历史形态）。
    type RefreshBody = {
      data?: { accessToken?: string; refreshToken?: string };
      accessToken?: string;
      refreshToken?: string;
    };
    let resp: import('axios').AxiosResponse<RefreshBody>;
    try {
      resp = await axios.post<RefreshBody>(
        `${getApiBaseUrl()}/auth/refresh`,
        { refreshToken },
        { timeout: 10_000 },
      );
    } catch (err: unknown) {
      // F-6① TOCTOU：B 在 A 落盘前读走旧 RT，A 先完成轮换（旧 RT 已被后端
      // 吊销）→ B 携吊销票刷新必 401。若存储 RT 已不是自己这枚，说明另一 tab
      // 的会话活得好好的——复用它的新 access（不登出不跳转，旧行为会把 B 整
      // 个踢回登录页）；仅当存储 RT 仍是自己这枚（自己这枚是真死了）才把失
      // 败抛给拦截器走登出链。
      if (axios.isAxiosError(err) && err.response?.status === 401 && supersededByAnotherTab()) {
        const adopted = adoptPersistedSession();
        if (adopted) return adopted;
        // 落盘损坏读不出 access 的极端边界：不登出（别人的新票生效中），给
        // 原始请求打上 superseded 标记拒绝——拦截器据此跳过登出链。
        const superseded = new Error('Auth refresh superseded by another tab');
        (superseded as Error & { __superseded?: boolean }).__superseded = true;
        throw superseded;
      }
      throw err;
    }
    // axios wraps the body in resp.data; our interceptor unwraps to resp.data for client calls
    const body: RefreshBody = resp.data ?? {};
    const accessToken = body.data?.accessToken ?? body.accessToken ?? '';
    const newRefresh: string | undefined = body.data?.refreshToken ?? body.refreshToken;
    if (!accessToken) throw new Error('Refresh response missing accessToken');
    // Discard refresh results from a session that has logged out or changed.
    // F-6②：本 tab 已登出（RT 为 null）时维持旧行为——丢弃结果，绝不把
    // 已撤销的 token 写回（DR-04 logout race 语义不变）。但「存储 RT 已被
    // storage 事件换成另一 tab 更新的值」不再走丢弃+登出：那会扔掉一次成功
    // 的刷新并误杀活会话。改为复用另一 tab 的新 access；读不到落盘时保留本
    // 次服务端刚签发的 access（宽限窗口内同样有效），且绝不把自己轮换出的
    // refreshToken 盖到另一 tab 较新的会话上。
    const currentRefresh = useAuthStore.getState().refreshToken;
    if (currentRefresh && currentRefresh !== refreshToken) {
      const adopted = adoptPersistedSession() ?? accessToken;
      return adopted;
    }
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
    // F-1（UIUX 审计 P1-1）：公开认证端点的失败语义本来就是 401 ——
    // /auth/login 的 INVALID_USERNAME_OR_PASSWORD / ACCOUNT_INACTIVE、
    // /auth/totp/verify 的「凭据或 TOTP 验证码错误」（auth.controller Swagger
    // 明示 401）。这些 401 与「会话过期」无关：若照走 refresh→logout→redirect
    // 链，输错密码=整页 reload、用户名/TOTP 第二步全清空，且登录页顶栏谎报
    // 「会话已过期」。对这两类请求不做任何 401 处理，直接 reject——交给
    // LoginPage 的 catch（页内 role=alert 呈现真实原因，输入原样保留）。
    // 判据用 includes 与既有 /auth/refresh 排除同款（url 均为相对路径；
    // /auth/totp/enable|disable 是 JWT 鉴权端点，其 401 仍按会话过期处理）。
    const isPublicAuthRequest = !!originalRequest.url && (
      originalRequest.url.includes('/auth/login') || originalRequest.url.includes('/auth/totp/verify')
    );
    // Avoid infinite retry loop on the refresh endpoint itself
    if (err.response?.status === 401 && !isPublicAuthRequest && !originalRequest._retried && !originalRequest.url?.includes('/auth/refresh')) {
      originalRequest._retried = true;
      try {
        const newToken = await tryRefreshToken();
        originalRequest.headers = originalRequest.headers ?? {};
        originalRequest.headers['Authorization'] = `Bearer ${newToken}`;
        return client(originalRequest);
      } catch (refreshErr: unknown) {
        // F-6：另一 tab 的新票已生效（存储 RT 已换人、只是自己读不到其 access）
        // 时不登出——只在本 tab 会话真死（存储 RT 仍是自己这枚 / 已登出）时才
        // 走登出+重定向链。superseded 场景放弃本次重放，原始 401 交给页面
        // catch 呈现（另一 tab 的会话仍在正常服务）。
        if ((refreshErr as { __superseded?: boolean } | null)?.__superseded === true) {
          // no logout / no redirect
        } else {
          useAuthStore.getState().logout();
          redirectToLogin('expired');
        }
      }
    } else if (err.response?.status === 401 && !isPublicAuthRequest) {
      useAuthStore.getState().logout();
      redirectToLogin('expired');
    }
    // F-32（DEEP_REVIEW 0ef3bbe）：本层是全站**唯一**的重试层（安全方法 1 次、1s 退避）。
    // TanStack Query 侧已显式 retry:false（见 api/queryClient.ts），避免"axios 1 次 ×
    // Query 2 次"叠加成一次失败 6 发请求 + 多条重复 toast。
    // Retry only safe methods: a failed response may still have caused side effects.
    //
    // F-41（UIUX 审计 P1-2）：重试面收窄——只有**暂时性**故障值得自动重试：
    // 网络层失败（无响应）与网关类 5xx（502/503/504）。500 是应用层确定性故障
    // （真机实测：深链坏 id 时详情页 5 个并发 GET 全 500，旧实现 1s 后整组重放
    // ——10 秒窗口 10 发；重试一次同样的 bug 零收益、纯翻倍请求与 toast）。
    // 429 是服务端限流信号，尊重之（本层 1s 固定退避对限流过猛，交由上层决策）。
    // 4xx 一律不重试（不变，确定性失败）。
    if (!originalRequest._retryCount) originalRequest._retryCount = 0;
    const status = err.response?.status;
    const isSafeMethod = ['get', 'head', 'options'].includes((originalRequest.method || 'get').toLowerCase());
    const isTransient = !err.response || status === 502 || status === 503 || status === 504;
    if (isSafeMethod && originalRequest._retryCount < 1 && isTransient) {
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
    // W3：带 skipGlobalToast 的请求（SSE 换票）由调用方自己收敛提示节奏——
    // 这里不弹，但**仍打标**（否则页面 catch 的兜底提示会补一条，等于没跳过）。
    const skipGlobalToast = originalRequest.skipGlobalToast === true;
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
      // LANG-ERR-01（本轮修复的真实缺陷）：**先按 errorCode 取当前语言文案**，
      // 再回落到服务端 message。
      //
      // 为什么顺序不能反：服务端 message 是**单语言**的（在 throw 那一刻就写死，
      // 后端并不知道请求者的语言偏好）。旧实现把它排在 i18n 之前，于是英文界面
      // 的用户在所有 4xx/5xx 上都拿到中文文案；更糟的是这里弹完就打了
      // __toastedByClient 标，页面 catch 里那条**会**按码翻译的 showApiError 被
      // 直接跳过——即"错误码化"在前端使用率最高的这一条路径上被完全绕过。
      // 无码时（老后端 / 非本机制抛出的异常）行为逐位不变。
      const errBody = err.response?.data as
        | { message?: unknown; error?: unknown; errorCode?: unknown; params?: unknown }
        | undefined;
      const msg =
        translateByErrorCode(errBody) ||
        pickBusinessMessage(errBody?.message, errBody?.error) ||
        i18n.t(httpKey, { status });
      // TOAST-DEDUPE：同一次并发扇出会同时到达多条相同失败，只弹第一条。
      // 无论弹没弹都要打标（否则页面 catch 兜底补弹，去重失效）。
      if (!skipGlobalToast && shouldShowToast(msg)) antMessage.error(msg, 4);
      markToastedByClient(rejectValue);
    } else if (!err.response) {
      // Network error
      const netMsg = i18n.t('http.error.network');
      if (!skipGlobalToast && shouldShowToast(netMsg)) antMessage.error(netMsg, 4);
      markToastedByClient(rejectValue);
    }
    // 401 静默跳登录分支未弹 toast，不打标——页面兜底行为与之前逐位一致。
    return Promise.reject(rejectValue);
  },
);
