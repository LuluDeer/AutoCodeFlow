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
// R177-A1（轴 1 错误面）：**错误类型必须从包入口可达**。此前
// CircuitBreakerOpenError 只在 http-client.ts 里 export，index.ts 没转出，
// 消费方 `import { CircuitBreakerOpenError } from '@autocodeflow/sdk'` 直接
// 编译失败——catch 端只能靠 err.name 字符串猜，instanceof 永远为 false。
// 同理新增 HttpClientDisabledError：凭据缺失 = 配置错，必须可与网络错 / 服务端
// 4xx 分类（python SDK 的 CallbackDisabledError 早就这么做了）。
export {
  CircuitBreakerOpenError,
  HttpClient,
  HttpClientDisabledError,
} from './http-client';
// R31-E1: 稳定错误码透传——调用方可按码分支，不必匹配中文兜底文案。
// `HttpClientError` 是类型（axios 错误被就地标记），`getErrorCode` /
// `getErrorParams` 是永不抛的读取帮手，`attachErrorCode` 供自定义拦截器复用。
export { getErrorCode, getErrorParams, attachErrorCode } from './http-client';
export type { HttpClientError } from './http-client';
export type { TaskEnv, TaskResult, LogEntry, LogLevel } from './types';
