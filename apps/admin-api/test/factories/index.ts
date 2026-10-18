/**
 * 测试数据工厂统一导出
 * 
 * 提供可复用的测试数据生成函数，避免在测试中重复构造对象。
 * 
 * @example
 * import { buildUser, buildTask, buildSuccessExecution } from '../factories';
 * 
 * const admin = buildUser({ role: UserRole.ADMIN });
 * const task = buildCronTask({ name: 'my-task' });
 * const execution = buildSuccessExecution({ taskId: task.id });
 */

// User factories
export {
  buildUser,
  buildUsers,
  buildAdminUser,
  buildLockedUser,
  buildTotpUser,
  type UserFactoryOptions,
} from './user.factory';

// Task factories
export {
  buildTask,
  buildTasks,
  buildCronTask,
  buildFixedRateTask,
  buildPausedTask,
  buildPythonTask,
  buildNodeTask,
  buildGitTask,
  buildGlueTask,
  type TaskFactoryOptions,
} from './task.factory';

// TaskExecution factories
export {
  buildTaskExecution,
  buildTaskExecutions,
  buildSuccessExecution,
  buildFailedExecution,
  buildRunningExecution,
  buildPendingExecution,
  buildTimeoutExecution,
  buildCancelledExecution,
  buildRetryChain,
  type TaskExecutionFactoryOptions,
} from './task-execution.factory';

// ApiKey factories
export {
  buildApiKey,
  buildApiKeyWithPlaintext,
  buildApiKeys,
  buildReadonlyApiKey,
  buildTriggerApiKey,
  buildManageApiKey,
  buildExpiredApiKey,
  buildRevokedApiKey,
  buildApiKeyWithScopes,
  buildRecentlyUsedApiKey,
  type ApiKeyFactoryOptions,
} from './api-key.factory';
