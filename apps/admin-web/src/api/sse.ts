/**
 * F-05 + A5（DEEP_REVIEW 0ef3bbe §七 A5）：SSE 凭据与 URL 构建统一入口。
 *
 * ## 历史与现状
 *
 * EventSource API 不支持自定义请求头——浏览器原生 SSE 只能通过 URL 查询串
 * 传递凭据。**此前**三处 SSE 长连接（/metrics/stream、/executions/stream、
 * /tasks/:taskId/executions/:execId/logs/stream）直接把 **access token
 * （15min TTL）** 放进 `?access_token=`；查询串会被 nginx access log、
 * 浏览器历史、Referer 记录，等于把一枚 15 分钟有效的全权令牌写进日志
 * （P2 已知风险，两端注释均有记录）。
 *
 * **现在（A5）**：建流前先经 `POST /auth/sse-ticket`（常规 Authorization 头）
 * 换一枚 **30s TTL、type=sse_ticket** 的专用票据，再 `?ticket=` 建流：
 *  - 泄漏面从「15 分钟全权访问令牌」降为「30 秒、且只能在三条 SSE 路径上使用
 *    的专用票据」（后端 `extractJwtFromRequest` 的路径门 + `validate` 的类型门）；
 *  - 后端已**撤销 `?access_token=` 通道**，旧泄漏面从结构上关闭；
 *  - 票据不落库、不参与刷新，是 access token 的派生物——每次建流（含自动
 *    重连）都重新换一枚。
 *
 * ## 仍未做（如实登记）
 *
 * 1. **单次使用**需要在建流路径引入 Redis 共享状态，等于把 SSE 可用性与 Redis
 *    绑定；而票据已是 30s + 路径受限，日志泄漏（事后读取）本就拿不到有效凭据。
 * 2. 长期：用 `fetch()` + `ReadableStream` 自实现 SSE 客户端（可带 Authorization
 *    头），彻底消除「凭据入 URL」。F-08 已把三套实现合并为 `createSseClient`，
 *    届时只需替换本文件与 sse-client 的建连方式。
 */

import { client } from './client';

/** 换票端点（相对 axios baseURL）。 */
export const SSE_TICKET_PATH = '/auth/sse-ticket';

interface SseTicketResponse {
  ticket: string;
  expiresAt: string;
}

/**
 * 向后端换取一枚 SSE 专用短效票据。
 *
 * 走共享 axios client ⇒ 自动携带 Authorization 头、自动 401 刷新重试、
 * 自动拆响应信封（{ code, message, data } → data）。
 */
export async function fetchSseTicket(): Promise<string> {
  const data = await client.post<SseTicketResponse>(SSE_TICKET_PATH);
  return data.ticket;
}

/**
 * 构建带 ticket 查询串的 SSE URL。
 * @param baseUrl  API 基地址（不含尾部斜杠）
 * @param path     SSE 路径（如 /metrics/stream）
 * @param ticket   SSE 专用短效票据（可选；无票据时不带 query 参数）
 */
export function buildSseUrl(baseUrl: string, path: string, ticket?: string | null): string {
  const base = baseUrl.replace(/\/$/, '');
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return ticket
    ? `${base}${cleanPath}?ticket=${encodeURIComponent(ticket)}`
    : `${base}${cleanPath}`;
}
