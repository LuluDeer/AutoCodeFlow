/**
 * HTTP client for the AutoCodeFlow Admin API (used by the MCP server).
 * Kept free of MCP/zod imports so it can be unit-tested in isolation.
 */
import fetch from 'node-fetch';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
export const API_URL = process.env.AUTOCODEFLOW_API_URL || 'http://localhost:3105';

/**
 * TOTP-PTY-smoke（2026-10-07）实测抓出的缺陷（与 acf-cli 同源同修）：
 * admin-api 有全局 `api` 前缀，默认 URL（无 /api）对所有请求 404。
 * baseUrl 缺 /api 尾段时请求期补上；已带则逐字节原样（对齐 node-sdk
 * stripTrailingApiSuffix 的双形态归一先例）。
 *
 * P3-10 登记注释（2026-10-26）——与 node-sdk 的归一**方向相反且各自正确**：
 * 本函数是**补** /api——本包的请求路径（apiRequest 的各 path 常量）不带
 * `/api` 前缀，baseURL 必须补上才能命中 admin-api 的全局前缀；node-sdk
 * http-client.ts 的 stripTrailingApiSuffix 是**剥** /api——它的请求路径常量
 * 已自带 `/api`（如 `/api/executions/callback`），baseURL 再带就成了双前缀
 * 404。两侧消费的路径集不同，行为不可互换；改任何一侧前先读对方注释。
 */
export function normalizeApiBase(url: string): string {
  let out = url.trim().replace(/\/+$/, '');
  try {
    const u = new URL(out);
    if (!u.pathname.replace(/\/+$/, '').endsWith('/api')) {
      u.pathname = u.pathname.replace(/\/+$/, '') + '/api';
    }
    out = u.toString().replace(/\/+$/, '');
  } catch {
    if (!out.endsWith('/api')) out += '/api';
  }
  return out;
}
export const API_TOKEN = process.env.AUTOCODEFLOW_API_TOKEN || '';

/**
 * BUG-14 (SEC-01 复审): 可选的 refresh token 自愈。
 *
 * MCP server 是长驻进程，access token 默认 15m 过期——此前过期后所有工具
 * 永久 401，只能重启进程换新 token。设置 AUTOCODEFLOW_API_REFRESH_TOKEN 后：
 * 401（/auth/* 自身除外）触发单飞 POST /auth/refresh，成功则换发并重放原
 * 请求一次；admin-api 的 refresh 是原子轮换（DR-07），响应携带的新
 * refreshToken 保存在内存中供下一次过期使用（进程生命周期内持续自愈；
 * 不落盘——MCP 无凭据存储职责，进程重启重新注入 env）。
 * env 在每次 401 时懒读取，便于测试注入。
 *
 * P2-3 端间 parity 登记注释（2026-10-26）：本包**无重试、无熔断**——自愈面
 * 仅请求超时（下方 REQUEST_TIMEOUT_MS）+ 401 refresh（BUG-14）。完整的
 * 重试 + 熔断契约只存在于管理面客户端 `packages/autocodeflow-http`（与
 * node-sdk 两端对齐，见其模块 docstring 的 parity 地图）；acf-cli /
 * autoflow-sdk 同样无（见各自 client 注释）。
 */

/** 请求超时预算（N12）：admin-api 卡死时 MCP 工具不得无限挂起。
 * 导出以便测试注入更短的超时（apiRequest 的 timeoutMs 参数）。 */
export const REQUEST_TIMEOUT_MS = 30_000;

let currentToken = API_TOKEN;
let currentRefreshToken = process.env.AUTOCODEFLOW_API_REFRESH_TOKEN || '';
let refreshInFlight: Promise<boolean> | null = null;

/**
 * 刷新 access token。
 *
 * **NETOPT-7（审计 P1-4，2026-10-17）**：此前这里直接用裸 `API_URL` 拼接，
 * 而 admin-api 有全局 `api` 前缀——默认配置（`http://localhost:3105`）下
 * 请求打到 `/auth/refresh` → **404** → `res.ok` 为 false → 返回 false。
 * 与 acf-cli 同源的缺陷：令牌一旦过期，自愈永久失效，MCP 的所有工具调用
 * 都停在 401，只能重启进程换环境变量。
 *
 * 修复：与 `apiRequest` 使用**同一个** `normalizeApiBase(API_URL)` 归一
 * 入口，两条路径的 base 不可能再漂移。
 */
