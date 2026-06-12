import { LogEntry, LogLevel } from './types';

/**
 * Lightweight structured logger for task execution.
 *
 * Writes every entry to the appropriate `console.*` method and
 * retains an in-memory copy that can be flushed at task completion.
 */
export class TaskLogger {
  private readonly entries: LogEntry[] = [];

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

    const prefix = `[${entry.timestamp}] [${level.toUpperCase()}]`;
    const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
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
   * Return a shallow copy of all collected log entries.
   * The original array is not modified by the caller.
   */
  getLogs(): LogEntry[] {
    return [...this.entries];
  }

  /** Discard all collected entries (useful between sub-steps in a long task). */
  clear(): void {
    this.entries.length = 0;
  }
}
