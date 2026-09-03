import { HttpClient } from './http-client';
import { TaskEnv, TaskResult, LogEntry } from './types';
import { TaskLogger } from './logger';

/**
 * Runtime context handed to every task handler.
 *
 * Provides:
 * - structured logging via `this.logger`
 * - a ready-to-use Admin API client via `this.http`
 * - convenience `success()` / `failure()` result builders
 */
export class TaskContext {
  /**
   * Structured logger whose entries are included in the final result. */
  readonly logger: TaskLogger;

  /**
   * HTTP client for the Admin API. N23: the executor intentionally does
   * not inject ADMIN_API_URL / EXECUTOR_TOKEN into task subprocesses
   * (SEC-01), so on a real executor this client is *disabled* — calling
   * any request method throws a clear error instead of silently failing.
   * Check `ctx.http.enabled` before using it.
   */
  readonly http: HttpClient;

  /** The resolved environment for this execution. */
  readonly env: TaskEnv;

  private constructor(env: TaskEnv) {
    this.env = env;
    this.logger = new TaskLogger();
    this.http = HttpClient.forAdminApi(env);
  }

  // ------------------------------------------------------------------ factories

  /**
   * Build a `TaskContext` from `process.env`.
   *
   * Required (injected by executor-node):
   * - `EXECUTION_ID`
   * - `TASK_ID`
   * - `TASK_NAME`
   *
   * Optional (NOT injected by the executor — SEC-01 keeps Admin API
   * credentials out of task subprocesses; supply them only when the
   * process really has them):
   * - `ADMIN_API_URL`
   * - `EXECUTOR_TOKEN`
   * - `TRACE_ID`
   *
   * When the optional credentials are absent, construction still succeeds
   * and `this.http` is an explicitly disabled `HttpClient` (N23).
   *
   * @throws {Error} if any required variable is missing.
   */
  static fromEnv(): TaskContext {
    const required = ['EXECUTION_ID', 'TASK_ID', 'TASK_NAME'] as const;

    for (const key of required) {
      if (!process.env[key]) {
        throw new Error(
          `TaskContext.fromEnv(): missing required environment variable "${key}"`,
        );
      }
    }

    const env: TaskEnv = {
      executionId: process.env['EXECUTION_ID']!,
      taskId: process.env['TASK_ID']!,
      taskName: process.env['TASK_NAME']!,
      adminApiUrl: process.env['ADMIN_API_URL'],
      executorToken: process.env['EXECUTOR_TOKEN'],
      traceId: process.env['TRACE_ID'],
    };

    return new TaskContext(env);
  }

  /**
   * Build a `TaskContext` from an explicit `TaskEnv` object.
   * Useful in tests and when env vars are injected differently.
   */
  static create(env: TaskEnv): TaskContext {
    return new TaskContext(env);
  }

  // ------------------------------------------------------------------ result builders

  /**
   * Build a successful `TaskResult`, automatically attaching collected logs.
   */
  success(
    message?: string,
    output?: Record<string, unknown>,
  ): TaskResult {
    return {
      success: true,
      ...(message !== undefined ? { message } : {}),
      ...(output !== undefined ? { output } : {}),
      logs: this.logger.getLogs(),
    };
  }

  /**
   * Build a failure `TaskResult`, automatically attaching collected logs.
   */
  failure(
    message?: string,
    output?: Record<string, unknown>,
  ): TaskResult {
    return {
      success: false,
      ...(message !== undefined ? { message } : {}),
      ...(output !== undefined ? { output } : {}),
      logs: this.logger.getLogs(),
    };
  }

  // ------------------------------------------------------------------ convenience

  /** Shorthand for `this.env.executionId`. */
  get executionId(): string {
    return this.env.executionId;
  }

  /** Shorthand for `this.env.taskId`. */
  get taskId(): string {
    return this.env.taskId;
  }

  /** Shorthand for `this.env.taskName`. */
  get taskName(): string {
    return this.env.taskName;
  }
}
