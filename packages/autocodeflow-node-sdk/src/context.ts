import { HttpClient } from './http-client';
import { TaskEnv, TaskResult, LogEntry } from './types';
import { TaskLogger } from './logger';

/**
 * ECO-01: CallbackItemDto field caps (parity with the python SDK's
 * `callback.py` constants and the admin DTO
 * apps/admin-api/src/modules/task/dto/execution-callback.dto.ts).
 */
export const ERROR_MESSAGE_MAX_LENGTH = 4096;
export const LOGS_MAX_LENGTH = 512_000;

/**
 * ECO-01: stringify an arbitrary thrown value for the callback item's
 * `errorMessage` field. Language-native equivalent of the python SDK's
 * `str(error)` — Error instances contribute their message, plain objects
 * serialize as JSON (python's str() renders a dict repr), anything else
 * falls back to `String()`. The result is truncated to the DTO's 4 KB cap
 * by `reportFailure`.
 */
function stringifyError(error: unknown): string {
  if (error === undefined || error === null) return '';
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error); // circular structures etc.
  }
}

/** Options for `TaskContext.reportSuccess()` (ECO-01, mirrors the python SDK's
 *  `report_success(summary=..., duration_ms=...)` keywords). */
export interface ReportSuccessOptions {
  /** Written to the callback item's `logs` field (truncated to LOGS_MAX_LENGTH). */
  summary?: string;
  /** Written to the callback item's `durationMs` field (omitted when undefined). */
  durationMs?: number;
}

/** Options for `TaskContext.reportFailure()` (mirrors the python SDK's
 *  `report_failure(error, summary=..., duration_ms=..., failure_reason=...)`). */
export interface ReportFailureOptions {
  summary?: string;
  durationMs?: number;
  /**
   * admin-api `ExecutionFailureReason` value. Defaults to `script_error` —
   * the same default as the python SDK.
   *
   * NETOPT-F P3-2: 本地白名单早拒，与 python SDK 对齐（callback.py 的
   * VALID_FAILURE_REASONS 早拒 ValueError）——旧实现是 thin client 靠 admin
   * DTO @IsIn 拒绝；非法值发 admin 被 400 拒后（P2-4 的 4xx 单发语义）任务
   * 代码拿到远端错误且白烧一次 HTTP。白名单与 admin 的 executorReportable
   * 子集同源（单一事实源：
   * packages/executor-protocol/protocol.json failureReason.executorReportable，
   * 与 python callback.py 逐值对齐；改动前先同步协议与 python 端）。
   */
  failureReason?: string;
}

/** admin-api `ExecutionFailureReason` 中**执行器可上报**子集（与 python SDK
 *  callback.py VALID_FAILURE_REASONS 逐值对齐）。 */
export const VALID_FAILURE_REASONS: ReadonlySet<string> = new Set([
  'package_fetch_failed',
  'script_error',
  'timeout',
  'executor_offline',
  'executor_restart',
  'dependency_install_failed',
  'git_fetch_failed',
  'runtime_missing',
  'sandbox_unavailable',
  'interpreter_unavailable',
  'killed',
  'unknown',
]);

/** The typed params channel injected by both executors since protocol v5. */
export const PARAMS_JSON_ENV_KEY = 'AUTOFLOW_PARAMS_JSON';

/**
 * A-11R: read the typed `AUTOFLOW_PARAMS_JSON` channel.
 *
 * Returns `undefined` when the channel is absent (executor < protocol v5) or
 * unusable, so callers fall back to the per-key variables. A malformed or
 * non-object payload must never throw here: a task that cannot build its
 * context reports nothing useful, whereas degrading loses only type fidelity.
 */
export function loadTypedParams(
  raw: string | undefined = process.env[PARAMS_JSON_ENV_KEY],
): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

/**
 * A-11R: best-effort type recovery for the per-key `AUTOFLOW_<KEY>` fallback.
 *
 * The executor renders strings **bare** (`AUTOFLOW_REGION=欧盟`) and
 * non-strings as JSON (`AUTOFLOW_DRY_RUN=true`, `AUTOFLOW_TAGS=["a",2]`).
 * Parsing every value as JSON would be wrong for the common case — a user who
 * typed `3` or a date meant the *string* — so only the shapes JSON produces
 * for a non-string are decoded: containers, the three literals, and numbers
 * carrying a JSON-only marker (exponent or decimal point).
 *
 * Inherently lossy; `getParam` prefers the typed channel whenever present.
 */
