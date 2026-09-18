/**
 * Extract a human-readable message from an unknown catch value.
 * Handles Axios-style errors (err.response.data.message), plain Error,
 * and falls back to the provided defaultMsg.
 */
export function getErrMsg(err: unknown, defaultMsg = '操作失败'): string {
  if (err instanceof Error) {
    // Axios wraps the response on the Error object
    const axiosMsg = (err as unknown as { response?: { data?: { message?: string } } })
      ?.response?.data?.message;
    if (axiosMsg) return axiosMsg;
    return err.message || defaultMsg;
  }
  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    if (typeof obj['message'] === 'string') return obj['message'];
  }
  return defaultMsg;
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
 */
export function isNotFoundError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const status = (err as { response?: { status?: unknown } })?.response?.status;
  return status === 404;
}
