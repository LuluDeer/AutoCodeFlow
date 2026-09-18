import { createLogger, format, transports } from 'winston';
import { AsyncLocalStorage } from 'node:async_hooks';

// LOG_LEVEL 透传：compose（docker-compose.yml 的 LOG_LEVEL: ${LOG_LEVEL:-info}）
// 与桌面端（buildExecutorChildEnv 把设置页 logLevel 下发为 LOG_LEVEL）共用这一
// 个键。此前本文件把 level 硬编码为 'info'，导致桌面端 config.logLevel 是个
// 没有消费者的死字段、.env.example 里的 LOG_LEVEL 也不生效。白名单校验：
// 非法值静默回落 info，绝不因为一个拼错的级别让日志子系统在启动路径上抛错。
const ALLOWED_LEVELS = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'];
const requestedLevel = (process.env.LOG_LEVEL || '').toLowerCase();
const logLevel = ALLOWED_LEVELS.includes(requestedLevel) ? requestedLevel : 'info';

/**
 * 8-1（audit-r4）：trace context 注入——AsyncLocalStorage 承载当前执行链的
 * traceId，日志格式化时自动附加（文本格式 `[trace=...]`，JSON 格式独立字段）。
 *
 * 使用：执行链起点（execute.ts runTask 包装器）以 `runWithTrace({ traceId },
 * fn)` 包裹，链内所有 logger.* 调用自动带 traceId——执行器内部日志可按 trace
 * 关联，与回调回传的 traceparent 头（callback.ts OBS-01）同源。
 */
export const traceContext = new AsyncLocalStorage<{ traceId?: string }>();

export function runWithTrace<T>(ctx: { traceId?: string }, fn: () => T): T {
  return traceContext.run(ctx, fn);
}

export function currentTraceId(): string | undefined {
  return traceContext.getStore()?.traceId;
}

/**
 * 8-3（audit-r4）：结构化日志。LOG_FORMAT=json 时输出单行 JSON
 * （timestamp/level/message/traceId），ELK/Loki 可直接解析；默认保持既有文本
 * 格式（新增 `[trace=...]` 段，文本逐字节格式不变）。
 */
const jsonFormatEnabled = (process.env.LOG_FORMAT || '').trim().toLowerCase() === 'json';

const attachTraceId = format((info) => {
  const traceId = currentTraceId();
  if (traceId) {
    (info as { traceId?: string }).traceId = traceId;
  }
  return info;
})();

const baseFormat = format.combine(format.timestamp(), attachTraceId, format.errors({ stack: true }));

const outputFormat = jsonFormatEnabled
  ? format.combine(baseFormat, format.json())
  : format.combine(
      baseFormat,
      format.printf(({ timestamp, level, message, traceId }) => {
        const traceSegment = traceId ? ` [trace=${traceId}]` : '';
        return `${timestamp} [${String(level).toUpperCase()}]${traceSegment} ${String(message)}`;
      }),
    );

export const logger = createLogger({
  level: logLevel,
  format: outputFormat,
  transports: [new transports.Console()],
});