export function coerceParamValue(value: string): unknown {
  if (!value) return value;
  const first = value[0];
  if (first === '[' || first === '{') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (value === 'true' || value === 'false' || value === 'null') {
    return JSON.parse(value);
  }
  if (first === '"') {
    // A-11 legacy form (executors < protocol v5) injected strings JSON-quoted,
    // so `"欧盟"` is the user's string 欧盟 carrying a pair of stray quotes.
    // Recovering it repairs the fallback path for the whole pre-v5 fleet.
    // (On v5 this branch is unreachable for user params — they come from the
    // typed channel; only non-param platform variables are read per-key, and
    // their values do not begin with a quote.)
    try {
      const decoded = JSON.parse(value);
      return typeof decoded === 'string' ? decoded : value;
    } catch {
      return value;
    }
  }
  if (first === '-' || (first >= '0' && first <= '9')) {
    if (value.includes('.') || value.includes('e') || value.includes('E')) {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
  }
  return value;
}

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
      // ADR-017 阶段 3 (protocol v6): stable install identity of the executor
      // row — same optional, omit-when-absent semantics as the address above.
      deviceFingerprint: process.env['AUTOFLOW_DEVICE_FINGERPRINT'],
      traceId: process.env['TRACE_ID'],
      // A-11R: typed params channel (protocol v5+). Absent on older executors.
      params: loadTypedParams(),
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
   * Flush the collected logs into a TaskResult-shaped field set.
   *
   * PK-24: `logger.getLogs()` is a bounded ring (see TaskLogger.MAX_ENTRIES);
   * when the ring evicted entries the result carries a `logsDropped` hint so
   * the truncation is observable instead of silent — semantics aligned with
   * the logger's `droppedCount`.
   */
  private flushLogs(): Pick<TaskResult, 'logs' | 'logsDropped'> {
    const logs = this.logger.getLogs();
    const dropped = this.logger.droppedCount;
    return dropped > 0 ? { logs, logsDropped: dropped } : { logs };
  }

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
      ...this.flushLogs(),
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
      ...this.flushLogs(),
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

  /**
   * Shorthand for `this.env.deviceFingerprint` — the stable install identity
   * of the executor running this task (ADR-017 阶段 3, executor protocol v6,
   * injected as `AUTOFLOW_DEVICE_FINGERPRINT`). Same value the executor
   * reports on register/heartbeat: `sha256(deviceId + ':' + installSalt)`.
   *
   * It is the callback face's **row identity**: a shared/legacy callback
   * token is bound to no executor row, and pull mode allows several rows to
   * share one `executorAddress`, so this is what lets the admin attribute a
   * callback to the row that dispatched it. `undefined` on older executors
   * or when the executor's probe failed; `ctx.http` only auto-fills callback
   * items when it is present.
   */
  get deviceFingerprint(): string | undefined {
    return this.env.deviceFingerprint;
  }

  /**
   * The task's parameters with their real types, or `undefined` on executors
   * older than protocol v5 (see `TaskEnv.params`).
   */
  get params(): Record<string, unknown> | undefined {
    return this.env.params;
  }

  /**
   * Read a task parameter (A-11R).
   *
   * Prefers the typed `AUTOFLOW_PARAMS_JSON` channel, so `true`/`3`/nested
   * structures come back with their real types. Falls back to the per-key
   * `AUTOFLOW_<KEY>` variable on older executors, where type recovery is
   * best-effort (see `coerceParamValue`) — a bare user string such as `欧盟`,
   * `3` or a date stays a string there.
   *
   * The key is matched case-insensitively against the typed channel (the
   * executor upper-cases per-key names, so tasks have always written
   * `getParam('limit')` for a param configured as `LIMIT`).
   */
  getParam(key: string, fallback?: unknown): unknown {
    const typed = this.env.params;
    if (typed) {
      if (Object.prototype.hasOwnProperty.call(typed, key)) return typed[key];
      const upper = key.toUpperCase();
      for (const [k, v] of Object.entries(typed)) {
        if (k.toUpperCase() === upper) return v;
      }
      // A key genuinely absent from the typed channel is genuinely absent —
      // do not second-guess it via the per-key fallback, which could only
      // return platform variables that are not params.
      return fallback;
    }
    const raw = process.env[`AUTOFLOW_${key.toUpperCase()}`];
    if (raw === undefined) return fallback;
    return coerceParamValue(raw);
  }

  // ------------------------------------------------------------------ callback shorthands

  /**
   * Build the `executorAddress` / `deviceFingerprint` fields for a callback
   * item: each is present only when this executor's value is known — an
   * omitted field is never sent as an empty string (the python SDK's
   * `report_success`/`report_failure` do exactly this, and the admin DTO
   * treats empty the same as absent).
   *
   * ADR-017 阶段 3: `deviceFingerprint` rides along here because it is the
   * callback face's row identity — the shared/legacy token binds to no row,
   * and `executorAddress` cannot disambiguate pull-mode rows sharing one
   * address (ADR-017 §5).
   */
  private callbackAddressField(): Record<string, unknown> {
    return {
      ...(this.env.executorAddress
        ? { executorAddress: this.env.executorAddress }
        : {}),
      ...(this.env.deviceFingerprint
        ? { deviceFingerprint: this.env.deviceFingerprint }
        : {}),
    };
  }

  /**
   * ECO-01: report `status=success` for this execution — the node-side twin
   * of the python SDK's `ctx.report_success(summary=..., duration_ms=...)`.
   * `executionId` is pinned to this execution and `executorAddress` is
   * stamped automatically (N27); the response is the unwrapped
   * `{ results: [...] }` payload (U14 envelope handling in HttpClient).
   *
   * Throws when the client is disabled (missing credentials) — the same
   * fail-closed behavior as a manual `ctx.http.post(...)` on a disabled
   * client; gate on `ctx.http.enabled` when capability is uncertain.
   */
  reportSuccess(options: ReportSuccessOptions = {}): Promise<unknown> {
    const { summary, durationMs } = options;
    const item: Record<string, unknown> = {
      executionId: this.env.executionId,
      status: 'success',
      ...this.callbackAddressField(),
    };
    if (summary) item.logs = summary.slice(0, LOGS_MAX_LENGTH);
    if (durationMs !== undefined) item.durationMs = durationMs;
    return this.http.post('/api/executions/callback', [item]);
  }

  /**
   * ECO-01: report `status=failed` for this execution — the node-side twin
   * of the python SDK's `ctx.report_failure(error, ...)`. `error` is
   * stringified into `errorMessage` and truncated to the DTO's 4 KB cap
   * (`ERROR_MESSAGE_MAX_LENGTH`, python parity).
   */
  reportFailure(error: unknown, options: ReportFailureOptions = {}): Promise<unknown> {
    const { summary, durationMs, failureReason = 'script_error' } = options;
    // NETOPT-F P3-2: 本地早拒（python SDK 同款）——非法值不发 HTTP，报错
    // 带合法值列表；否则 admin @IsIn 400 后 P2-4 的 4xx 单发语义下任务代码
    // 只拿到远端错误。
    if (!VALID_FAILURE_REASONS.has(failureReason)) {
      throw new TypeError(
        `invalid failureReason ${JSON.stringify(failureReason)}; expected one of ` +
          [...VALID_FAILURE_REASONS].sort().join(', '),
      );
    }
    const item: Record<string, unknown> = {
      executionId: this.env.executionId,
      status: 'failed',
      errorMessage: stringifyError(error).slice(0, ERROR_MESSAGE_MAX_LENGTH),
      failureReason,
      ...this.callbackAddressField(),
    };
    if (summary) item.logs = summary.slice(0, LOGS_MAX_LENGTH);
    if (durationMs !== undefined) item.durationMs = durationMs;
    return this.http.post('/api/executions/callback', [item]);
  }
}