async function refreshAccessToken(): Promise<boolean> {
  const envRefresh = process.env.AUTOCODEFLOW_API_REFRESH_TOKEN || '';
  const refreshToken = currentRefreshToken || envRefresh;
  if (!refreshToken) return false;
  try {
    const res = await fetch(`${normalizeApiBase(API_URL)}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    const data = unwrap<{ accessToken?: string; refreshToken?: string }>(
      await res.json(),
    );
    if (typeof data?.accessToken === 'string' && data.accessToken.length > 0) {
      currentToken = data.accessToken;
      // 原子轮换：新 refreshToken 必须跟进，否则下一次过期刷新必 401
      if (
        typeof data.refreshToken === 'string' &&
        data.refreshToken.length > 0
      ) {
        currentRefreshToken = data.refreshToken;
      }
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Perform an HTTP request against the admin API and strip the global
 * `{ code, message, data }` response envelope.
 */
export async function apiRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
  _retried = false,
): Promise<T> {
  const signal = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetch(`${normalizeApiBase(API_URL)}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${currentToken}`,
      },
      signal,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    // AbortSignal.timeout 触发时 node-fetch 抛 AbortError；以 signal 状态判定，
    // 不依赖错误名在不同实现下的差异。
    if (signal.aborted) {
      const budget = timeoutMs >= 1000 ? `${timeoutMs / 1000}s` : `${timeoutMs}ms`;
      throw new Error(`API request timed out after ${budget}: ${method} ${path}`);
    }
    throw err;
  }
  if (!res.ok) {
    // BUG-13 同款自愈（/_retried 钉死单次重放；/auth/* 自身不触发）
    if (
      res.status === 401 &&
      !_retried &&
      !path.includes('/auth/') &&
      (currentRefreshToken || process.env.AUTOCODEFLOW_API_REFRESH_TOKEN)
    ) {
      refreshInFlight ??= refreshAccessToken().finally(() => {
        refreshInFlight = null;
      });
      const healed = await refreshInFlight;
      if (healed) {
        return apiRequest<T>(method, path, body, timeoutMs, true);
      }
    }
    const text = await res.text();
    throw buildHttpError(method, path, res.status, text);
  }
  // admin-api applies a global ResponseInterceptor that wraps every
  // successful response in `{ code, message, data }`. Strip the envelope so
  // tool consumers can keep returning the actual payload as-is.
  const raw = (await res.json()) as unknown;
  return unwrap<T>(raw);
}

/** 把错误响应体解析成普通对象；非 JSON / 非对象 → undefined（永不抛）。 */
function parseErrorBody(text: string): Record<string, unknown> | undefined {
  try {
    const d = JSON.parse(text) as unknown;
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      return d as Record<string, unknown>;
    }
  } catch {
    /* not JSON — 由调用方回落到原始文本 */
  }
  return undefined;
}

/**
 * Extract the human-readable message from an error body — admin-api errors
 * arrive as `{ code, message, data }` envelopes or NestJS
 * `{ statusCode, message, error }` objects, and class-validator sends
 * `message` as a string[]. Mirrors the CLI's formatApiError copy (N12)
 * except 404, which carries an MCP-specific next-step hint (agents resolve
 * ids via list_* tools; the CLI prints human-facing hints instead).
 */
function detailFromBody(d: Record<string, unknown> | undefined): string {
  if (!d) return '';
  const m = d.message;
  if (typeof m === 'string' && m) return m;
  if (Array.isArray(m) && m.length) return m.map(String).join('; ');
  if (typeof d.error === 'string' && d.error) return d.error;
  return '';
}

/**
 * R31-E2: 管理员侧稳定码面（缺什么就没有对应键，绝不写 `undefined`）。
 *
 * 与 node SDK 的 `HttpClientError`（packages/autocodeflow-node-sdk）和 python
 * 侧的 `error_code` / `params` 同语义：消费方可以按码分支、按 params 本地化，
 * 不必解析中文 message。
 */
export interface ApiErrorCodeFields {
  /** 服务端稳定错误码（如 `TASK_NOT_FOUND`）；无码时该键不存在。 */
  readonly errorCode?: string;
  /** 错误码的插值参数；无参 / 非普通对象时该键不存在。 */
  readonly params?: Record<string, unknown>;
}

/** 从已解析的错误体里抽稳定码面；只做「有值才给」。 */
export function extractErrorCodeFields(
  d: Record<string, unknown> | undefined,
): ApiErrorCodeFields {
  if (!d) return {};
  const out: { errorCode?: string; params?: Record<string, unknown> } = {};
  const { errorCode, params } = d;
  if (typeof errorCode === 'string' && errorCode.length > 0) {
    out.errorCode = errorCode;
  }
  if (params !== null && typeof params === 'object' && !Array.isArray(params)) {
    out.params = params as Record<string, unknown>;
  }
  return out;
}

/** 只读定义（可枚举，便于日志 / JSON.stringify 落到 meta 里）。 */
function defineErrorField(
  target: object,
  key: 'errorCode' | 'params',
  value: unknown,
): void {
  try {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: false,
    });
  } catch {
    // 冻结 / 不可扩展的异常对象：宁可不带码，也绝不吞掉原始错误。
  }
}

/** 把稳定码面挂到错误对象上，返回同一个引用（message 逐字节不变）。 */
function attachErrorCodeFields(error: Error, fields: ApiErrorCodeFields): Error {
  if (fields.errorCode !== undefined) {
    defineErrorField(error, 'errorCode', fields.errorCode);
  }
  if (fields.params !== undefined) {
    defineErrorField(error, 'params', fields.params);
  }
  return error;
}

function buildHttpError(method: string, path: string, status: number, text: string): Error {
  // R31-E2: 错误体只解析一次，人读文案（detail）与机读面（errorCode/params）
  // 都从同一份对象取——两个字段此前在这里被丢弃，agent 只能看到中文 message。
  const body = parseErrorBody(text);
  const detail = detailFromBody(body);
  const fields = extractErrorCodeFields(body);
  if (!detail) {
    // 解析不出 message 时保持旧行为：透传原始文本，不吞信息。
    return attachErrorCodeFields(
      new Error(`API ${method} ${path} → ${status}: ${text}`),
      fields,
    );
  }
  let message: string;
  switch (status) {
    case 401:
      message = `Unauthorized (401): ${detail} — token missing, expired or invalid; refresh AUTOCODEFLOW_API_TOKEN (e.g. run "acf login")`;
      break;
    case 403:
      message = `Forbidden (403): ${detail} — your account is not allowed to perform this operation (some endpoints require the ADMIN role)`;
      break;
    case 404:
      // 404 也给下一步动作（对齐 401/403 的可恢复性口径）：id 已是 UUID 白名单
      // 校验过的，404 基本意味着「id 对但资源不存在/被删」或「拿错了 id 类型」
      // ——指引 agent 用对应 list 工具重新解析 id。
      message = `API error (404): ${detail} — confirm the resource exists; resolve the ID with the matching list_* tool and retry`;
      break;
    default:
      message = `API error (${status}): ${detail}`;
  }
  return attachErrorCodeFields(new Error(message), fields);
}

/**
 * Strip the `{ code, message, data }` envelope added by the admin-api
 * ResponseInterceptor.
 *
 * 判据（WIKI-OPT-4 收紧）：raw 是对象 且 含 `data` 键 且 `code` 为数值。
 * 理由：ResponseInterceptor 的信封 `code` 恒为数值（`response.statusCode ??
 * 200`）、`message` 恒为字符串 "success"，因此「数值 code」即可精确识别信封，
 * `message` 的存在不再作为判据——旧的 data+(code|message) 宽松启发式会把
 * 自带 data+message 字段（无 code）的业务实体误解包，整个实体被截断成它的
 * data 值；收紧后这类实体原样透传。
 */
export function unwrap<T>(raw: unknown): T {
  if (raw && typeof raw === 'object' && 'data' in (raw as Record<string, unknown>)) {
    const envelope = raw as { code?: unknown; data?: unknown };
    if (typeof envelope.code === 'number') {
      return (envelope.data ?? (null as unknown)) as T;
    }
  }
  return raw as T;
}

/** Convenience helpers keeping call sites compact and testable. */
export function apiGet<T>(path: string): Promise<T> {
  return apiRequest<T>('GET', path);
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return apiRequest<T>('POST', path, body);
}

export function apiPut<T>(path: string, body?: unknown): Promise<T> {
  return apiRequest<T>('PUT', path, body);
}

export function apiDelete<T>(path: string): Promise<T> {
  return apiRequest<T>('DELETE', path);
}
