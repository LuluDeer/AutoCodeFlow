import { faker } from '@faker-js/faker';
import {
  TaskExecution,
  ExecutionStatus,
  ExecutionFailureReason,
} from '../../src/modules/task/entities/task-execution.entity';

/**
 * 测试数据工厂：TaskExecution 实体
 * 
 * 提供可复用的任务执行测试数据生成函数，支持部分覆盖默认值。
 */

export interface TaskExecutionFactoryOptions {
  id?: string;
  taskId?: string;
  taskName?: string;
  status?: ExecutionStatus;
  executorAddress?: string | null;
  executorId?: string | null;
  logs?: string;
  logStorage?: string | null;
  logObjectKey?: string | null;
  result?: Record<string, any>;
  params?: Record<string, any>;
  startTime?: Date;
  endTime?: Date;
  duration?: number;
  retryCount?: number;
  errorMessage?: string;
  failureReason?: ExecutionFailureReason | null;
  exitCode?: number | null;
  aiAnalysis?: string;
  taskVersion?: string | null;
  traceId?: string | null;
  resolvedPackageUrl?: string | null;
  resolvedPackageVersion?: string | null;
  triggerType?: string;
  mutexGroupId?: string | null;
  createdAt?: Date;
}

/**
 * 构建单个 TaskExecution 对象（未保存到数据库）
 * 
 * @param overrides - 部分覆盖默认生成值
 * @returns 完整的 TaskExecution 对象
 * 
 * @example
 * const successExec = buildTaskExecution({ status: ExecutionStatus.SUCCESS });
 * const failedExec = buildTaskExecution({ status: ExecutionStatus.FAILED, failureReason: ExecutionFailureReason.SCRIPT_ERROR });
 */
export function buildTaskExecution(overrides: TaskExecutionFactoryOptions = {}): TaskExecution {
  const execution = new TaskExecution();
  
  execution.id = overrides.id ?? faker.string.uuid();
  execution.taskId = overrides.taskId ?? faker.string.uuid();
  execution.taskName = overrides.taskName ?? `task-${faker.word.noun()}`.toLowerCase();
  execution.status = overrides.status ?? ExecutionStatus.SUCCESS;
  execution.executorAddress = overrides.executorAddress !== undefined 
    ? overrides.executorAddress 
    : `http://${faker.internet.ip()}:${faker.number.int({ min: 3000, max: 9999 })}`;
  execution.executorId = overrides.executorId !== undefined ? overrides.executorId : faker.string.uuid();
  execution.logs = overrides.logs ?? faker.lorem.paragraphs(3);
  execution.logStorage = overrides.logStorage ?? 'db';
  execution.logObjectKey = overrides.logObjectKey !== undefined ? overrides.logObjectKey : null;
  execution.result = overrides.result ?? {};
  execution.params = overrides.params ?? {};
  execution.startTime = overrides.startTime ?? faker.date.recent({ days: 1 });
  execution.endTime = overrides.endTime ?? faker.date.recent({ days: 1 });
  execution.duration = overrides.duration ?? faker.number.int({ min: 100, max: 60000 });
  execution.retryCount = overrides.retryCount ?? 0;
  execution.errorMessage = overrides.errorMessage ?? '';
  execution.failureReason = overrides.failureReason !== undefined ? overrides.failureReason : null;
  execution.exitCode = overrides.exitCode !== undefined ? overrides.exitCode : null;
  execution.aiAnalysis = overrides.aiAnalysis ?? '';
  execution.taskVersion = overrides.taskVersion ?? '1.0.0';
  execution.traceId = overrides.traceId !== undefined ? overrides.traceId : faker.string.uuid();
  execution.resolvedPackageUrl = overrides.resolvedPackageUrl !== undefined ? overrides.resolvedPackageUrl : null;
  execution.resolvedPackageVersion = overrides.resolvedPackageVersion !== undefined ? overrides.resolvedPackageVersion : null;
  execution.triggerType = overrides.triggerType ?? 'manual';
  execution.mutexGroupId = overrides.mutexGroupId !== undefined ? overrides.mutexGroupId : null;
  execution.createdAt = overrides.createdAt ?? faker.date.recent({ days: 1 });

  return execution;
}

/**
 * 批量构建 TaskExecution 对象
 * 
 * @param count - 生成数量
 * @param overrides - 应用到所有对象的覆盖值
 * @returns TaskExecution 对象数组
 * 
 * @example
 * const executions = buildTaskExecutions(5);
 * const runningExecs = buildTaskExecutions(3, { status: ExecutionStatus.RUNNING });
 */
