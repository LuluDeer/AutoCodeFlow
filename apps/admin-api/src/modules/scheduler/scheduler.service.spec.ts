import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { getQueueToken } from "@nestjs/bull";
import { SchedulerService } from "./scheduler.service";
import {
  Task,
  TaskStatus,
  TaskTriggerType,
  BlockStrategy,
} from "../task/entities/task.entity";
import { TaskExecution } from "../task/entities/task-execution.entity";
import { RedisLockService } from "../../common/services/redis-lock.service";

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

// Helper that returns a lock object (acquireLock resolves with it) or null.
const makeLock = (acquired = true) =>
  acquired ? { release: jest.fn().mockResolvedValue(undefined) } : null;

describe("SchedulerService", () => {
  let service: SchedulerService;
  let taskRepo: ReturnType<typeof makeRepo>;
  let execRepo: ReturnType<typeof makeRepo>;
  let queue: jest.Mocked<{ add: jest.Mock }>;
  let redisLockService: { acquireLock: jest.Mock };

  const task = {
    id: "task-1",
    name: "test-task",
    status: TaskStatus.ACTIVE,
    triggerType: TaskTriggerType.FIXED_RATE,
    fixedRate: 60,
    blockStrategy: BlockStrategy.SERIAL,
    maxRetry: 3,
    retryDelay: 0,
    priority: 0,
    lastTriggerTime: null,
    currentVersion: "1.0.0",
    params: {},
  } as unknown as Task;

  beforeEach(async () => {
    taskRepo = makeRepo({
      find: jest.fn().mockResolvedValue([task]),
      findOne: jest.fn().mockResolvedValue(task),
    });
    execRepo = makeRepo();
    queue = { add: jest.fn().mockResolvedValue(undefined) };
    redisLockService = {
      acquireLock: jest.fn().mockResolvedValue(makeLock(true)),
    };

    const module = await Test.createTestingModule({
      providers: [
        SchedulerService,
        { provide: getRepositoryToken(Task), useValue: taskRepo },
        { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
        { provide: getQueueToken("task-queue"), useValue: queue },
        { provide: RedisLockService, useValue: redisLockService },
      ],
    }).compile();
    service = module.get(SchedulerService);
  });

  it("TASK-01: Redis lock prevents duplicate enqueue in distributed scenario", async () => {
    // First call: lock acquired → enqueue succeeds
    redisLockService.acquireLock
      .mockResolvedValueOnce(makeLock(true))
      // Second call: lock not acquired (another instance holds it)
      .mockResolvedValueOnce(null);

    const result1 = await service.enqueue(task, "fixed_rate");
    expect(result1).not.toBeNull();

    const result2 = await service.enqueue(task, "fixed_rate");
    expect(result2).toBeNull();

    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it("TASK-01: returns null immediately when lock is not acquired", async () => {
    redisLockService.acquireLock.mockResolvedValue(null);

    const result = await service.enqueue(task, "fixed_rate");
    expect(result).toBeNull();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("DISCARD strategy skips enqueue when task is already running", async () => {
    execRepo.findOne = jest
      .fn()
      .mockResolvedValue({ id: "exec-1" } as TaskExecution);

    const taskWithDiscard = {
      ...task,
      blockStrategy: BlockStrategy.DISCARD,
    } as Task;

    const result = await service.enqueue(taskWithDiscard, "fixed_rate");
    expect(result).toBeNull();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("WAIT strategy allows enqueue even when task is running", async () => {
    execRepo.findOne = jest
      .fn()
      .mockResolvedValue({ id: "exec-1" } as TaskExecution);

    const taskWithWait = {
      ...task,
      blockStrategy: BlockStrategy.SERIAL,
    } as Task;

    const result = await service.enqueue(taskWithWait, "fixed_rate");
    expect(result).not.toBeNull();
    expect(queue.add).toHaveBeenCalledTimes(1);
  });
});
