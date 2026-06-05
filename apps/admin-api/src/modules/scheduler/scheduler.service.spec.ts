import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bull';
import { SchedulerService } from './scheduler.service';
import { Task, TaskStatus, TaskTriggerType, BlockStrategy } from '../task/entities/task.entity';
import { TaskExecution, ExecutionStatus } from '../task/entities/task-execution.entity';

const makeRepo = (overrides: Partial<Record<string, jest.Mock>> = {}) => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
  save: jest.fn((e) => Promise.resolve(e)),
  create: jest.fn((d) => d),
  delete: jest.fn().mockResolvedValue(undefined),
  createQueryBuilder: jest.fn(() => ({
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  })),
  ...overrides,
});

describe('SchedulerService', () => {
  let service: SchedulerService;
  let taskRepo: ReturnType<typeof makeRepo>;
  let execRepo: ReturnType<typeof makeRepo>;
  let queue: jest.Mocked<{ add: jest.Mock }>;

  const task = {
    id: 'task-1',
    name: 'test-task',
    status: TaskStatus.ACTIVE,
    triggerType: TaskTriggerType.FIXED_RATE,
    fixedRate: 60,
    blockStrategy: BlockStrategy.WAIT,
    maxRetry: 3,
    lastTriggerTime: null,
    currentVersion: '1.0.0',
    params: {},
  } as Task;

  beforeEach(async () => {
    taskRepo = makeRepo({
      find: jest.fn().mockResolvedValue([task]),
      findOne: jest.fn().mockResolvedValue(task),
    });
    execRepo = makeRepo();
    queue = { add: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        SchedulerService,
        { provide: getRepositoryToken(Task), useValue: taskRepo },
        { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
        { provide: getQueueToken('task-queue'), useValue: queue },
      ],
    }).compile();
    service = module.get(SchedulerService);
  });

  it('TASK-01: database CAS prevents duplicate enqueue in distributed scenario', async () => {
    // Simulate two instances attempting to enqueue simultaneously
    let casCallCount = 0;
    
    const queryBuilderMock = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn(() => {
        casCallCount++;
        // First call succeeds (affected = 1), second call fails (affected = 0)
        return Promise.resolve({ affected: casCallCount === 1 ? 1 : 0 });
      }),
    };
    
    taskRepo.createQueryBuilder = jest.fn(() => queryBuilderMock);
    
    // First instance: should succeed
    const result1 = await service.enqueue(task, 'fixed_rate');
    expect(result1).not.toBeNull();
    
    // Second instance: should be blocked by CAS
    const result2 = await service.enqueue(task, 'fixed_rate');
    expect(result2).toBeNull();
    
    // Only one enqueue should have happened
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('TASK-01: respects minIntervalMs guard window', async () => {
    const recentTime = new Date(Date.now() - 1000); // 1 second ago
    const taskWithRecentTrigger = {
      ...task,
      lastTriggerTime: recentTime,
    } as Task;
    
    taskRepo.findOne = jest.fn().mockResolvedValue(taskWithRecentTrigger);
    
    // CAS should fail because lastTriggerTime is within the guard window
    const queryBuilderMock = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 0 }), // CAS fails
    };
    
    taskRepo.createQueryBuilder = jest.fn(() => queryBuilderMock);
    
    const result = await service.enqueue(taskWithRecentTrigger, 'fixed_rate');
    expect(result).toBeNull();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('DISCARD strategy skips enqueue when task is already running', async () => {
    // Mock CAS to succeed
    const queryBuilderMock = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    taskRepo.createQueryBuilder = jest.fn(() => queryBuilderMock);
    
    // Mock a running execution
    execRepo.findOne = jest.fn().mockResolvedValue({ id: 'exec-1' } as TaskExecution);
    
    const taskWithDiscard = {
      ...task,
      blockStrategy: BlockStrategy.DISCARD,
    } as Task;
    
    const result = await service.enqueue(taskWithDiscard, 'fixed_rate');
    expect(result).toBeNull();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('WAIT strategy allows enqueue even when task is running', async () => {
    // Mock CAS to succeed
    const queryBuilderMock = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    taskRepo.createQueryBuilder = jest.fn(() => queryBuilderMock);
    
    // Mock a running execution
    execRepo.findOne = jest.fn().mockResolvedValue({ id: 'exec-1' } as TaskExecution);
    
    const taskWithWait = {
      ...task,
      blockStrategy: BlockStrategy.WAIT,
    } as Task;
    
    const result = await service.enqueue(taskWithWait, 'fixed_rate');
    expect(result).not.toBeNull();
    expect(queue.add).toHaveBeenCalledTimes(1);
  });
});