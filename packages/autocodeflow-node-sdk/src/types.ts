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
 *
 * N23: executor-node (SEC-01 env whitelist) only injects the task-scoped
 * trio EXECUTION_ID / TASK_ID / TASK_NAME — Admin API credentials are
 * deliberately NOT forwarded to task subprocesses, so `adminApiUrl` and
 * `executorToken` are optional here. When they are absent the Admin API
 * callback surface (`HttpClient`) is explicitly disabled rather than an
 * error at construction time.
 */
export interface TaskEnv {
  /** Unique identifier for this task execution */
  executionId: string;
  /** ID of the parent task definition */
  taskId: string;
  /** Display name of the task */
  taskName: string;
  /** Base URL of the Admin API (e.g. http://admin-api:3000). Optional: not injected by the executor. */
  adminApiUrl?: string;
  /** Bearer token authorising requests to the Admin API. Optional: not injected by the executor. */
  executorToken?: string;
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
