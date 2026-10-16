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
 * N23: executor-node injects the task-scoped trio EXECUTION_ID / TASK_ID /
 * TASK_NAME plus the per-execution callback pair AUTOFLOW_ADMIN_API_URL /
 * AUTOFLOW_CALLBACK_TOKEN (a one-shot HMAC token bound to this executionId
 * with a short TTL — never the executor shared token, SEC-01 holds).
 * `TaskContext.fromEnv()` maps the AUTOFLOW_* pair onto `adminApiUrl` /
 * `executorToken` (legacy ADMIN_API_URL / EXECUTOR_TOKEN win when set).
 * When neither is present (old executors, dev mode) the Admin API callback
 * surface (`HttpClient`) is explicitly disabled rather than an error at
 * construction time.
 */
export interface TaskEnv {
  /** Unique identifier for this task execution */
  executionId: string;
  /** ID of the parent task definition */
  taskId: string;
  /** Display name of the task */
  taskName: string;
  /** Base URL of the Admin API (e.g. http://admin-api:3105). Injected as AUTOFLOW_ADMIN_API_URL by executor-node since N23; optional on older executors. */
  adminApiUrl?: string;
  /** Bearer token authorising requests to the Admin API. Injected as AUTOFLOW_CALLBACK_TOKEN (per-execution, execution-bound, expiring) since N23; a shared token only when supplied manually. */
  executorToken?: string;
  /**
   * Address this executor registered with (e.g. `executor-node:8002`).
   * Injected as AUTOFLOW_EXECUTOR_ADDRESS by executor-node since N27 —
   * non-secret routing info. The per-execution callback path requires
   * `executorAddress` on every callback item; `HttpClient` fills it in
   * automatically, and `TaskContext.executorAddress` exposes it for code
   * that builds payloads by hand.
   */
  executorAddress?: string;
  /**
   * Stable install identity of the executor running this task — the same
   * `sha256(deviceId + ':' + installSalt)` value it reports on
   * register/heartbeat (ADR-017 phase 3, executor protocol v6).
   *
   * Why the callback face needs it: the shared/legacy callback token is a
   * fleet-wide secret bound to no executor row, and pull mode allows several
   * rows to share one address (ADR-017 §5), so `executorAddress` alone can no
   * longer identify which row a callback came from. This field carries the
   * row identity directly. Only the hash is ever sent — never the raw
   * machine id.
   *
   * Injected as `AUTOFLOW_DEVICE_FINGERPRINT` by executor-node since
   * protocol v6, alongside `AUTOFLOW_EXECUTOR_ADDRESS`. Optional for the
   * same reasons the address is: older executors, a failed probe and
   * task-code callbacks that predate the field are all legitimate. When
   * known, `HttpClient` stamps it onto callback items automatically and
   * `TaskContext.deviceFingerprint` exposes it for hand-built payloads.
   * When unknown the key is **omitted entirely** — never an empty string.
   */
  deviceFingerprint?: string;
  /** Optional distributed trace identifier */
  traceId?: string;
  /**
   * Task parameters with their **real types** (A-11R, executor protocol v5).
   *
   * Populated from the typed `AUTOFLOW_PARAMS_JSON` channel both executors
   * inject alongside the per-key `AUTOFLOW_<KEY>` variables. It is the only
   * lossless source: every per-key value is a string by construction, so that
   * channel cannot distinguish the string `"true"` from the boolean `true`.
   *
   * `undefined` on executors older than protocol v5 — `ctx.getParam()` then
   * falls back to reading the per-key variables, which is best-effort.
   */
  params?: Record<string, unknown>;
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
  /** Logs collected during execution (bounded ring, see TaskLogger.MAX_ENTRIES) */
  logs?: LogEntry[];
  /**
   * PK-24: number of log entries evicted by the logger's ring-buffer cap
   * before the result was built. Present only when > 0 — `logs` holds the
   * retained tail, not the full history.
   */
  logsDropped?: number;
}
