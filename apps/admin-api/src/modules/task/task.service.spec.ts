import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { getQueueToken } from "@nestjs/bull";
import { NotFoundException } from "@nestjs/common";
import { TaskService } from "./task.service";
import { Task, TaskStatus } from "./entities/task.entity";
import {
  TaskExecution,
  ExecutionStatus,
} from "./entities/task-execution.entity";
import { ExecutionLogLine } from "./entities/execution-log-line.entity";
import { TaskVersion } from "./entities/task-version.entity";
import { SchedulerService } from "../scheduler/scheduler.service";

const mockRepo = () => ({
  create: jest.fn(),
  save: jest.fn(),
  findOne: jest.fn(),
  findAndCount: jest.fn(),
});
const mockQueue = () => ({ add: jest.fn() });
const mockDataSource = () => ({ transaction: jest.fn() });
const mockScheduler = () => ({ stop: jest.fn(), scheduleOne: jest.fn() });

describe("TaskService", () => {
  let service: TaskService;
  let taskRepo: ReturnType<typeof mockRepo>;
  let execRepo: ReturnType<typeof mockRepo>;
  let taskQueue: ReturnType<typeof mockQueue>;
  let dataSource: ReturnType<typeof mockDataSource>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        TaskService,
        { provide: getRepositoryToken(Task), useFactory: mockRepo },
        { provide: getRepositoryToken(TaskExecution), useFactory: mockRepo },
        { provide: getRepositoryToken(ExecutionLogLine), useFactory: mockRepo },
        { provide: getRepositoryToken(TaskVersion), useFactory: mockRepo },
        { provide: getQueueToken("task-queue"), useFactory: mockQueue },
        { provide: DataSource, useFactory: mockDataSource },
        { provide: SchedulerService, useFactory: mockScheduler },
      ],
    }).compile();

    service = module.get(TaskService);
    taskRepo = module.get(getRepositoryToken(Task));
    execRepo = module.get(getRepositoryToken(TaskExecution));
    taskQueue = module.get(getQueueToken("task-queue"));
    dataSource = module.get(DataSource);
  });

  describe("create", () => {
    it("should create and save a task", async () => {
      const dto = { name: "test-task" } as any;
      const entity = { id: "1", ...dto };
      taskRepo.create.mockReturnValue(entity);
      taskRepo.save.mockResolvedValue(entity);

      const result = await service.create(dto);
      expect(taskRepo.create).toHaveBeenCalledWith(dto);
      expect(taskRepo.save).toHaveBeenCalledWith(entity);
      expect(result).toEqual(entity);
    });
  });

  describe("findOne", () => {
    it("should return task when found", async () => {
      const task = { id: "1", name: "test" };
      taskRepo.findOne.mockResolvedValue(task);
      await expect(service.findOne("1")).resolves.toEqual(task);
    });

    it("should throw NotFoundException when not found", async () => {
      taskRepo.findOne.mockResolvedValue(null);
      await expect(service.findOne("999")).rejects.toThrow(NotFoundException);
    });
  });

  describe("trigger", () => {
    it("should create execution and enqueue job", async () => {
      const task = {
        id: "1",
        name: "test",
        params: {},
        maxRetry: 3,
        currentVersion: "v1",
      };
      const exec = { id: "exec-1", status: ExecutionStatus.PENDING };
      taskRepo.findOne.mockResolvedValue(task);
      dataSource.transaction.mockImplementation((fn: any) =>
        fn({
          create: jest.fn().mockReturnValue(exec),
          save: jest.fn().mockResolvedValue(exec),
        }),
      );
      taskQueue.add.mockResolvedValue({});

      const result = await service.trigger("1", {});
      expect(taskQueue.add).toHaveBeenCalledWith(
        "execute",
        { executionId: exec.id },
        { attempts: task.maxRetry, backoff: { type: 'exponential', delay: 10_000 } },
      );
      expect(result).toEqual(exec);
    });
  });
});