export function buildTaskExecutions(
  count: number,
  overrides: TaskExecutionFactoryOptions = {},
): TaskExecution[] {
  return Array.from({ length: count }, () => buildTaskExecution(overrides));
}

/**
 * 快捷函数：构建成功执行
 */
export function buildSuccessExecution(overrides: TaskExecutionFactoryOptions = {}): TaskExecution {
  const startTime = overrides.startTime ?? faker.date.recent({ days: 1 });
  const duration = faker.number.int({ min: 1000, max: 30000 });
  const endTime = new Date(startTime.getTime() + duration);
  
  return buildTaskExecution({
    status: ExecutionStatus.SUCCESS,
    exitCode: 0,
    startTime,
    endTime,
    duration,
    errorMessage: '',
    failureReason: null,
    ...overrides,
  });
}

/**
 * 快捷函数：构建失败执行
 */
export function buildFailedExecution(overrides: TaskExecutionFactoryOptions = {}): TaskExecution {
  const startTime = overrides.startTime ?? faker.date.recent({ days: 1 });
  const duration = faker.number.int({ min: 100, max: 5000 });
  const endTime = new Date(startTime.getTime() + duration);
  
  return buildTaskExecution({
    status: ExecutionStatus.FAILED,
    failureReason: ExecutionFailureReason.SCRIPT_ERROR,
    errorMessage: `Error: ${faker.lorem.sentence()}`,
    exitCode: 1,
    startTime,
    endTime,
    duration,
    ...overrides,
  });
}

/**
 * 快捷函数：构建运行中执行
 */
export function buildRunningExecution(overrides: TaskExecutionFactoryOptions = {}): TaskExecution {
  return buildTaskExecution({
    status: ExecutionStatus.RUNNING,
    startTime: faker.date.recent({ days: 1 }),
    endTime: null,
    duration: null,
    exitCode: null,
    ...overrides,
  });
}

/**
 * 快捷函数：构建待执行状态
 */
export function buildPendingExecution(overrides: TaskExecutionFactoryOptions = {}): TaskExecution {
  return buildTaskExecution({
    status: ExecutionStatus.PENDING,
    startTime: null,
    endTime: null,
    duration: null,
    exitCode: null,
    ...overrides,
  });
}

/**
 * 快捷函数：构建超时执行
 */
export function buildTimeoutExecution(overrides: TaskExecutionFactoryOptions = {}): TaskExecution {
  const startTime = overrides.startTime ?? faker.date.recent({ days: 1 });
  const duration = faker.number.int({ min: 300000, max: 600000 });
  const endTime = new Date(startTime.getTime() + duration);
  
  return buildTaskExecution({
    status: ExecutionStatus.TIMEOUT,
    failureReason: ExecutionFailureReason.TIMEOUT,
    errorMessage: 'Execution timeout',
    exitCode: null,
    startTime,
    endTime,
    duration,
    ...overrides,
  });
}

/**
 * 快捷函数：构建已取消执行
 */
export function buildCancelledExecution(overrides: TaskExecutionFactoryOptions = {}): TaskExecution {
  const startTime = overrides.startTime ?? faker.date.recent({ days: 1 });
  const duration = faker.number.int({ min: 100, max: 5000 });
  const endTime = new Date(startTime.getTime() + duration);
  
  return buildTaskExecution({
    status: ExecutionStatus.CANCELLED,
    startTime,
    endTime,
    duration,
    exitCode: null,
    ...overrides,
  });
}

/**
 * 快捷函数：构建一组重试链执行（同一任务的多次重试）
 */
export function buildRetryChain(
  taskId: string,
  count: number,
  finalStatus: ExecutionStatus = ExecutionStatus.SUCCESS,
): TaskExecution[] {
  const executions: TaskExecution[] = [];
  const taskName = `task-${faker.word.noun()}`;
  
  for (let i = 0; i < count; i++) {
    const isLastAttempt = i === count - 1;
    const status = isLastAttempt ? finalStatus : ExecutionStatus.FAILED;
    
    executions.push(
      buildTaskExecution({
        taskId,
        taskName,
        status,
        retryCount: i,
        failureReason: isLastAttempt && finalStatus === ExecutionStatus.SUCCESS 
          ? null 
          : ExecutionFailureReason.SCRIPT_ERROR,
        exitCode: isLastAttempt && finalStatus === ExecutionStatus.SUCCESS ? 0 : 1,
      }),
    );
  }
  
  return executions;
}
