import axios, { AxiosInstance } from 'axios';

/**
 * Options for registering an executor with the admin API.
 */
export interface RegisterExecutorOptions {
  name: string;
  address: string;
  runtimes: string[];
  token?: string;
}

/**
 * Response returned by the executor registration endpoint.
 */
export interface RegisterExecutorResponse {
  executorId: string;
  token: string;
}

/**
 * Options for sending a heartbeat.
 */
export interface HeartbeatOptions {
  executorId: string;
  status?: 'idle' | 'busy';
  activeJobs?: number;
}

/**
 * Options for triggering a task execution.
 */
export interface TriggerTaskOptions {
  taskId: string;
  params?: Record<string, unknown>;
  executorId?: string;
  runtime?: string;
}

/**
 * Response from the trigger-task endpoint.
 */
export interface TriggerTaskResponse {
  executionId: string;
  status: string;
}

/**
 * AutoFlowAdminClient — communicates with the AutoCodeFlow admin API.
 *
 * Provides executor registration, heartbeat, and task-trigger operations.
 *
 * @example
 * ```typescript
 * const { AutoFlowAdminClient } = require('@autocodeflow/sdk');
 *
 * const client = new AutoFlowAdminClient({
 *   baseURL: 'http://admin-api:8000',
 *   apiKey: process.env.ADMIN_API_KEY,
 * });
 *
 * // Register this executor
 * const { executorId, token } = await client.registerExecutor({
 *   name: 'my-executor',
 *   address: 'http://my-executor:8080',
 *   runtimes: ['python', 'node'],
 * });
 *
 * // Send heartbeat
 * await client.heartbeat({ executorId, status: 'idle' });
 *
 * // Trigger a task
 * const { executionId } = await client.triggerTask({
 *   taskId: 'daily-report',
 *   params: { date: '2024-01-01' },
 * });
 * ```
 */
export class AutoFlowAdminClient {
  private http: AxiosInstance;

  constructor(options: { baseURL: string; apiKey?: string; timeoutMs?: number }) {
    this.http = axios.create({
      baseURL: options.baseURL,
      timeout: options.timeoutMs ?? 10_000,
      headers: options.apiKey
        ? { Authorization: `Bearer ${options.apiKey}` }
        : {},
    });
  }

  /**
   * Register an executor with the admin API.
   * Returns the assigned executorId and a shared Bearer token.
   */
  async registerExecutor(
    opts: RegisterExecutorOptions,
  ): Promise<RegisterExecutorResponse> {
    const res = await this.http.post<RegisterExecutorResponse>(
      '/api/executors/register',
      opts,
    );
    return res.data;
  }

  /**
   * Send a heartbeat to keep the executor record alive.
   */
  async heartbeat(opts: HeartbeatOptions): Promise<void> {
    await this.http.post(`/api/executors/${opts.executorId}/heartbeat`, {
      status: opts.status ?? 'idle',
      activeJobs: opts.activeJobs ?? 0,
    });
  }

  /**
   * Trigger a task execution via the admin API.
   */
  async triggerTask(
    opts: TriggerTaskOptions,
  ): Promise<TriggerTaskResponse> {
    const res = await this.http.post<TriggerTaskResponse>(
      '/api/tasks/trigger',
      opts,
    );
    return res.data;
  }

  /**
   * Get the status of an execution by ID.
   */
  async getExecutionStatus(
    executionId: string,
  ): Promise<{ executionId: string; status: string; result?: unknown }> {
    const res = await this.http.get<{
      executionId: string;
      status: string;
      result?: unknown;
    }>(`/api/executions/${executionId}`);
    return res.data;
  }
}
