/**
 * Thin HTTP client wrapper for the AutoCodeFlow Admin API.
 */
import axios, { AxiosInstance, AxiosError, AxiosRequestConfig } from "axios";
import {
  getApiUrl,
  getToken,
  getRefreshToken,
  setToken,
  setRefreshToken,
  clearAuth,
} from "./config";

let _client: AxiosInstance | null = null;

/** base URL without trailing slashes（/auth/refresh 直连拼接用） */
function baseUrl(): string {
  return getApiUrl().replace(/\/+$/, "");
}

/** Reset client (needed after config changes in same process). */
export function resetClient(): void {
  _client = null;
}

// The admin-api applies a global ResponseInterceptor that wraps every
// successful response in `{ code, message, data }`. Mirror admin-web's
// client and strip that envelope so callers can keep using `data.list`,
// `data.total`, etc. without unwrapping manually.
export function unwrap<T>(raw: unknown): T {
  if (
    raw &&
    typeof raw === "object" &&
    "data" in (raw as Record<string, unknown>)
  ) {
    const envelope = raw as { code?: unknown; data?: unknown };
    if ("code" in envelope || "message" in envelope) {
      return (envelope.data ?? (null as unknown)) as T;
    }
  }
  return raw as T;
}

// ---------------------------------------------------------------------------
// BUG-13 (SEC-01 CLI 复审): 401 单飞自愈
// ---------------------------------------------------------------------------
// login 现在同时保存 refreshToken，但 access token 默认 15 分钟过期——此前
// CLI 一过期就全命令 401，只能重新 acf login。此处的自愈语义：
// - 401 且本地存有 refresh token → 单飞（并发 401 共享同一次刷新）调
//   POST /auth/refresh，成功则换发双 token 并重放原请求一次；
// - 刷新失败 → clearAuth()（本地凭据已不可信），错误照常抛给
//   formatApiError 提示重新登录；
// - /auth/* 路径自身的 401 不触发刷新（登录失败不是 token 过期）；
// - 非幂等请求重放与 DR-06 的区分：重放只发生在「401=请求从未到达业务层
//   被拒」的认证态，不是业务副作用重试，单次重放安全。
let refreshInFlight: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return null;
  try {
    const r = await axios.post(
      `${baseUrl()}/auth/refresh`,
      { refreshToken },
      { timeout: 10_000 },
    );
    const data = unwrap<{ accessToken?: string; refreshToken?: string }>(
      r.data,
    );
    if (typeof data?.accessToken === "string" && data.accessToken.length > 0) {
      setToken(data.accessToken);
      // DR-07 修复后的 refresh 是原子轮换：响应携带新 refreshToken 必须跟进
      if (
        typeof data.refreshToken === "string" &&
        data.refreshToken.length > 0
      ) {
        setRefreshToken(data.refreshToken);
      }
      return data.accessToken;
    }
    return null;
  } catch {
    return null;
  }
}

function isAuthPath(url?: string): boolean {
  return !!url && url.includes("/auth/");
}

function getClient(): AxiosInstance {
  if (!_client) {
    _client = axios.create({
      baseURL: getApiUrl(),
      timeout: 30_000,
    });
    // Token 逐请求读取（不再在实例创建时烘焙）：同进程内 login / 刷新轮换
    // 后无需 resetClient 也能带上最新凭据（resetClient 保留仅为兼容）。
    _client.interceptors.request.use((cfg) => {
      const token = getToken();
      if (token) {
        cfg.headers = Object.assign({}, cfg.headers, {
          Authorization: `Bearer ${token}`,
        });
      }
      return cfg;
    });
    _client.interceptors.response.use(undefined, async (err: AxiosError) => {
      const status = err.response?.status;
      const cfg = err.config as
        (AxiosRequestConfig & { _acfAuthRetried?: boolean }) | undefined;
      if (
        status !== 401 ||
        !cfg ||
        cfg._acfAuthRetried ||
        isAuthPath(cfg.url)
      ) {
        throw err;
      }
      cfg._acfAuthRetried = true;
      refreshInFlight ??= refreshAccessToken().finally(() => {
        refreshInFlight = null;
      });
      const token = await refreshInFlight;
      if (token) {
        // 重放走 getClient()：request 拦截器会用刚换发的新 token 重写
        // Authorization 头，无需手工改 cfg.headers。
        return getClient().request(cfg);
      }
      clearAuth();
      throw err;
    });
  }
  return _client;
}

export async function get<T>(
  path: string,
  params?: Record<string, string | number | undefined>,
): Promise<T> {
  const r = await getClient().get<unknown>(path, { params });
  return unwrap<T>(r.data);
}

export async function post<T>(path: string, body?: unknown): Promise<T> {
  const r = await getClient().post<unknown>(path, body);
  return unwrap<T>(r.data);
}

export async function put<T>(path: string, body?: unknown): Promise<T> {
  const r = await getClient().put<unknown>(path, body);
  return unwrap<T>(r.data);
}

export async function patch<T>(path: string, body?: unknown): Promise<T> {
  const r = await getClient().patch<unknown>(path, body);
  return unwrap<T>(r.data);
}

export async function del<T>(path: string): Promise<T> {
  const r = await getClient().delete<unknown>(path);
  return unwrap<T>(r.data);
}

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------
// The API returns errors as `{ statusCode, message, error }` (NestJS) or the
// `{ code, message, data }` envelope. class-validator may send `message` as a
// string[]. Axios itself only surfaces "Request failed with status code 400",
// so without this helper the actual cause never reaches the terminal.

function detailFromData(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const d = data as Record<string, unknown>;
  const m = d.message;
  // QA-07 契约：空串 message 视为「未提供」，继续走 message[]/error 兜底
  //（与 mcp-server extractDetail 对齐；此前空串 message 会遮蔽 error 字段）。
  if (typeof m === "string" && m) return m;
  if (Array.isArray(m) && m.length) return m.map(String).join("; ");
  if (typeof d.error === "string" && d.error) return d.error;
  return "";
}

/**
 * Render any thrown error as a single readable line, distinguishing
 * 401 (not authenticated) from 403 (authenticated but not allowed) and
 * surfacing the backend message instead of axios' generic text.
 */
export function formatApiError(e: unknown): string {
  if (axios.isAxiosError(e)) {
    const err = e as AxiosError;
    const status = err.response?.status;
    const detail = detailFromData(err.response?.data);
    switch (status) {
      case 400:
        return `Bad request (400): ${detail || "invalid parameters — the API rejects fields not declared in its DTO whitelist"}`;
      case 401:
        return `Unauthorized (401): ${detail || "token missing, expired or invalid"} — run "acf login" or pass --token / set ACF_TOKEN`;
      case 403:
        return `Forbidden (403): ${detail || "your account is not allowed to perform this operation (some endpoints require the ADMIN role)"}`;
      case 404:
        return `Not found (404): ${detail || "resource does not exist"}`;
      case 409:
        return `Conflict (409): ${detail || "resource already exists"}`;
      default:
        if (status) {
          return `API error (${status}): ${detail || err.message}`;
        }
        return `Network error: ${err.message} (is the API reachable at ${getApiUrl()}?)`;
    }
  }
  return e instanceof Error ? e.message : String(e);
}
