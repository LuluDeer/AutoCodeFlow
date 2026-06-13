import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { HealthService } from "../health.service";
import { Task } from "../../task/entities/task.entity";
import { Executor } from "../../executor/entities/executor.entity";
import { TaskExecution, ExecutionStatus } from "../../task/entities/task-execution.entity";

// Mock the redis createClient so HealthService constructor doesn't open a real connection
jest.mock("redis", () => ({
  createClient: jest.fn(() => ({
    isReady: false,
    connect: jest.fn().mockResolvedValue(undefined),
    ping: jest.fn().mockResolvedValue("PONG"),
  })),
}));

const makeRepoMock = (overrides: Partial<Record<string, jest.Mock>> = {}) => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn(),
  count: jest.fn().mockResolvedValue(0),
  query: jest.fn().mockResolvedValue([{ "?column?": 1 }]),
  ...overrides,
});

const makeQueueMock = () => ({
  getWaitingCount: jest.fn().mockResolvedValue(0),
  getActiveCount: jest.fn().mockResolvedValue(1),
  getDelayedCount: jest.fn().mockResolvedValue(0),
  getFailedCount: jest.fn().mockResolvedValue(0),
  getJobs: jest.fn().mockResolvedValue([]),
});

describe("HealthService", () => {
  let service: HealthService;
  let taskRepo: ReturnType<typeof makeRepoMock>;
  let executorRepo: ReturnType<typeof makeRepoMock>;
  let execRepo: ReturnType<typeof makeRepoMock>;
  let taskQueue: ReturnType<typeof makeQueueMock>;

  beforeEach(async () => {
    taskRepo = makeRepoMock();
    executorRepo = makeRepoMock();
    execRepo = makeRepoMock();
    taskQueue = makeQueueMock();

    const module = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: getRepositoryToken(Task), useValue: taskRepo },
        { provide: getRepositoryToken(Executor), useValue: executorRepo },
        { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
        { provide: "BullQueue_task-queue", useValue: taskQueue },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(undefined) } },
      ],
    }).compile();

    service = module.get(HealthService);
  });

  describe("checkDatabase", () => {
    it("returns healthy when SELECT 1 succeeds", async () => {
      taskRepo.query.mockResolvedValue([{ "?column?": 1 }]);
      const result = await service.checkDatabase();
      expect(result.status).toBe("healthy");
      expect(taskRepo.query).toHaveBeenCalledWith("SELECT 1");
    });

    it("returns unhealthy when query throws", async () => {
      taskRepo.query.mockRejectedValue(new Error("connection refused"));
      const result = await service.checkDatabase();
      expect(result.status).toBe("unhealthy");
      expect(result.details).toContain("connection refused");
    });
  });

  describe("checkQueue", () => {
    it("returns healthy when queue counts are normal", async () => {
      const result = await service.checkQueue();
      expect(result.status).toBe("healthy");
      expect(typeof result.size).toBe("number");
    });

    it("returns degraded when failed count exceeds threshold", async () => {
      taskQueue.getFailedCount.mockResolvedValue(200);
      const result = await service.checkQueue();
      expect(result.status).toBe("degraded");
    });

    it("returns unhealthy when queue throws", async () => {
      taskQueue.getWaitingCount.mockRejectedValue(new Error("Bull down"));
      const result = await service.checkQueue();
      expect(result.status).toBe("unhealthy");
    });
  });

  describe("checkExecutors", () => {
    it("returns degraded when no executors are registered", async () => {
      executorRepo.find.mockResolvedValue([]);
      const result = await service.checkExecutors();
      expect(result.status).toBe("degraded");
      expect(result.totalCount).toBe(0);
    });

    it("returns unhealthy when all executors are offline", async () => {
      executorRepo.find.mockResolvedValue([
        { id: "e1", status: "offline" },
        { id: "e2", status: "offline" },
      ]);
      const result = await service.checkExecutors();
      expect(result.status).toBe("unhealthy");
      expect(result.onlineCount).toBe(0);
    });

    it("returns healthy when majority of executors are online", async () => {
      executorRepo.find.mockResolvedValue([
        { id: "e1", status: "online" },
        { id: "e2", status: "online" },
        { id: "e3", status: "offline" },
      ]);
      const result = await service.checkExecutors();
      expect(result.status).toBe("healthy");
      expect(result.onlineCount).toBe(2);
      expect(result.totalCount).toBe(3);
    });

    it("returns degraded when fewer than 50% of executors are online", async () => {
      executorRepo.find.mockResolvedValue([
        { id: "e1", status: "online" },
        { id: "e2", status: "offline" },
        { id: "e3", status: "offline" },
      ]);
      const result = await service.checkExecutors();
      expect(result.status).toBe("degraded");
    });
  });

  describe("checkTasks", () => {
    it("returns task counts correctly", async () => {
      taskRepo.find.mockResolvedValue([
        { id: "t1", status: "active" },
        { id: "t2", status: "active" },
        { id: "t3", status: "disabled" },
      ]);
      execRepo.count.mockResolvedValue(1);

      const result = await service.checkTasks();
      expect(result.status).toBe("healthy");
      expect(result.activeCount).toBe(2);
      expect(result.totalCount).toBe(3);
      expect(result.runningCount).toBe(1);
    });
  });

  describe("checkScheduler", () => {
    it("returns healthy when getJobs succeeds", async () => {
      taskQueue.getJobs.mockResolvedValue([{}, {}]);
      const result = await service.checkScheduler();
      expect(result.status).toBe("healthy");
      expect(result.details).toContain("2 jobs");
    });

    it("returns unhealthy when getJobs throws", async () => {
      taskQueue.getJobs.mockRejectedValue(new Error("queue error"));
      const result = await service.checkScheduler();
      expect(result.status).toBe("unhealthy");
    });
  });
});
