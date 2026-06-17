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
