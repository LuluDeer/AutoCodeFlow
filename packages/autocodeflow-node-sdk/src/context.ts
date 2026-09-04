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
   * HTTP client for the Admin API.
   *
   * N23: on a real executor the task subprocess receives a per-execution
   * one-shot callback credential (`AUTOFLOW_CALLBACK_TOKEN`, an HMAC token
   * bound to this executionId with a short TTL) plus the non-secret
   * `AUTOFLOW_ADMIN_API_URL`, so `ctx.http` is ENABLED out of the box and
   * may only call back for this execution. The executor shared token is
   * deliberately never injected (SEC-01). On older executors (or when no
   * secret is configured) the credentials are absent and the client is
   * *disabled* — check `ctx.http.enabled` before using it.
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
   * Callback credentials (injected by executor-node since N23):
   * - `AUTOFLOW_ADMIN_API_URL` — Admin API base URL (non-secret routing info)
   * - `AUTOFLOW_CALLBACK_TOKEN` — per-execution one-shot `v1.` HMAC token,
   *   valid only for this executionId and until its TTL expires
   * - `AUTOFLOW_EXECUTOR_ADDRESS` — (since N27) the address this executor
   *   registered with; required on every callback item and auto-filled by
   *   `ctx.http` on `/api/executions/callback` requests
   *
   * Legacy / manual overrides (take precedence when set, e.g. tests or
   * self-hosted setups that provide a full shared token):
   * - `ADMIN_API_URL`
   * - `EXECUTOR_TOKEN`
   * - `TRACE_ID`
   *
   * When no credentials are present at all (old executor versions, dev
   * executor without a configured secret), construction still succeeds and
   * `this.http` is an explicitly disabled `HttpClient` (N23).
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
      // Legacy explicit vars win over the executor-injected AUTOFLOW_* pair.
      adminApiUrl:
        process.env['ADMIN_API_URL'] || process.env['AUTOFLOW_ADMIN_API_URL'],
      executorToken:
        process.env['EXECUTOR_TOKEN'] || process.env['AUTOFLOW_CALLBACK_TOKEN'],
      // N27: non-secret routing info injected by executor-node.
      executorAddress: process.env['AUTOFLOW_EXECUTOR_ADDRESS'],
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

  /**
   * Shorthand for `this.env.executorAddress` — the address of the executor
   * running this task (N27, injected as `AUTOFLOW_EXECUTOR_ADDRESS`).
   * `undefined` on older executors; `ctx.http` only auto-fills callback
   * items when it is present.
   */
  get executorAddress(): string | undefined {
    return this.env.executorAddress;
  }
}
