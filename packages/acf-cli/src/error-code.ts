/**
 * R31-E1: admin-api **稳定错误码**的消费侧（CLI）。
 *
 * 背景：admin-api 已全量错误码化，HTTP 错误响应体形如
 *   { code: <数字 HTTP 状态>, message: <中文兜底>, errorCode: '<稳定码>', params: {...} }
 * 浏览器端按码做 i18n；CLI 此前只透传 `message`——用户看到的是中文兜底文案，
 * 脚本也拿不到稳定码（只能匹配文案，文案一改就断）。
 *
 * 本模块只做三件事，且**不依赖 axios 实例**（纯函数，便于单测与复用）：
 *   1. `extractApiErrorInfo` —— 从任意抛出的值里抽出 { status, errorCode,
 *      params, message }（axios 形状 / SDK 形状 / 普通对象都吃）；
 *   2. `classifyErrorCode` —— 把稳定码归到 **6 类**之一（不枚举几百个码，
 *      用命名约定的前缀/后缀模式；顺序即优先级）；
 *   3. `appendErrorCodeHint` —— 在既有的人读文案后追加「[码] — 一句话处置」。
 *
 * ⚠️ 未知码与无码必须**逐字节保持现状**：这两个分支不追加任何文本
 * （`appendErrorCodeHint` 直接返回入参），因为历史输出被大量测试与用户
 * 习惯钉住，且「猜一个类别」比「不说」更容易误导。
 */

/** 6 个处置类别（认证 / 权限 / 不存在 / 冲突 / 容量或限流 / 校验失败）。 */
export type ApiErrorCategory =
  | 'auth'
  | 'permission'
  | 'not_found'
  | 'conflict'
  | 'capacity'
  | 'validation';

/**
 * 每类的**一句话**处置建议。刻意按类给而不是按码给：三百多个码逐条写建议
 * 必然腐化，而「你是谁不对 / 你没权限 / 东西没了 / 状态冲突 / 服务撑不住 /
 * 入参不合法」这六类的下一步动作是稳定的。
 */
export const CATEGORY_HINTS: Readonly<Record<ApiErrorCategory, string>> = {
  auth: 'run "acf login" (or pass --token / set ACF_TOKEN) to refresh your credentials.',
  permission:
    'your account or role is not allowed to do this — ask an admin for the required role/ownership (some endpoints require ADMIN).',
  not_found:
    'the resource does not exist (or was deleted) — re-check the ID with the matching "acf ... list" command.',
  conflict:
    'the resource already exists or is in a conflicting state — re-read it with "acf ... get" before retrying.',
  capacity:
    'the service is at capacity or throttling — retry later with backoff (for executors: free a slot or raise maxConcurrentTasks).',
  validation:
    'the input was rejected by validation — fix the field(s) named in the message; retrying unchanged fails the same way.',
};

/**
 * 码 → 类别的判定表。**顺序即优先级**：先命中先归类。
 *
 * 优先级刻意如此：
 * - `capacity` 最先：`API_KEY_QUOTA_REACHED`（429）、`NO_AVAILABLE_EXECUTOR`
 *   （409）、`EXECUTOR_OFFLINE`（409）这些状态码本身不表达"容量"，而
 *   "稍后重试/腾容量"才是正确的下一步；
 * - `permission` 早于 `auth`：`API_KEY_SCOPE_DENIED`（403）以 `API_KEY_`
 *   开头，若 auth 先命中就会误给"去 acf login"这种无效建议；
 * - `auth` 早于 `validation`：`INVALID_CREDENTIALS` 含 `INVALID`，但正确
 *   的动作是重新登录，不是"改入参"；
 * - `conflict` 早于 `validation`：`TASK_ALREADY_PAUSED` / `TASK_UPDATE_STALE`
 *   是状态冲突（重新读一次再决定），不是入参写错。
 */
const CATEGORY_RULES: ReadonlyArray<readonly [ApiErrorCategory, RegExp]> = [
  [
    'capacity',
    /(QUOTA|RATE_?LIMIT|TOO_MANY|CAPACITY|THROTTL|TIMEOUT|_STREAM_LIMIT|LIMIT_GLOBAL|LIMIT_PER_EXECUTION|NO_[A-Z_]*EXECUTOR|_OFFLINE)/,
  ],
  [
    'permission',
    /(FORBIDDEN|_DENIED|NOT_AUTHORIZED|_NOT_OWNER|NO_OWNER|NOT_MEMBER|NOT_VISIBLE|_SELF_ONLY|ADMIN_ONLY|_READONLY|PERMISSION|ROLE_)/,
  ],
  [
    'auth',
    /(UNAUTHORIZED|INVALID_CREDENTIALS|CREDENTIAL|LOGIN_|SESSION_|TOKEN|API_KEY_|ACCOUNT_|OIDC_|TOTP|AUTH_FAILED|USERNAME_OR_PASSWORD)/,
  ],
  ['not_found', /(_NOT_FOUND)/],
  [
    'conflict',
    // `(?<!MAX_)CONCURRENT`：`EXECUTOR_MAX_CONCURRENT_INVALID` 说的是"参数非法"
    // （validation），而 `TASK_TRIGGER_CONCURRENT` / `_CONCURRENT_MODIFICATION`
    // 才是并发冲突。少了这个环视，前者会被误判成冲突、给出"重新读一次"的
    // 无效建议（实测红过一条）。
    /(EXISTS|_TAKEN|ALREADY_|CONFLICT|STILL_|IN_FLIGHT|(?<!MAX_)CONCURRENT|STALE|IMMUTABLE|_TERMINAL|_PAUSED|LAST_ADMIN|SELF_DELETE|AWAITING_|_NOT_PENDING)/,
  ],
  [
    'validation',
    /(INVALID|VALIDATION|_REQUIRED|_MISSING|_EMPTY|_UNCHANGED|UNSUPPORTED|OUT_OF_RANGE|_TOO_|_MALFORMED|_EXCLUSIVE|_MISMATCH|_INCORRECT|_NOT_OBJECT|_NOT_ZIP|_NOT_ARCHIVE|_BLOCKED|SSRF|PASSWORD|NOT_SEMVER|DEPENDENCY)/,
  ],
];

