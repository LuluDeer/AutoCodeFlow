import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { SchedulerService } from '../scheduler.service';
import { Task, TaskStatus, TaskTriggerType, BlockStrategy, MisfireStrategy } from '../../task/entities/task.entity';
import { TaskExecution, ExecutionStatus, ExecutionFailureReason } from '../../task/entities/task-execution.entity';
import { DataSource } from 'typeorm';
import * as nodeCron from 'node-cron';
import { RedisLockService } from '../../../common/services/redis-lock.service';

const mockRepo = () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  save: jest.fn(),
  create: jest.fn(),
  findBy: jest.fn(),
  update: jest.fn().mockResolvedValue({ affected: 1 }),
  createQueryBuilder: jest.fn(),
});

const mockQueue = () => ({
  add: jest.fn().mockResolvedValue({ id: 'job-1' }),
});

const mockRedisLock = () => ({
  acquireLock: jest.fn(),
  extendLock: jest.fn().mockResolvedValue(true),
  releaseLock: jest.fn().mockResolvedValue(true),
});

const mockDataSource = () => ({
  createQueryBuilder: jest.fn(() => ({
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  })),
  transaction: jest.fn(),
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

/** 构造 UPDATE ... RETURNING 风格的 QueryBuilder mock */
const makeUpdateQb = (result: { affected: number; raw?: unknown[] }) => {
  const qb: Record<string, jest.Mock> = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    returning: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue(result),
  };
  return qb;
};

describe('SchedulerService', () => {
  let service: SchedulerService;
  let taskRepo: ReturnType<typeof mockRepo>;
  let execRepo: ReturnType<typeof mockRepo>;
  let queue: ReturnType<typeof mockQueue>;
  let redisLockService: ReturnType<typeof mockRedisLock>;
  let dataSource: ReturnType<typeof mockDataSource>;

  const makeLeader = async () => {
    redisLockService.acquireLock.mockResolvedValueOnce({
      key: 'scheduler:leader',
      lockId: 'leader-lock-id',
      ttlMs: 30000,
      released: false,
      release: jest.fn().mockResolvedValue(true),
    });
    await service.initLeaderElection();
    expect(service.getStats().isLeader).toBe(true);
  };

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

  describe('leader election (TASK-006)', () => {
    it('should become leader when the leader lock is acquired', async () => {
      await makeLeader();
      expect(service.getStats().isLeader).toBe(true);
      expect(redisLockService.acquireLock).toHaveBeenCalledWith(
        'scheduler:leader',
        expect.any(Number),
      );
    });

    it('stays follower when the leader lock is held by another instance', async () => {
      redisLockService.acquireLock.mockResolvedValue(null);
      await service.initLeaderElection();
      expect(service.getStats().isLeader).toBe(false);
    });

    it('degrades to leader (fail-open) when Redis throws, then re-contends later', async () => {
      redisLockService.acquireLock.mockRejectedValue(
        new Error('Redis connection down'),
      );
      await service.initLeaderElection();
      // 降级行为：调度不停摆，按 Leader 运行
      expect(service.getStats().isLeader).toBe(true);

      // Redis 恢复且锁被其他实例持有 → 让位
      redisLockService.acquireLock.mockResolvedValue(null);
      await service.initLeaderElection();
      expect(service.getStats().isLeader).toBe(false);
    });

    it('non-leader skips scan ticks: reload / checkMisfires / recoverStaleExecutions', async () => {
      redisLockService.acquireLock.mockResolvedValue(null);
      await service.initLeaderElection();

      await service.reload();
      await service.checkMisfires();
      await service.recoverStaleExecutions();

      expect(taskRepo.find).not.toHaveBeenCalled();
      expect(execRepo.find).not.toHaveBeenCalled();
      expect(service.getStats().activeTimers).toBe(0);
      expect(service.getStats().activeCronTasks).toBe(0);
    });

    it('non-leader skips scheduleOne registration but leader registers', async () => {
      redisLockService.acquireLock.mockResolvedValue(null);
      await service.initLeaderElection();
      const task = makeTask({ triggerType: TaskTriggerType.CRON, cronExpression: '0 * * * *' });
      await service.scheduleOne(task);
      expect(service.getStats().activeCronTasks).toBe(0);

      await makeLeader();
      await service.scheduleOne(task);
      expect(service.getStats().activeCronTasks).toBe(1);
    });

    it('demotes when the leader lease is lost (extendLock returns false)', async () => {
      await makeLeader();
      const task = makeTask({ triggerType: TaskTriggerType.FIXED_RATE, fixedRate: 60, cronExpression: null });
      await service.scheduleOne(task);
      expect(service.getStats().activeTimers).toBe(1);

      // 租约被其它实例接管 → demote 后清空本地调度并重新参与竞选
      redisLockService.extendLock.mockResolvedValue(false);
      await (service as any).verifyLeadership();

      expect(service.getStats().isLeader).toBe(false);
      expect(service.getStats().activeTimers).toBe(0);
    });

    it('keeps leadership when the lease check hits a redis hiccup (extendLock throws)', async () => {
      await makeLeader();
      redisLockService.extendLock.mockRejectedValue(new Error('timeout'));
      await (service as any).verifyLeadership();
      expect(service.getStats().isLeader).toBe(true);
    });

    it('only one instance wins the leader lock when two contend (redis-backed)', async () => {
      // 模拟两个实例串行竞选：Redis SET NX 保证只有一个 OK
      const results: boolean[] = [];
      redisLockService.acquireLock.mockImplementation(async () => {
        // 第一次调用成功，后续全部失败（锁已被占用）
        if (results.length === 0) {
          results.push(true);
          return {
            key: 'scheduler:leader',
            lockId: 'instance-a',
            ttlMs: 30000,
            released: false,
            release: jest.fn().mockResolvedValue(true),
          };
        }
        results.push(false);
        return null;
      });

      const instanceA = service;
      await instanceA.initLeaderElection();

      const moduleB: TestingModule = await Test.createTestingModule({
        providers: [
          SchedulerService,
          { provide: getRepositoryToken(Task), useFactory: mockRepo },
          { provide: getRepositoryToken(TaskExecution), useFactory: mockRepo },
          { provide: getQueueToken('task-queue'), useFactory: mockQueue },
          { provide: RedisLockService, useFactory: mockRedisLock },
          { provide: DataSource, useFactory: mockDataSource },
        ],
      }).compile();
      const instanceB = moduleB.get<SchedulerService>(SchedulerService);
      try {
        await instanceB.initLeaderElection();

        expect(instanceA.getStats().isLeader).toBe(true);
        expect(instanceB.getStats().isLeader).toBe(false);

        // 只有 Leader 注册调度
        const task = makeTask({ triggerType: TaskTriggerType.CRON, cronExpression: '0 * * * *' });
        taskRepo.find.mockResolvedValue([task]);
        await instanceA.reload();
        await instanceB.reload();
        expect(instanceA.getStats().activeCronTasks).toBe(1);
        expect(instanceB.getStats().activeCronTasks).toBe(0);
      } finally {
        instanceB.onModuleDestroy();
      }
    });
  });

  describe('claimTaskTrigger — DB conditional claim (TASK-006)', () => {
    /**
     * 构造"两个实例并发扫描"场景：Redis 锁服务不可用（两实例都走 DB claim
     * 兜底路径），数据库行级条件 UPDATE 保证只有一个实例 claim 成功。
     */
    const setupConcurrentClaim = (task: Task, winner: 'first' | 'second') => {
      redisLockService.acquireLock.mockRejectedValue(new Error('redis down'));
      let calls = 0;
      taskRepo.createQueryBuilder.mockImplementation(() =>
        makeUpdateQb({
          affected: (calls += 1) === (winner === 'first' ? 1 : 2) ? 1 : 0,
        }),
      );
      // claim 成功后 enqueue 的正常路径
      taskRepo.findOne.mockResolvedValue(task);
      const exec = { id: 'exec-1', status: ExecutionStatus.PENDING } as TaskExecution;
      execRepo.create.mockReturnValue(exec);
      execRepo.save.mockResolvedValue(exec);
    };

    it('two instances claim concurrently — exactly one wins and enqueues', async () => {
      await makeLeader();
      const task = makeTask();
      setupConcurrentClaim(task, 'first');

      const [resultA, resultB] = await Promise.all([
        service.enqueue(task, 'cron'),
        service.enqueue({ ...task }, 'cron'),
      ]);

      const winners = [resultA, resultB].filter(Boolean);
      expect(winners).toHaveLength(1);
      expect(winners[0]).toEqual(execRepo.create.mock.results[0].value);
      expect(queue.add).toHaveBeenCalledTimes(1);
    });

    it('the losing instance skips without creating any execution', async () => {
      await makeLeader();
      const task = makeTask();
      setupConcurrentClaim(task, 'second');
      // 直接验证 claim 失败即跳过：条件 UPDATE 返回 affected=0
      taskRepo.createQueryBuilder.mockImplementation(() =>
        makeUpdateQb({ affected: 0 }),
      );

      const result = await service.enqueue(task, 'cron');
      expect(result).toBeNull();
      expect(queue.add).not.toHaveBeenCalled();
      expect(execRepo.create).not.toHaveBeenCalled();
    });

    it('db claim UPDATE is guarded by status=ACTIVE and the trigger window', async () => {
      await makeLeader();
      const task = makeTask();
      redisLockService.acquireLock.mockRejectedValue(new Error('redis down'));
      taskRepo.createQueryBuilder.mockImplementation(() =>
        makeUpdateQb({ affected: 0 }),
      );

      await service.enqueue(task, 'cron');

      const qb = taskRepo.createQueryBuilder.mock.results[0].value;
      expect(qb.where).toHaveBeenCalledWith(
        expect.stringContaining('"status" = :status'),
        expect.objectContaining({ status: TaskStatus.ACTIVE }),
      );
      expect(qb.where).toHaveBeenCalledWith(
        expect.stringContaining('"lastTriggerTime"'),
        expect.objectContaining({ windowStart: expect.any(Date) }),
      );
      expect(qb.set).toHaveBeenCalledWith(
        expect.objectContaining({ lastTriggerTime: expect.any(Date) }),
      );
    });

    it('keeps using the redis trigger lock (no db claim) when redis is healthy', async () => {
      await makeLeader();
      const task = makeTask();
      redisLockService.acquireLock.mockResolvedValueOnce({
        key: `task:trigger:${task.id}`,
        lockId: 'l1',
        ttlMs: 5000,
        released: false,
        release: jest.fn().mockResolvedValue(true),
      });
      taskRepo.findOne.mockResolvedValue(task);
      const exec = { id: 'exec-1', status: ExecutionStatus.PENDING } as TaskExecution;
      execRepo.create.mockReturnValue(exec);
      execRepo.save.mockResolvedValue(exec);

      await service.enqueue(task, 'manual');
      expect(taskRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalled();
    });
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

    it('releases the leader lock on shutdown', async () => {
      const release = jest.fn().mockResolvedValue(true);
      redisLockService.acquireLock.mockResolvedValueOnce({
        key: 'scheduler:leader',
        lockId: 'leader-lock-id',
        ttlMs: 30000,
        released: false,
        release,
      });
      await service.initLeaderElection();
      await service.onModuleDestroy();
      expect(release).toHaveBeenCalled();
      expect(service.getStats().isLeader).toBe(false);
    });
  });

  describe('checkMisfires', () => {
    it('should skip tasks without lastTriggerTime', async () => {
      await makeLeader();
      const task = makeTask({ lastTriggerTime: null });
      taskRepo.find.mockResolvedValue([task]);
      await expect(service.checkMisfires()).resolves.not.toThrow();
    });

    it('should fire once for FIRE_ONCE misfire strategy', async () => {
      await makeLeader();
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
      await makeLeader();
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
      await makeLeader();
      redisLockService.acquireLock.mockResolvedValue(null);
      const task = makeTask();
      const result = await service.enqueue(task, 'manual');
      expect(result).toBeNull();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('should return null when task is no longer active', async () => {
      await makeLeader();
      const lock = { release: jest.fn().mockResolvedValue(undefined) };
      redisLockService.acquireLock.mockResolvedValue(lock);
      taskRepo.findOne.mockResolvedValue(null);
      const task = makeTask();
      const result = await service.enqueue(task, 'manual');
      expect(result).toBeNull();
      // P1: the dedup lock is deliberately NOT released — its TTL is the
      // dedup window across instances.
      expect(lock.release).not.toHaveBeenCalled();
    });

    it('should enqueue task and return execution when all checks pass', async () => {
      await makeLeader();
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
      // P1: not released on success either — TTL-based dedup, see enqueue.
      expect(lock.release).not.toHaveBeenCalled();
    });

    it('should skip and return null when blockStrategy=DISCARD and task is running', async () => {
      await makeLeader();
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
      // P1: not released on skip — TTL-based dedup, see enqueue.
      expect(lock.release).not.toHaveBeenCalled();
    });

    it('should cancel running execution when blockStrategy=COVER_EARLY', async () => {
      await makeLeader();
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
      await makeLeader();
      const task = makeTask({
        triggerType: TaskTriggerType.CRON,
        cronExpression: '0 * * * *',
      });
      taskRepo.find.mockResolvedValue([task]);
      await service.reload();
      const stats = service.getStats();
      expect(stats.activeCronTasks).toBe(1);
    });

    it('should pass timezone option when scheduling cron task on reload', async () => {
      await makeLeader();
      const scheduleSpy = jest.spyOn(nodeCron, 'schedule');
      const task = makeTask({
        triggerType: TaskTriggerType.CRON,
        cronExpression: '0 * * * *',
        timezone: 'Asia/Shanghai',
      });
      taskRepo.find.mockResolvedValue([task]);
      await service.reload();
      expect(scheduleSpy).toHaveBeenCalledWith('0 * * * *', expect.any(Function), { timezone: 'Asia/Shanghai' });
      scheduleSpy.mockRestore();
    });

    it('should skip cron task with invalid expression', async () => {
      await makeLeader();
      const task = makeTask({
        triggerType: TaskTriggerType.CRON,
        cronExpression: 'not-valid-cron',
      });
      taskRepo.find.mockResolvedValue([task]);
      await service.reload();
      const stats = service.getStats();
      expect(stats.activeCronTasks).toBe(0);
    });

    it('should fall back to server timezone when task timezone is invalid', async () => {
      await makeLeader();
      const scheduleSpy = jest.spyOn(nodeCron, 'schedule');
      const task = makeTask({
        triggerType: TaskTriggerType.CRON,
        cronExpression: '0 * * * *',
        timezone: 'Not/AZone',
      });
      taskRepo.find.mockResolvedValue([task]);
      await service.reload();
      expect(scheduleSpy).toHaveBeenCalledWith('0 * * * *', expect.any(Function), undefined);
      scheduleSpy.mockRestore();
    });

    it('should schedule a fixed_rate task', async () => {
      await makeLeader();
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
      await makeLeader();
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

    it('should not register the same task twice when reload and scheduleOne overlap (TASK-003)', async () => {
      await makeLeader();
      const task = makeTask({ triggerType: TaskTriggerType.CRON, cronExpression: '0 * * * *' });
      taskRepo.find.mockResolvedValue([task]);

      const reloadPromise = service.reload();
      const schedulePromise = service.scheduleOne(task);
      await Promise.all([reloadPromise, schedulePromise]);

      expect(service.getStats().activeCronTasks).toBe(1);
    });

    it('concurrent reload + scheduleOne for many tasks never double-registers (TASK-003)', async () => {
      await makeLeader();
      const tasks = Array.from({ length: 5 }, (_, i) =>
        makeTask({
          id: `task-${i}`,
          triggerType: TaskTriggerType.CRON,
          cronExpression: '0 * * * *',
        }),
      );
      taskRepo.find.mockResolvedValue(tasks);

      await Promise.all([
        service.reload(),
        ...tasks.map((t) => service.scheduleOne(t)),
        service.reload(),
        ...tasks.map((t) => service.scheduleOne(t)),
      ]);

      expect(service.getStats().activeCronTasks).toBe(5);
    });
  });

  describe('recoverStaleExecutions (TASK-004 batch update)', () => {
    it('recovers stale RUNNING executions with a single transactional batch UPDATE', async () => {
      await makeLeader();
      const staleExec = {
        id: 'exec-stale',
        taskId: 'task-1',
        status: ExecutionStatus.RUNNING,
        startTime: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
        executorAddress: 'host:3002',
        errorMessage: null,
        endTime: null,
      };
      execRepo.find
        .mockResolvedValueOnce([staleExec]) // RUNNING scan
        .mockResolvedValueOnce([]); // PENDING scan
      taskRepo.findBy.mockResolvedValue([]);
      // 事务管理器：UPDATE ... RETURNING 命中该行
      dataSource.transaction.mockImplementation(async (fn: any) =>
        fn({
          createQueryBuilder: () =>
            makeUpdateQb({
              affected: 1,
              raw: [{ id: 'exec-stale', executorAddress: 'host:3002' }],
            }),
        }),
      );

      await service.recoverStaleExecutions();

      // 批量路径：不再逐行 save
      expect(execRepo.save).not.toHaveBeenCalled();
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      // 仅对 RETURNING 命中的行释放 executor 槽位
      expect(dataSource.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('uses per-task timeout bucket with TIMEOUT failure reason in batch UPDATE', async () => {
      await makeLeader();
      const staleExec = {
        id: 'exec-timeout',
        taskId: 'task-2',
        status: ExecutionStatus.RUNNING,
        startTime: new Date(Date.now() - 10 * 60 * 1000), // 10 min ago
        executorAddress: 'host:3002',
        errorMessage: null,
        endTime: null,
      };
      execRepo.find
        .mockResolvedValueOnce([staleExec])
        .mockResolvedValueOnce([]);
      taskRepo.findBy.mockResolvedValue([makeTask({ id: 'task-2', timeout: 300 })]);
      const updateQb = makeUpdateQb({
        affected: 1,
        raw: [{ id: 'exec-timeout', executorAddress: 'host:3002' }],
      });
      dataSource.transaction.mockImplementation(async (fn: any) =>
        fn({ createQueryBuilder: () => updateQb }),
      );

      await service.recoverStaleExecutions();

      // 条件 UPDATE 保留终态保护语义：仅 open 状态可被置 FAILED
      expect(updateQb.where).toHaveBeenCalledWith(
        expect.stringContaining('"status" IN (:...open)'),
        expect.objectContaining({
          open: [ExecutionStatus.PENDING, ExecutionStatus.RUNNING],
        }),
      );
      expect(updateQb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: ExecutionStatus.FAILED,
          failureReason: ExecutionFailureReason.TIMEOUT,
        }),
      );
    });

    it('should NOT touch fresh executions (within task timeout) — no transaction at all', async () => {
      await makeLeader();
      const freshExec = {
        id: 'exec-fresh',
        taskId: 'task-3',
        status: ExecutionStatus.RUNNING,
        startTime: new Date(Date.now() - 2 * 60 * 1000), // 2 min ago
        executorAddress: 'host:3002',
      };
      execRepo.find
        .mockResolvedValueOnce([freshExec])
        .mockResolvedValueOnce([]);
      taskRepo.findBy.mockResolvedValue([makeTask({ id: 'task-3', timeout: 600 })]);

      await service.recoverStaleExecutions();

      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(execRepo.save).not.toHaveBeenCalled();
      expect(dataSource.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('sweeps never-dispatched PENDING executions with one conditional batch UPDATE', async () => {
      await makeLeader();
      const stalePending = {
        id: 'exec-pending',
        taskId: 'task-1',
        status: ExecutionStatus.PENDING,
        createdAt: new Date(Date.now() - 20 * 60 * 1000), // 20 min ago
      };
      execRepo.find
        .mockResolvedValueOnce([]) // RUNNING scan empty
        .mockResolvedValueOnce([stalePending]);
      const pendingQb = makeUpdateQb({ affected: 1, raw: [{ id: 'exec-pending' }] });
      execRepo.createQueryBuilder.mockReturnValue(pendingQb);

      await service.recoverStaleExecutions();

      expect(pendingQb.where).toHaveBeenCalledWith(
        expect.stringContaining('"status" = :status'),
        expect.objectContaining({ status: ExecutionStatus.PENDING }),
      );
      expect(pendingQb.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: ExecutionStatus.FAILED }),
      );
    });

    it('does nothing when no running executions exist', async () => {
      await makeLeader();
      execRepo.find.mockResolvedValue([]);
      await service.recoverStaleExecutions();
      expect(execRepo.save).not.toHaveBeenCalled();
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });
  });

  describe('scheduleOne', () => {
    it('should stop existing schedule and register new cron task', async () => {
      await makeLeader();
      const task = makeTask({ triggerType: TaskTriggerType.CRON, cronExpression: '0 * * * *' });
      await service.scheduleOne(task);
      const stats = service.getStats();
      expect(stats.activeCronTasks).toBe(1);
    });

    it('should pass timezone option when scheduleOne registers cron task', async () => {
      await makeLeader();
      const scheduleSpy = jest.spyOn(nodeCron, 'schedule');
      const task = makeTask({ triggerType: TaskTriggerType.CRON, cronExpression: '0 * * * *', timezone: 'UTC' });
      await service.scheduleOne(task);
      expect(scheduleSpy).toHaveBeenCalledWith('0 * * * *', expect.any(Function), { timezone: 'UTC' });
      scheduleSpy.mockRestore();
    });

    it('should stop existing schedule and register fixed_rate timer', async () => {
      await makeLeader();
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
      await makeLeader();
      const task = makeTask({ triggerType: TaskTriggerType.CRON, cronExpression: 'bad-expr' });
      await service.scheduleOne(task);
      expect(service.getStats().activeCronTasks).toBe(0);
    });
  });
});
