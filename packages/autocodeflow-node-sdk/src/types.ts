/**
 * Log level for task execution entries.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * A single log entry produced during task execution.
 */
export interface LogEntry {
  /** ISO timestamp when the log was emitted */
  timestamp: string;
  /** Severity level */
  level: LogLevel;
  /** Human-readable message */
  message: string;
  /** Optional structured metadata */
  meta?: Record<string, unknown>;
}

/**
 * Environment variables injected into every task execution context.
 */
export interface TaskEnv {
  /** Unique identifier for this task execution */
  executionId: string;
  /** ID of the parent task definition */
  taskId: string;
  /** Display name of the task */
  taskName: string;
  /** Base URL of the Admin API (e.g. http://admin-api:3000) */
  adminApiUrl: string;
  /** Bearer token authorising requests to the Admin API */
  executorToken: string;
  /** Optional distributed trace identifier */
  traceId?: string;
}

/**
 * The value returned (and reported back to the Admin API) by a task handler.
 */
export interface TaskResult {
  /** Whether the task completed successfully */
  success: boolean;
  /** Optional human-readable summary */
  message?: string;
  /** Arbitrary structured output produced by the task */
  output?: Record<string, unknown>;
  /** Logs collected during execution */
  logs?: LogEntry[];
}
