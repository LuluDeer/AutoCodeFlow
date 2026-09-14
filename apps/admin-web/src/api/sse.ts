/**
 * F-05（DEEP_REVIEW 0ef3bbe）：SSE URL 构建统一入口。
 *
 * ## 当前安全取舍（P2 已知风险，两端注释记录）
 *
 * EventSource API 不支持自定义请求头——浏览器原生 SSE 只能通过 URL 查询串
 * 传递凭据。当前三处 SSE 长连接（/metrics/stream、/executions/stream、
 * /tasks/:taskId/executions/:execId/logs/stream）将 access token 放入
 * `?access_token=` 查询串。
 *
 * 后端已收敛暴露面（jwt.strategy.ts 白名单）：
 * - 仅 3 条 SSE 路由接受 query token（其余路由必须 Authorization 头）；
 * - query token 必须为 type=access（15min TTL，非长效 refresh token）；
 * - 泄露面有界：nginx access log / 浏览器历史 / Referer。
 *
 * ## 中期路线（不在本批实现）
 *
 * 1. 后端为 3 条 /stream 路由签发**短效一次性 ticket**（30s TTL、单次使用），
 *    前端先 POST /api/sse-ticket 换 ticket，再 `new EventSource(url + '?ticket=...')`——
 *    长效 access token 永不入 URL。
 * 2. 长期：用 `fetch()` + `ReadableStream` 自实现 SSE 客户端（可带 Authorization
 *    头），替代 EventSource；顺势与 F-08 的三套 SSE 合并为单一客户端。
 */

/**
 * 构建带 access_token 查询串的 SSE URL。
 * @param baseUrl  API 基地址（不含尾部斜杠）
 * @param path     SSE 路径（如 /metrics/stream）
 * @param token    当前 access token（可选；无 token 时不带 query 参数）
 */
export function buildSseUrl(baseUrl: string, path: string, token?: string | null): string {
  const base = baseUrl.replace(/\/$/, '');
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return token
    ? `${base}${cleanPath}?access_token=${encodeURIComponent(token)}`
    : `${base}${cleanPath}`;
}
