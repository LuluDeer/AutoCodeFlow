// TOAST-01：错误 toast 与全站同走 utils/toast 出口（App 实例优先，暗色主题
// 下样式正确）；仅此一处 import，供 showApiError 使用。
import { message } from './toast';
// N-04：兜底文案走 i18n（defaultMsg 是 toast 直出用户面，不能内联中文）。
import i18n from '../i18n';

/**
 * Extract a human-readable message from an unknown catch value.
 * Handles Axios-style errors (err.response.data.message), plain Error,
 * and falls back to the provided defaultMsg.
 *
 * LANG-ERR-01（后端错误码化）：**优先按 `errorCode` 取本地化文案**。
 *
 * 为什么必须存在这条路径：后端的 `message` 是**单语言**的（源码在抛出时刻就
 * 写死了），无论用户把界面切成什么语言，透传它都只会得到那一种语言——这正是
 * 「界面英文、报错中文」的成因。
 *
 * 三级降级（顺序不可颠倒）：
 *   ① `errorCode` + 前端字典里有 `err.<CODE>` → 按**当前界面语言**渲染，并用
 *      `params` 插值。这是唯一能跟随用户语言的路径。
 *   ② 码存在但字典没有（后端先上线了新码，前端还没跟上）→ 回落服务端 `message`
 *      （中文兜底）。**绝不把裸码渲染给用户**（那是"界面看起来坏了"的形态，
 *      同 i18n-source-guard 挡的裸 key 问题）。
 *   ③ 无码（老后端 / 非本机制抛出的异常）→ 维持原行为，透传 `message`。
 */
export function getErrMsg(err: unknown, defaultMsg = i18n.t('common.operateFailed')): string {
  if (err instanceof Error) {
    // Axios wraps the response on the Error object
    const axiosData = (err as unknown as {
      response?: { data?: { message?: string; errorCode?: string; params?: Record<string, unknown> } };
    })?.response?.data;
    const localized = translateByErrorCode(axiosData);
    if (localized) return localized;
    if (axiosData?.message) return axiosData.message;
    return err.message || defaultMsg;
  }
  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    const localized = translateByErrorCode(obj);
    if (localized) return localized;
    if (typeof obj['message'] === 'string') return obj['message'];
  }
  return defaultMsg;
}

/**
 * 按 `errorCode` 取当前语言的文案；取不到返回 `null`（由调用方回落服务端
 * `message`）。抽成独立函数是为了让「码 → 本地化」这条链路可被单测直接钉住，
 * 不必构造整个 axios 错误对象。
 */
export function translateByErrorCode(data: {
  errorCode?: unknown;
  params?: unknown;
} | null | undefined): string | null {
  const code = data?.errorCode;
  if (typeof code !== 'string' || !code) return null;
  const key = `err.${code}`;
  // 用 `i18n.exists` 而非 try/catch：i18next 在缺失 key 时**不抛错**，它会把 key
  // 原样返回——直接 `t(key)` 会把 `err.EXECUTOR_NOT_FOUND` 这种标识符渲染给
  // 用户，既不报错也不影响构建（正是 i18n-source-guard 记录过的那类生产故障）。
  if (!i18n.exists(key)) return null;
  const params = (data?.params ?? {}) as Record<string, unknown>;
  return i18n.t(key, params);
}

/**
 * DUP-TOAST（本轮审计）：api/client.ts 的响应拦截器已对常见 HTTP 错误（403/
 * 404/409/429/5xx/网络错误）统一弹过一次 toast，并在 reject 值上打了
 * `__toastedByClient` 标（reject 形态是 `err.response?.data || err`——标打在
 * 页面 catch 实际收到的那个对象上）。页面 catch 的兜底提示统一走本函数：
 * 已打标的直接 return（同一失败只弹拦截器那一条），未打标（本地异常、
 * 非 client 发起的请求失败）才弹 getErrMsg 归一后的消息。
 *
 * fallback 语义与 getErrMsg 的 defaultMsg 一致：不传时回退「操作失败」。
 */
export function showApiError(err: unknown, fallback?: string): void {
  if (
    err !== null &&
    typeof err === 'object' &&
    (err as Record<string, unknown>)['__toastedByClient'] === true
  ) {
    return;
  }
  message.error(getErrMsg(err, fallback));
}

/** Returns true when the caught value is an Ant Design form validation error (has errorFields). */
export function isFormValidationError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'errorFields' in (err as object) &&
    Array.isArray((err as Record<string, unknown>)['errorFields'])
  );
}

/**
 * UX-05（本轮体验审查）：判断错误是否为「资源不存在」（HTTP 404）。
 *
 * 用于区分两种失败归宿：404 说明该 id 确实不存在，跳回列表是合理行为；
 * 其余错误（500 / 网络抖动 / 超时）只是**这次没读到**，应留在原位给重试——
 * 把用户正在看的页面直接跳走、只留一条几秒后消失的 toast，是很差的体验。
 *
 * 注意：axios 拦截器在 401 且刷新失败时会 logout + 跳登录，那条链路不经过
 * 这里；此处只处理「已经拿到响应且状态码是 404」的情形。
 *
 * P1-3（生产审查）：api/client.ts 的响应拦截器 reject 的是
 * `err.response?.data`（原始 error 的 .response 已剥掉），并在该值上挂了数字型
 * `__status`（见 client.ts 同名注释）——此前只读 `err.response?.status` 对
 * 拦截器的 reject 值恒为 false，页面「404 → 跳回列表」从未生效。现优先读
 * `__status`；对直接传 axios 原始 error（带 response.status）的调用方保留
 * 旧路径回退。
 */
export function isNotFoundError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const status = (err as { __status?: unknown }).__status;
  if (status !== undefined) return status === 404;
  return (err as { response?: { status?: unknown } })?.response?.status === 404;
}
