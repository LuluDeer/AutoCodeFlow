import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bull';
import { SchedulerService } from '../scheduler.service';
import { Task, TaskStatus, TaskTriggerType, BlockStrategy, MisfireStrategy } from '../../task/entities/task.entity';
import { TaskExecution, ExecutionStatus } from '../../task/entities/task-execution.entity';
import { DataSource } from 'typeorm';
import { RedisLockService } from '../../../common/services/redis-lock.service';

const mockRepo = () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  save: jest.fn(),
  create: jest.fn(),
  findBy: jest.fn(),
});

const mockQueue = () => ({
  add: jest.fn().mockResolvedValue({ id: 'job-1' }),
});

const mockRedisLock = () => ({
  acquireLock: jest.fn(),
});

const mockDataSource = () => ({
  createQueryBuilder: jest.fn(() => ({
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  })),
});

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: 'task-1',
  name: 'Test Task',
  status: TaskStatus.ACTIVE,
  triggerType: TaskTriggerType.CRON,
  cronExpression: '* * * * *',
  fixedRate: null,
  blockStrategy: BlockStrategy.SERIAL,
  misfireStrategy: MisfireStrategy.IGNORE,
  maxRetry: 3,
  retryDelay: 5,
  priority: 0,
  params: {},
  currentVersion: 1,
  lastTriggerTime: null,
  ...overrides,
} as unknown as Task);

