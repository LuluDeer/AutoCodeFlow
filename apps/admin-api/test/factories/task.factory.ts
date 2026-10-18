import { faker } from '@faker-js/faker';
import {
  Task,
  TaskStatus,
  TaskTriggerType,
  TaskRuntime,
  BlockStrategy,
  MisfireStrategy,
  TaskPriority,
  ExecuteMode,
} from '../../src/modules/task/entities/task.entity';

/**
 * 测试数据工厂：Task 实体
 * 
 * 提供可复用的任务测试数据生成函数，支持部分覆盖默认值。
 */

export interface TaskFactoryOptions {
  id?: string;
  name?: string;
  description?: string;
  status?: TaskStatus;
  triggerType?: TaskTriggerType;
  cronExpression?: string;
  timezone?: string;
  fixedRate?: number;
  runtime?: TaskRuntime;
  runtimeVersion?: string;
  dependencies?: Record<string, string>;
  entrypoint?: string;
  requirements?: string[] | null;
  gitRepo?: string;
  gitBranch?: string;
  gitCommit?: string;
  currentVersion?: string;
  timeout?: number;
  maxRetry?: number;
  retryDelay?: number;
  retryableErrors?: string[];
  blockStrategy?: BlockStrategy;
  misfireStrategy?: MisfireStrategy;
  priority?: TaskPriority;
  executeMode?: ExecuteMode;
  projectId?: string | null;
  applicationId?: string | null;
  glueSource?: string | null;
  lastTriggerTime?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * 构建单个 Task 对象（未保存到数据库）
 * 
 * @param overrides - 部分覆盖默认生成值
 * @returns 完整的 Task 对象
 * 
 * @example
 * const cronTask = buildTask({ triggerType: TaskTriggerType.CRON, cronExpression: '0 0 * * *' });
 * const pythonTask = buildTask({ runtime: TaskRuntime.PYTHON, runtimeVersion: '3.11' });
 */
export function buildTask(overrides: TaskFactoryOptions = {}): Task {
  const task = new Task();
  
  task.id = overrides.id ?? faker.string.uuid();
  task.name = overrides.name ?? `task-${faker.word.adjective()}-${faker.word.noun()}`.toLowerCase();
  task.description = overrides.description ?? faker.lorem.sentence();
  task.status = overrides.status ?? TaskStatus.ACTIVE;
  task.triggerType = overrides.triggerType ?? TaskTriggerType.MANUAL;
  task.cronExpression = overrides.cronExpression !== undefined ? overrides.cronExpression : null;
  task.timezone = overrides.timezone ?? 'Asia/Shanghai';
  task.fixedRate = overrides.fixedRate !== undefined ? overrides.fixedRate : null;
  task.runtime = overrides.runtime ?? TaskRuntime.PYTHON;
  task.runtimeVersion = overrides.runtimeVersion ?? '3.11';
  task.dependencies = overrides.dependencies ?? {};
  task.entrypoint = overrides.entrypoint !== undefined ? overrides.entrypoint : 'main.py';
  task.requirements = overrides.requirements !== undefined ? overrides.requirements : null;
  task.gitRepo = overrides.gitRepo !== undefined ? overrides.gitRepo : null;
  task.gitBranch = overrides.gitBranch ?? 'main';
  task.gitCommit = overrides.gitCommit !== undefined ? overrides.gitCommit : null;
  task.currentVersion = overrides.currentVersion ?? '1.0.0';
  task.timeout = overrides.timeout ?? 300;
  task.maxRetry = overrides.maxRetry ?? 3;
  task.retryDelay = overrides.retryDelay ?? 0;
  task.retryableErrors = overrides.retryableErrors ?? [];
  task.blockStrategy = overrides.blockStrategy ?? BlockStrategy.SERIAL;
  task.misfireStrategy = overrides.misfireStrategy ?? MisfireStrategy.IGNORE;
  task.priority = overrides.priority ?? TaskPriority.NORMAL;
  task.executeMode = overrides.executeMode ?? ExecuteMode.SINGLE;
  task.projectId = overrides.projectId !== undefined ? overrides.projectId : null;
  task.applicationId = overrides.applicationId !== undefined ? overrides.applicationId : null;
  task.glueSource = overrides.glueSource !== undefined ? overrides.glueSource : null;
  task.lastTriggerTime = overrides.lastTriggerTime !== undefined ? overrides.lastTriggerTime : null;
  task.createdAt = overrides.createdAt ?? faker.date.past({ years: 1 });
  task.updatedAt = overrides.updatedAt ?? faker.date.recent({ days: 30 });

  return task;
}

/**
 * 批量构建 Task 对象
 * 
 * @param count - 生成数量
 * @param overrides - 应用到所有对象的覆盖值
 * @returns Task 对象数组
 * 
 * @example
 * const tasks = buildTasks(5);
 * const cronTasks = buildTasks(3, { triggerType: TaskTriggerType.CRON });
 */
export function buildTasks(count: number, overrides: TaskFactoryOptions = {}): Task[] {
  return Array.from({ length: count }, () => buildTask(overrides));
}

/**
 * 快捷函数：构建 CRON 调度任务
 */
export function buildCronTask(overrides: TaskFactoryOptions = {}): Task {
  return buildTask({
    triggerType: TaskTriggerType.CRON,
    cronExpression: '0 0 * * *',
    ...overrides,
  });
}

/**
 * 快捷函数：构建固定频率任务
 */
export function buildFixedRateTask(overrides: TaskFactoryOptions = {}): Task {
  return buildTask({
    triggerType: TaskTriggerType.FIXED_RATE,
    fixedRate: 60000, // 60秒
    ...overrides,
  });
}

/**
 * 快捷函数：构建已暂停的任务
 */
export function buildPausedTask(overrides: TaskFactoryOptions = {}): Task {
  return buildTask({
    status: TaskStatus.PAUSED,
    ...overrides,
  });
}

/**
 * 快捷函数：构建 Python 任务
 */
export function buildPythonTask(overrides: TaskFactoryOptions = {}): Task {
  return buildTask({
    runtime: TaskRuntime.PYTHON,
    runtimeVersion: '3.11',
    entrypoint: 'main.py',
    requirements: ['requests>=2.31.0', 'pandas>=2.0.0'],
    ...overrides,
  });
}

/**
 * 快捷函数：构建 Node 任务
 */
export function buildNodeTask(overrides: TaskFactoryOptions = {}): Task {
  return buildTask({
    runtime: TaskRuntime.NODE,
    runtimeVersion: '20',
    entrypoint: 'index.js',
    ...overrides,
  });
}

/**
 * 快捷函数：构建 Git 源任务
 */
export function buildGitTask(overrides: TaskFactoryOptions = {}): Task {
  return buildTask({
    gitRepo: faker.internet.url() + '/repo.git',
    gitBranch: 'main',
    gitCommit: faker.git.commitSha(),
    ...overrides,
  });
}

/**
 * 快捷函数：构建 Glue 脚本任务
 */
export function buildGlueTask(overrides: TaskFactoryOptions = {}): Task {
  return buildTask({
    ...overrides,
    glueSource: overrides.glueSource ?? `print("Hello from glue script")`,
    entrypoint: overrides.entrypoint !== undefined ? overrides.entrypoint : null,
  });
}
