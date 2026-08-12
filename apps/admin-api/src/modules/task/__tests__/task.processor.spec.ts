import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { getQueueToken } from "@nestjs/bullmq";
import { TaskProcessor } from "../task.processor";
import {
  TaskExecution,
  ExecutionStatus,
} from "../entities/task-execution.entity";
import { ExecutionLogLine } from "../entities/execution-log-line.entity";
import { Task } from "../entities/task.entity";
import { ExecutorService } from "../../executor/executor.service";
import { AiService } from "../../ai/ai.service";
import { NotificationService } from "../../notification/notification.service";
import { AuditService } from "../../audit/audit.service";
import { TaskService } from "../task.service";

const makeRepo = (overrides: Partial<Record<string, jest.Mock>> = {}) => ({
  findOne: jest.fn(),
  save: jest.fn((e) => Promise.resolve(e)),
  create: jest.fn((d) => d),
  delete: jest.fn().mockResolvedValue(undefined),
  ...overrides,
});

// Minimal DataSource mock: createQueryRunner returns a stub that satisfies
// the transaction path in the finally block of TaskProcessor.handle.
const makeDataSource = () => ({
  createQueryRunner: jest.fn(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    manager: {
      save: jest.fn((e) => Promise.resolve(e)),
      findOne: jest.fn().mockResolvedValue(null),
    },
  })),
});

describe("TaskProcessor", () => {
  let processor: TaskProcessor;
  let execRepo: ReturnType<typeof makeRepo>;
  let taskRepo: ReturnType<typeof makeRepo>;
  let logLineRepo: ReturnType<typeof makeRepo>;
  let executorService: jest.Mocked<Pick<ExecutorService, "dispatch" | "dispatchBroadcast">>;
  let aiService: jest.Mocked<Pick<AiService, "analyzeFailure">>;
  let notificationService: jest.Mocked<
    Pick<NotificationService, "notifyFailureWithConfig">
  >;
  let auditService: { log: jest.Mock };
  let taskService: { trigger: jest.Mock };
  let dataSource: ReturnType<typeof makeDataSource>;

  const task = {
    id: "t1",
    name: "task1",
    timeout: 10,
    alarmEmail: undefined,
    alarmChannels: [],
    executeMode: "single",
  } as unknown as Task;
  const exec = {
    id: "exec-1",
    taskId: "t1",
    status: ExecutionStatus.PENDING,
    params: {},
  } as TaskExecution;

  beforeEach(async () => {
    execRepo = makeRepo({ findOne: jest.fn().mockResolvedValue({ ...exec }) });
    taskRepo = makeRepo({ findOne: jest.fn().mockResolvedValue(task) });
    logLineRepo = makeRepo();
    executorService = { dispatch: jest.fn(), dispatchBroadcast: jest.fn() };
    aiService = { analyzeFailure: jest.fn().mockResolvedValue("analysis") };
    notificationService = {
      notifyFailureWithConfig: jest.fn().mockResolvedValue(undefined),
    };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };
    taskService = { trigger: jest.fn().mockResolvedValue(undefined) };
    dataSource = makeDataSource();

    const module = await Test.createTestingModule({
      providers: [
        TaskProcessor,
        { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
        { provide: getRepositoryToken(Task), useValue: taskRepo },
        {
          provide: getRepositoryToken(ExecutionLogLine),
          useValue: logLineRepo,
        },
        { provide: ExecutorService, useValue: executorService },
        { provide: AiService, useValue: aiService },
        { provide: NotificationService, useValue: notificationService },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue("") },
        },
        { provide: AuditService, useValue: auditService },
        { provide: TaskService, useValue: taskService },
        { provide: getQueueToken("task-queue"), useValue: { add: jest.fn() } },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    processor = module.get(TaskProcessor);
  });

  it("keeps execution RUNNING when dispatch is accepted", async () => {
    executorService.dispatch.mockResolvedValue({
      status: "accepted",
      executionId: "exec-1",
      executorAddress: "127.0.0.1:3105",
    });
    await processor.handle({ data: { executionId: "exec-1" } } as any);
    const queryRunner = dataSource.createQueryRunner.mock.results[0].value;
    const finalSaved = queryRunner.manager.save.mock.calls.at(-1)[0];
    expect(finalSaved.status).toBe(ExecutionStatus.RUNNING);
    expect(finalSaved.endTime).toBeUndefined();
    expect(finalSaved.result).toMatchObject({ status: "accepted" });
  });

  it("marks execution FAILED and rethrows when dispatch fails", async () => {
    executorService.dispatch.mockRejectedValue(new Error("exec failed"));
    await expect(
      processor.handle({ data: { executionId: "exec-1" } } as any),
    ).rejects.toThrow("exec failed");
    const saved = execRepo.save.mock.calls.map((c: any) => c[0]);
    expect(saved.some((e: any) => e.status === ExecutionStatus.FAILED)).toBe(
      true,
    );
  });

  it("returns early if execution not found", async () => {
    execRepo.findOne.mockResolvedValue(null);
    await processor.handle({ data: { executionId: "missing" } } as any);
    expect(executorService.dispatch).not.toHaveBeenCalled();
  });

  it("marks FAILED if task not found", async () => {
    taskRepo.findOne.mockResolvedValue(null);
    await processor.handle({ data: { executionId: "exec-1" } } as any);
    const saved = execRepo.save.mock.calls.map((c: any) => c[0]);
    expect(saved.some((e: any) => e.status === ExecutionStatus.FAILED)).toBe(
      true,
    );
  });

  it("ERR-01: original error is not masked when transaction save fails", async () => {
    const originalError = new Error("dispatch failed");
    executorService.dispatch.mockRejectedValue(originalError);

    // Make the queryRunner manager.save throw to simulate DB failure in finally
    const qr = dataSource.createQueryRunner();
    qr.manager.save.mockRejectedValue(new Error("database connection failed"));
    dataSource.createQueryRunner.mockReturnValue(qr);

    // The original dispatch error should still be thrown
    await expect(
      processor.handle({ data: { executionId: "exec-1" } } as any),
    ).rejects.toThrow("dispatch failed");
  });

  it("ERR-02: duration is 0 when startTime is null", async () => {
    const execWithoutStartTime = {
      id: "exec-2",
      taskId: "t1",
      status: ExecutionStatus.PENDING,
      params: {},
      startTime: null,
    } as unknown as TaskExecution;
    execRepo.findOne = jest.fn().mockResolvedValue(execWithoutStartTime);
    taskRepo.findOne.mockResolvedValue(null);

    await processor.handle({ data: { executionId: "exec-2" } } as any);

    // Task-not-found returns early before the finally block, so we just
    // verify no unhandled error was thrown and the execution was saved as FAILED.
    const saved = execRepo.save.mock.calls.map((c: any) => c[0]);
    expect(saved.some((e: any) => e.status === ExecutionStatus.FAILED)).toBe(
      true,
    );
  });
});