describe('SchedulerService', () => {
  let service: SchedulerService;
  let taskRepo: ReturnType<typeof mockRepo>;
  let execRepo: ReturnType<typeof mockRepo>;
  let queue: ReturnType<typeof mockQueue>;
  let redisLockService: ReturnType<typeof mockRedisLock>;
  let dataSource: ReturnType<typeof mockDataSource>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SchedulerService,
        { provide: getRepositoryToken(Task), useFactory: mockRepo },
        { provide: getRepositoryToken(TaskExecution), useFactory: mockRepo },
        { provide: getQueueToken('task-queue'), useFactory: mockQueue },
        { provide: RedisLockService, useFactory: mockRedisLock },
        { provide: DataSource, useFactory: mockDataSource },
      ],
    }).compile();

    service = module.get<SchedulerService>(SchedulerService);
    taskRepo = module.get(getRepositoryToken(Task));
    execRepo = module.get(getRepositoryToken(TaskExecution));
    queue = module.get(getQueueToken('task-queue'));
    redisLockService = module.get(RedisLockService);
    dataSource = module.get(DataSource);
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.clearAllMocks();
  });

  describe('getStats', () => {
    it('should return healthy stats with zero counts initially', () => {
      const stats = service.getStats();
      expect(stats.healthy).toBe(true);
      expect(stats.activeTimers).toBe(0);
      expect(stats.activeCronTasks).toBe(0);
      expect(stats.runningTaskCount).toBe(0);
      expect(stats.totalScheduledTasks).toBe(0);
      expect(stats.uptime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('stop', () => {
    it('should not throw when stopping a task that was never scheduled', () => {
      expect(() => service.stop('nonexistent')).not.toThrow();
    });
  });

  describe('onModuleDestroy', () => {
    it('should not throw when no timers or cron tasks are active', () => {
      expect(() => service.onModuleDestroy()).not.toThrow();
    });
  });

  describe('checkMisfires', () => {
    it('should skip tasks without lastTriggerTime', async () => {
      const task = makeTask({ lastTriggerTime: null });
      taskRepo.find.mockResolvedValue([task]);
      await expect(service.checkMisfires()).resolves.not.toThrow();
    });

    it('should fire once for FIRE_ONCE misfire strategy', async () => {
      const oldTime = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
      const task = makeTask({
        triggerType: TaskTriggerType.FIXED_RATE,
        fixedRate: 60,
        misfireStrategy: MisfireStrategy.FIRE_ONCE,
        lastTriggerTime: oldTime,
      });
      taskRepo.find.mockResolvedValue([task]);

      const lock = { release: jest.fn().mockResolvedValue(undefined) };
      redisLockService.acquireLock.mockResolvedValue(lock);
      taskRepo.findOne.mockResolvedValue(task);
      execRepo.findOne.mockResolvedValue(null);
      const exec = { id: 'exec-1', status: ExecutionStatus.PENDING } as TaskExecution;
      execRepo.create.mockReturnValue(exec);
      execRepo.save.mockResolvedValue(exec);

      await service.checkMisfires();
      expect(queue.add).toHaveBeenCalled();
    });

    it('should ignore misfire when strategy is IGNORE', async () => {
      const oldTime = new Date(Date.now() - 10 * 60 * 1000);
      const task = makeTask({
        triggerType: TaskTriggerType.FIXED_RATE,
        fixedRate: 60,
        misfireStrategy: MisfireStrategy.IGNORE,
        lastTriggerTime: oldTime,
      });
      taskRepo.find.mockResolvedValue([task]);
      await service.checkMisfires();
      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  describe('enqueue', () => {
    it('should return null when lock cannot be acquired', async () => {
      redisLockService.acquireLock.mockResolvedValue(null);
      const task = makeTask();
      const result = await service.enqueue(task, 'manual');
      expect(result).toBeNull();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('should return null when task is no longer active', async () => {
      const lock = { release: jest.fn().mockResolvedValue(undefined) };
      redisLockService.acquireLock.mockResolvedValue(lock);
      taskRepo.findOne.mockResolvedValue(null);
      const task = makeTask();
      const result = await service.enqueue(task, 'manual');
      expect(result).toBeNull();
      expect(lock.release).toHaveBeenCalled();
    });

    it('should enqueue task and return execution when all checks pass', async () => {
      const lock = { release: jest.fn().mockResolvedValue(undefined) };
      redisLockService.acquireLock.mockResolvedValue(lock);
      const task = makeTask({ blockStrategy: BlockStrategy.SERIAL });
      taskRepo.findOne.mockResolvedValue(task);
      const exec = { id: 'exec-1', status: ExecutionStatus.PENDING } as TaskExecution;
      execRepo.create.mockReturnValue(exec);
      execRepo.save.mockResolvedValue(exec);

      const result = await service.enqueue(task, 'manual');
      expect(result).toEqual(exec);
      expect(queue.add).toHaveBeenCalledWith(
        'execute',
        { executionId: 'exec-1', task },
        expect.any(Object),
      );
      expect(lock.release).toHaveBeenCalled();
    });

    it('should skip and return null when blockStrategy=DISCARD and task is running', async () => {
      const lock = { release: jest.fn().mockResolvedValue(undefined) };
      redisLockService.acquireLock.mockResolvedValue(lock);
      const task = makeTask({ blockStrategy: BlockStrategy.DISCARD });
      taskRepo.findOne.mockResolvedValue(task);
      const runningExec = { id: 'running-1', status: ExecutionStatus.RUNNING, executorAddress: 'host:3002' } as TaskExecution;
      execRepo.findOne.mockResolvedValue(runningExec);

      const result = await service.enqueue(task, 'cron');
      expect(result).toBeNull();
      expect(queue.add).not.toHaveBeenCalled();
      expect(dataSource.createQueryBuilder).not.toHaveBeenCalled();
      expect(lock.release).toHaveBeenCalled();
    });

    it('should cancel running execution when blockStrategy=COVER_EARLY', async () => {
      const lock = { release: jest.fn().mockResolvedValue(undefined) };
      redisLockService.acquireLock.mockResolvedValue(lock);
      const task = makeTask({ blockStrategy: BlockStrategy.COVER_EARLY });
      taskRepo.findOne.mockResolvedValue(task);
      const runningExec = {
        id: 'running-1',
        status: ExecutionStatus.RUNNING,
        executorAddress: 'host:3002',
        errorMessage: null,
        endTime: null,
      } as unknown as TaskExecution;
      execRepo.findOne.mockResolvedValue(runningExec);
      execRepo.save.mockResolvedValue(runningExec);
      const newExec = { id: 'exec-2' } as TaskExecution;
      execRepo.create.mockReturnValue(newExec);
      execRepo.save.mockResolvedValueOnce(runningExec).mockResolvedValueOnce(newExec);

      await service.enqueue(task, 'cron');
      expect(runningExec.status).toBe(ExecutionStatus.CANCELLED);
      expect(dataSource.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalled();
    });
  });

  describe('reload', () => {
    it('should schedule a cron task for an active CRON task', async () => {
      const task = makeTask({
        triggerType: TaskTriggerType.CRON,
        cronExpression: '0 * * * *',
      });
      taskRepo.find.mockResolvedValue([task]);
      await service.reload();
      const stats = service.getStats();
      expect(stats.activeCronTasks).toBe(1);
    });

    it('should skip cron task with invalid expression', async () => {
      const task = makeTask({
        triggerType: TaskTriggerType.CRON,
        cronExpression: 'not-valid-cron',
      });
      taskRepo.find.mockResolvedValue([task]);
      await service.reload();
      const stats = service.getStats();
      expect(stats.activeCronTasks).toBe(0);
    });

    it('should schedule a fixed_rate task', async () => {
      const task = makeTask({
        triggerType: TaskTriggerType.FIXED_RATE,
        fixedRate: 300,
        cronExpression: null,
      });
      taskRepo.find.mockResolvedValue([task]);
      await service.reload();
      const stats = service.getStats();
      expect(stats.activeTimers).toBe(1);
    });

    it('should stop removed tasks on reload', async () => {
      // First reload registers the task
      const task = makeTask({ triggerType: TaskTriggerType.CRON, cronExpression: '0 * * * *' });
      taskRepo.find.mockResolvedValue([task]);
      await service.reload();
      expect(service.getStats().activeCronTasks).toBe(1);

      // Second reload with empty list should stop it
      taskRepo.find.mockResolvedValue([]);
      await service.reload();
      expect(service.getStats().activeCronTasks).toBe(0);
    });
  });

  describe('recoverStaleExecutions', () => {
    it('should mark running execution as failed using default 1h threshold when task has no timeout', async () => {
      const staleExec = {
        id: 'exec-stale',
        taskId: 'task-1',
        status: ExecutionStatus.RUNNING,
        startTime: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
        executorAddress: 'host:3002',
        errorMessage: null,
        endTime: null,
      };
      execRepo.find.mockResolvedValue([staleExec]);
      taskRepo.findBy.mockResolvedValue([]);
      execRepo.save.mockResolvedValue(staleExec);

      await service.recoverStaleExecutions();

      expect(execRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: ExecutionStatus.FAILED }),
      );
      expect(staleExec.errorMessage).toContain('recovered');
      expect(dataSource.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('should respect task-level timeout when marking as timed out', async () => {
      const staleExec = {
        id: 'exec-timeout',
        taskId: 'task-2',
        status: ExecutionStatus.RUNNING,
        // 10 minutes ago — beyond task timeout of 5 min
        startTime: new Date(Date.now() - 10 * 60 * 1000),
        executorAddress: 'host:3002',
        errorMessage: null,
        endTime: null,
      };
      execRepo.find.mockResolvedValue([staleExec]);
      taskRepo.findBy.mockResolvedValue([makeTask({ id: 'task-2', timeout: 300 })]);
      execRepo.save.mockResolvedValue(staleExec);

      await service.recoverStaleExecutions();

      expect(execRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: ExecutionStatus.FAILED }),
      );
      expect(staleExec.errorMessage).toContain('timed out');
      expect(dataSource.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('should NOT mark execution as stale when within task timeout', async () => {
      const freshExec = {
        id: 'exec-fresh',
        taskId: 'task-3',
        status: ExecutionStatus.RUNNING,
        // 2 minutes ago — within task timeout of 10 min
        startTime: new Date(Date.now() - 2 * 60 * 1000),
        executorAddress: 'host:3002',
        errorMessage: null,
        endTime: null,
      };
      execRepo.find.mockResolvedValue([freshExec]);
      taskRepo.findBy.mockResolvedValue([makeTask({ id: 'task-3', timeout: 600 })]);

      await service.recoverStaleExecutions();

      expect(execRepo.save).not.toHaveBeenCalled();
      expect(dataSource.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('should do nothing when no running executions exist', async () => {
      execRepo.find.mockResolvedValue([]);
      await service.recoverStaleExecutions();
      expect(execRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('scheduleOne', () => {
    it('should stop existing schedule and register new cron task', async () => {
      const task = makeTask({ triggerType: TaskTriggerType.CRON, cronExpression: '0 * * * *' });
      await service.scheduleOne(task);
      const stats = service.getStats();
      expect(stats.activeCronTasks).toBe(1);
    });

    it('should stop existing schedule and register fixed_rate timer', async () => {
      const task = makeTask({
        triggerType: TaskTriggerType.FIXED_RATE,
        fixedRate: 60,
        cronExpression: null,
      });
      await service.scheduleOne(task);
      const stats = service.getStats();
      expect(stats.activeTimers).toBe(1);
    });

    it('should not register cron task with invalid expression', async () => {
      const task = makeTask({ triggerType: TaskTriggerType.CRON, cronExpression: 'bad-expr' });
      await service.scheduleOne(task);
      expect(service.getStats().activeCronTasks).toBe(0);
    });
  });
});
