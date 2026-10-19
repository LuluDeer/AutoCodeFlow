/**
 * @autocodeflow/sdk — AutoCodeFlow Node.js TypeScript SDK
 *
 * Quick start:
 * ```ts
 * import { TaskContext } from '@autocodeflow/sdk';
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
// R31-E1: 稳定错误码透传——调用方可按码分支，不必匹配中文兜底文案。
// `HttpClientError` 是类型（axios 错误被就地标记），`getErrorCode` /
// `getErrorParams` 是永不抛的读取帮手，`attachErrorCode` 供自定义拦截器复用。
export { getErrorCode, getErrorParams, attachErrorCode } from './http-client';
export type { HttpClientError } from './http-client';
export type { TaskEnv, TaskResult, LogEntry, LogLevel } from './types';
