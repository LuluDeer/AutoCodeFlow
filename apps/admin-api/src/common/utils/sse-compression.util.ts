import type { Request, Response } from "express";
import compression from "compression";

/**
 * P1-1a（nginx-sse 生产事故根治）：compression filter 的 SSE 豁免谓词。
 *
 * ## 事故根因（为什么按 content-type 豁免是根治）
 *
 * compression@1.8.2（apps/admin-api/node_modules/compression/index.js）：
 * - filter 在 `onHeaders` 钩子内调用（index.js:174-179），即 `writeHead()` 同步
 *   执行段——此时所有 `res.setHeader("Content-Type", ...)` 都已生效（@Res() 直写
 *   的 SSE 控制器在建流同步段先 setHeader 再 flushHeaders()/首帧 write）。这与
 *   compression 自带默认 filter 读 `res.getHeader("Content-Type")`（index.js:299-307）
 *   是同一份时序契约，因此按响应 content-type 判定是可靠的。
 * - `text/event-stream` 在 mime-db 中标记为 compressible，于是默认 filter 放行
 *   gzip → `res.write` 被替换为写入 zlib deflate 流（index.js:101-113）。小帧
 *   （如 ": ping\n\n" 共 9 字节）滞留在 zlib 内部缓冲：zlib 不满 16KB 输出缓冲
 *   且无人调 `res.flush()`（index.js:93-97）就永不落到 socket —— nginx 侧
 *   proxy_read_timeout（旧值 60s）收不到任何字节，upstream timed out（当日
 *   error.log 793 条）。
 *
 * ## 兜底（双保险）
 *
 * 内容判定之外保留旧的路径判定（`/logs/stream` 结尾）：即便某个 SSE 控制器
 * 忘了在首次 write 前设置 Content-Type（那时 filter 只能看到 undefined——
 * compression 的 onHeaders 时序决定 filter 不可能在首帧前被调用，见上），
 * 路径判定仍能兜住既有日志流。两条判定是"或"关系，任一命中即豁免。
 *
 * main.ts 只做接线（`filter: sseAwareCompressionFilter`），单测直接测本文件，
 * 不 import main.ts（其顶层有 dotenv 副作用）。
 */

/** SSE 响应的 content-type 特征串（大小写不敏感比较）。 */
export const SSE_CONTENT_TYPE = "text/event-stream";

/**
 * 响应 content-type 是否为 SSE。`getHeader` 在 writeHead 前读的是已 setHeader
 * 的值；未设置（undefined）返回 false——交由调用方（默认 filter 的
 * compressible 判定 / 路径兜底）决定。
 */
export function hasSseContentType(
  res: Pick<Response, "getHeader">,
): boolean {
  const contentType = res.getHeader("content-type");
  if (contentType === undefined || contentType === null) return false;
  const value = Array.isArray(contentType)
    ? contentType.join(",")
    : String(contentType);
  return value.toLowerCase().includes(SSE_CONTENT_TYPE);
}

/**
 * 历史豁免路径（双保险）：日志流 GET /api/tasks/:id/executions/:execId/logs/stream。
 */
export function isSsePath(req: Pick<Request, "path">): boolean {
  return typeof req.path === "string" && req.path.endsWith("/logs/stream");
}

/**
 * 该响应当前是否应按 SSE 处理（豁免压缩）。content-type 判定为主，
 * /logs/stream 路径判定为兜底。
 */
export function isSseResponse(
  req: Pick<Request, "path">,
  res: Pick<Response, "getHeader">,
): boolean {
  return hasSseContentType(res) || isSsePath(req);
}

/**
 * compression({ filter }) 的接线函数：SSE 响应一律 return false（不压缩，
 * 帧直写 socket），其余请求回落到 compression 自带的 compressible/Accept-
 * Encoding 判定链——非 SSE 路由的压缩收益不受影响。
 */
export function sseAwareCompressionFilter(
  req: Request,
  res: Response,
): boolean {
  if (isSseResponse(req, res)) return false;
  return compression.filter(req, res);
}
