/**
 * OBS-04: 执行报告/时间线 API 封装（独立文件，避免与 CORE-02 在途的
 * api/tasks.ts 编辑冲突）。消费 admin-api
 * GET /tasks/:taskId/executions/:execId/report 一次性载荷：
 * - execution：task_executions 行（时间戳驱动时间线 + aiAnalysis 展示）；
 * - timeline：created→started→finished 三段（后端已从 DB 时间戳映射）；
 * - report：execution_reports 当日聚合行；null = 当日无报告（正常态，
 *   该表由 MetricsService.generateReport 按"日"聚合写入、读取时懒生成，
 *   单执行视角下缺行属预期，前端降级为「—」骨架而非错误）。
 */
import { client } from './client';

export interface ExecutionReportRow {
  id: number;
  triggerDay: string;
  runningCount: number;
  successCount: number;
  failCount: number;
  timeoutCount: number;
  cancelledCount: number;
  avgDurationMs: number;
  maxDurationMs: number;
  minDurationMs: number;
  updateTime?: string;
  createdAt?: string;
}

export interface ExecutionReportPayload {
  execution: {
    id?: string;
    status?: string;
    triggerType?: string | null;
    executorAddress?: string | null;
    createdAt?: string;
    startTime?: string | null;
    endTime?: string | null;
    duration?: number | null;
    aiAnalysis?: string | null;
    [k: string]: unknown;
  };
  timeline: Array<{
    phase: 'created' | 'started' | 'finished';
    at: string | null;
    detail?: string;
  }>;
  report: ExecutionReportRow | null;
}

export const executionReportsApi = {
  report: (taskId: string, execId: string, signal?: AbortSignal) =>
    signal
      ? client.get(`/tasks/${taskId}/executions/${execId}/report`, { signal }) as Promise<ExecutionReportPayload>
      : client.get(`/tasks/${taskId}/executions/${execId}/report`) as Promise<ExecutionReportPayload>,
};
