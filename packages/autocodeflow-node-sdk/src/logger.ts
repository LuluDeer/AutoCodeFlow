import { LogEntry, LogLevel } from './types';

/**
 * SDK-LOG-01（本轮审计）：`JSON.stringify` 对循环引用与 BigInt 会**抛错**
 * （TypeError: Converting circular structure to JSON / Do not know how to
 * serialize a BigInt）。logger 此前在拼 console 前缀时直接调用它，任何
 * `ctx.logger.info('x', circularObj)` 都会把 TypeError 抛回**用户任务代码**
 * 的调用点，把一条日志变成崩溃；而记录该崩溃的那条 entry 已入 ring，却永远
 * 打不出来。context.ts 的 stringifyError 早已用 try/catch 兜住同一风险
 * （注释直指 "circular structures etc."），logger 这边漏了。
 *
 * 兜底策略：序列化失败时退化为 String(meta)，日志行为不变、绝不抛错。
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Lightweight structured logger for task execution.
 *
 * Writes every entry to the appropriate `console.*` method and
 * retains an in-memory copy that can be flushed at task completion.
 *
 * PK-24: the in-memory buffer is a bounded ring — long-running tasks
 * (executor allows fixed_rate schedules of 1..86400s) emitting high-frequency
 * `ctx.logger.info` calls used to grow the buffer without limit. At most
 * {@link TaskLogger.MAX_ENTRIES} entries are retained (oldest evicted
 * first); every evicted entry increments {@link TaskLogger.droppedCount}
 * so the truncation stays observable instead of silent.
 */
export class TaskLogger {
  /** Ring-buffer cap on retained entries (PK-24). */
  public static readonly MAX_ENTRIES = 1000;

  private readonly entries: LogEntry[] = [];
  private dropped = 0;

  // ------------------------------------------------------------------ helpers
  private log(
    level: LogLevel,
    message: string,
    meta?: Record<string, unknown>,
  ): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(meta !== undefined ? { meta } : {}),
    };

    this.entries.push(entry);
    // PK-24: evict the oldest entry once the ring is full — memory stays
    // bounded and the loss is counted, never silent.
    while (this.entries.length > TaskLogger.MAX_ENTRIES) {
      this.entries.shift();
      this.dropped += 1;
    }

    const prefix = `[${entry.timestamp}] [${level.toUpperCase()}]`;
    const suffix = meta ? ` ${safeStringify(meta)}` : '';
    const formatted = `${prefix} ${message}${suffix}`;

    switch (level) {
      case 'debug':
        console.debug(formatted);
        break;
      case 'info':
        console.info(formatted);
        break;
      case 'warn':
        console.warn(formatted);
        break;
      case 'error':
        console.error(formatted);
        break;
    }
  }

  // ------------------------------------------------------------------ public API

  /** Emit a debug-level message. */
  debug(message: string, meta?: Record<string, unknown>): void {
    this.log('debug', message, meta);
  }

  /** Emit an info-level message. */
  info(message: string, meta?: Record<string, unknown>): void {
    this.log('info', message, meta);
  }

  /** Emit a warning-level message. */
  warn(message: string, meta?: Record<string, unknown>): void {
    this.log('warn', message, meta);
  }

  /** Emit an error-level message. */
  error(message: string, meta?: Record<string, unknown>): void {
    this.log('error', message, meta);
  }

  /**
   * Return a shallow copy of the retained log entries (at most
   * {@link TaskLogger.MAX_ENTRIES}, oldest first).
   *
   * PK-24: this is a bounded ring, not the full history — entries evicted
   * by the cap are NOT included here. Use {@link TaskLogger.droppedCount}
   * to know how many were lost (a `logsDropped` hint is attached to the
   * TaskResult by the context when it flushes these logs).
   * The original array is not modified by the caller.
   */
  getLogs(): LogEntry[] {
    return [...this.entries];
  }

  /** Number of log entries evicted by the ring-buffer cap (PK-24). */
  get droppedCount(): number {
    return this.dropped;
  }

  /** Discard all collected entries (useful between sub-steps in a long task). */
  clear(): void {
    this.entries.length = 0;
    // PK-24: explicit clear is a deliberate discard, not ring overflow —
    // the dropped counter tracks capacity overflow only.
  }
}
