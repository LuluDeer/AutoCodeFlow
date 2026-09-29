import { Logger } from "@nestjs/common";
import { createReadStream, ReadStream } from "fs";

/**
 * ARCH-008 / P1-2：返回给客户端的下载流统一从本封装创建。
 *
 * ## 为什么必须挂 error 监听
 *
 * `fs.createReadStream` 的文件打开是异步的——`existsSync`/`statSync` 之后、
 * 流真正 open 之前文件被删/改名（保留期清理、并发删除），open 时的 ENOENT
 * 会作为 `'error'` 事件发出；EventEmitter 的 error 无监听时 Node 直接抛出
 * uncaughtException —— main.ts 的 ARCH-008 处理器虽然兜住不至整实例崩溃，
 * 但代价是整次 graceful shutdown（该实例上所有 in-flight 请求被排空下线）。
 * 本封装把「进程级事故」降级为「该次下载失败」：监听 error → 记 warn（带
 * 路径与错误）→ destroy() 释放句柄，不再冒泡。
 *
 * 服务层 NotFound 语义不受影响：缺文件的 404 判定仍在创建流之前（existsSync
 * 等），本封装只处理「判定后窗口期丢文件」的竞态。
 *
 * 全仓守卫：src/common/utils/__tests__/response-stream-error-listener.guard.spec.ts
 * 扫描所有 `createReadStream(` 调用点，强制「走本封装 / 自带 error 监听 /
 * 显式 allowlist」三选一。
 */

const defaultLogger = new Logger("ResponseStream");

/**
 * 创建挂好 error 监听的响应下载流。注意：错误只被降级记录——HTTP 语义上
 * 此时响应头可能已发出（StreamableFile 场景），调用方无法也不需要再改写
 * 状态码；客户端侧表现为连接中断/下载失败。
 */
export function createResponseReadStream(
  filePath: string,
  logger: Pick<Logger, "warn"> = defaultLogger,
): ReadStream {
  const stream = createReadStream(filePath);
  stream.on("error", (err: Error) => {
    // warn 而非 error：单次下载失败是可恢复的业务事件，不构成告警级事故
    logger.warn(
      `Response stream failed for "${filePath}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    // autoDestroy 语义兜底：显式 destroy 释放底层 fd，杜绝句柄泄漏
    stream.destroy();
  });
  return stream;
}
