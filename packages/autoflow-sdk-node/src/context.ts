import { AutoFlowLogger, getLogger } from './logger';
import { AutoFlowHTTP } from './http';

/**
 * Task execution result returned to the scheduler.
 */
export interface TaskResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Configuration for AutoFlowContext.
 */
export interface AutoFlowContextConfig {
  executionId: string;
  taskId: string;
  taskName?: string;
  params?: Record<string, unknown>;
}

/**
 * AutoFlowContext — provides runtime metadata and helpers to a running task.
 *
 * @example
 * ```typescript
 * const { AutoFlowContext } = require('@autocodeflow/sdk');
 *
 * const context = new AutoFlowContext({
 *   executionId: "exec-123",
 *   taskId: "daily-report",
 *   params: { outputPath: "/data" }
 * });
 *
 * const logger = context.logger;
 * logger.info("任务开始");
 *
 * const outputPath = context.params.outputPath;
 * const response = await context.http.get("https://api.example.com/data");
 * ```
 */
export class AutoFlowContext {
  readonly executionId: string;
  readonly taskId: string;
  readonly taskName: string;
  readonly params: Record<string, unknown>;

  readonly logger: AutoFlowLogger;
  readonly http: AutoFlowHTTP;

  private _config: Record<string, unknown> = {};

  constructor(config: AutoFlowContextConfig) {
    this.executionId = config.executionId;
    this.taskId = config.taskId;
    this.taskName = config.taskName || config.taskId;
    this.params = config.params || {};

    this.logger = getLogger(this.taskName);
    this.http = new AutoFlowHTTP();
  }

  /**
   * Create AutoFlowContext from environment variables injected by the executor.
   *
   * Reads EXECUTION_ID, TASK_ID, TASK_NAME, and all AUTOFLOW_* vars as params.
   * This is the recommended way to initialize context in task code.
   *
   * @example
   * ```typescript
   * const { AutoFlowContext } = require('@autocodeflow/sdk');
   * const ctx = AutoFlowContext.fromEnv();
   *
   * ctx.logger.info(`Task ${ctx.taskId} started`);
   * const date = ctx.getParam('date');
   * ```
   */
  static fromEnv(): AutoFlowContext {
    const params: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k.startsWith('AUTOFLOW_') && v !== undefined) {
        params[k.slice('AUTOFLOW_'.length).toLowerCase()] = v;
      }
    }
    return new AutoFlowContext({
      executionId: process.env.EXECUTION_ID || 'unknown',
      taskId: process.env.TASK_ID || 'unknown',
      taskName: process.env.TASK_NAME || 'unknown',
      params,
    });
  }

  /**
   * Get a task parameter by key, with an optional default value.
   */
  getParam(key: string, defaultValue: unknown = undefined): unknown {
    return key in this.params ? this.params[key] : defaultValue;
  }

  /**
   * Get a configuration value (e.g., from environment variables).
   */
  getConfig(key: string, defaultValue: unknown = undefined): unknown {
    return key in this._config ? this._config[key] : defaultValue;
  }

  /**
   * Set a configuration value.
   */
  setConfig(key: string, value: unknown): void {
    this._config[key] = value;
  }

  /**
   * Create a success result.
   */
  success(data?: unknown): TaskResult {
    return { success: true, data };
  }

  /**
   * Create a failure result.
   */
  failure(error: string): TaskResult {
    return { success: false, error };
  }
}