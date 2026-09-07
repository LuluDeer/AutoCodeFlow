/**
 * @autoflow/sdk — AutoCodeFlow Node.js TypeScript SDK
 *
 * Quick start:
 * ```ts
 * import { TaskContext } from '@autoflow/sdk';
 *
 * const ctx = TaskContext.fromEnv();
 * ctx.logger.info('Task started', { executionId: ctx.executionId });
 *
 * // ... do work ...
 *
 * const result = ctx.success('All done', { itemsProcessed: 42 });
 * ```
 */

export { TaskContext } from './context';
export type { ReportSuccessOptions, ReportFailureOptions } from './context';
export {
  ERROR_MESSAGE_MAX_LENGTH,
  LOGS_MAX_LENGTH,
} from './context';
export { TaskLogger } from './logger';
export { HttpClient } from './http-client';
export type { TaskEnv, TaskResult, LogEntry, LogLevel } from './types';