/**
 * 稳定码 → 类别；未知码 / 非字符串 / 空串 → `null`（调用方据此保持现状）。
 *
 * 只做命名约定匹配，**不维护码表清单**：新增码只要沿用约定就自动归类，
 * 不沿用则安全地落到「未知」分支（不猜、不误导）。
 */
export function classifyErrorCode(errorCode: unknown): ApiErrorCategory | null {
  if (typeof errorCode !== 'string' || errorCode.length === 0) return null;
  const code = errorCode.toUpperCase();
  for (const [category, pattern] of CATEGORY_RULES) {
    if (pattern.test(code)) return category;
  }
  return null;
}

/** 稳定码 → 一句话处置建议；未知码 / 无码 → `null`。 */
export function hintForErrorCode(errorCode: unknown): string | null {
  const category = classifyErrorCode(errorCode);
  return category === null ? null : CATEGORY_HINTS[category];
}

/** 从错误响应体里抽人读文案（`message` / class-validator 的 `message[]` / `error`）。 */
export function messageFromData(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const d = data as Record<string, unknown>;
  const m = d.message;
  // QA-07 契约：空串 message 视为「未提供」，继续走 message[]/error 兜底
  //（与 mcp-server extractDetail 对齐；此前空串 message 会遮蔽 error 字段）。
  if (typeof m === 'string' && m) return m;
  if (Array.isArray(m) && m.length) return m.map(String).join('; ');
  if (typeof d.error === 'string' && d.error) return d.error;
  return '';
}

/** 错误的可机读面（缺什么就没有对应键，不写 undefined）。 */
export interface ApiErrorInfo {
  /** HTTP 状态（优先 `response.status`，回落响应体里的数值 `code`）。 */
  status?: number;
  /** 管理员侧稳定码（如 `TASK_NOT_FOUND`）。 */
  errorCode?: string;
  /** 码的插值参数。 */
  params?: Record<string, unknown>;
  /** 服务端人读文案（已含 message[] / error 兜底）。 */
  message?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 从任意抛出的值里抽出可机读的错误面。
 *
 * 三种来源都要吃（CLI 一条链路上都会出现）：
 * - axios 错误：`err.response.data` 是 admin-api 的错误体；
 * - node SDK 标记过的错误：`errorCode` / `params` 直接挂在 Error 上
 *   （packages/autocodeflow-node-sdk 的 attachErrorCode），没有 response；
 * - 直接抛的普通对象（本地派生错误 / 测试桩）。
 */
export function extractApiErrorInfo(e: unknown): ApiErrorInfo {
  if (e === null || typeof e !== 'object') return {};
  const err = e as {
    response?: { status?: unknown; data?: unknown };
    errorCode?: unknown;
    params?: unknown;
    message?: unknown;
  };
  const data = err.response?.data;
  const body = isPlainObject(data) ? data : undefined;
  const info: ApiErrorInfo = {};

  const responseStatus = err.response?.status;
  if (typeof responseStatus === 'number') {
    info.status = responseStatus;
  } else if (body && typeof body.code === 'number') {
    // 响应体里的数值 code 就是 HTTP 状态（admin-api 的过滤器如此写）
    info.status = body.code;
  }

  // 稳定码：先看响应体（管理员侧真值源），再看错误对象自身（SDK 透传 / 直接抛出）
  const bodyCode = body?.errorCode;
  const ownCode = err.errorCode;
  const errorCode =
    typeof bodyCode === 'string' && bodyCode
      ? bodyCode
      : typeof ownCode === 'string' && ownCode
        ? ownCode
        : undefined;
  if (errorCode !== undefined) info.errorCode = errorCode;

  // 插值参数：同上优先级（响应体优先），非普通对象一律丢弃
  const params = isPlainObject(body?.params)
    ? body?.params
    : isPlainObject(err.params)
      ? err.params
      : undefined;
  if (params !== undefined) info.params = params;

  const message = messageFromData(body);
  if (message) {
    info.message = message;
  } else if (typeof err.message === 'string' && err.message) {
    info.message = err.message;
  }
  return info;
}

/**
 * 在既有的人读文案后追加「[码] — 一句话处置」；**未知码 / 无码原样返回**。
 *
 * 之所以把码本身也打出来：用户报障时贴一行就够定位（不必再开 --json），
 * 而这个码正是 README/文档里能搜到的稳定标识。
 */
export function appendErrorCodeHint(base: string, e: unknown): string {
  const { errorCode } = extractApiErrorInfo(e);
  const hint = hintForErrorCode(errorCode);
  if (errorCode === undefined || hint === null) return base;
  return `${base} [${errorCode}] — ${hint}`;
}
