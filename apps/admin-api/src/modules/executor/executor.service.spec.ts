import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ExecutorService } from "./executor.service";
import { Executor, ExecutorStatus } from "./entities/executor.entity";
import { Task } from "../task/entities/task.entity";
import {
  TaskExecution,
  ExecutionStatus,
} from "../task/entities/task-execution.entity";
import axios from "axios";
import { ConfigService } from "@nestjs/config";
import { NotificationService } from "../notification/notification.service";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

const makeRepo = (overrides: Partial<Record<string, jest.Mock>> = {}) => ({
  findOne: jest.fn(),
  find: jest.fn(),
  create: jest.fn((d) => d),
  save: jest.fn((e) => Promise.resolve(e)),
  update: jest.fn().mockResolvedValue({ affected: 0 }),
  increment: jest.fn().mockResolvedValue(undefined),
  decrement: jest.fn().mockResolvedValue(undefined),
  delete: jest.fn().mockResolvedValue({ affected: 0 }),
  createQueryBuilder: jest.fn(() => ({
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
    getCount: jest.fn().mockResolvedValue(0),
    leftJoin: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
    getOne: jest.fn().mockResolvedValue(null),
  })),
  ...overrides,
});

describe("ExecutorService", () => {
  let service: ExecutorService;
  let executorRepo: ReturnType<typeof makeRepo>;
  let execRepo: ReturnType<typeof makeRepo>;
  let notificationService: { notifyExecutorOnline: jest.Mock };

  beforeEach(async () => {
    executorRepo = makeRepo();
    execRepo = makeRepo();
    notificationService = { notifyExecutorOnline: jest.fn().mockResolvedValue(undefined) };
    const module = await Test.createTestingModule({
      providers: [
        ExecutorService,
        { provide: getRepositoryToken(Executor), useValue: executorRepo },
        { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
        { provide: getRepositoryToken(Task), useValue: makeRepo() },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue("http") } },
        { provide: NotificationService, useValue: notificationService },
      ],
    }).compile();
    service = module.get(ExecutorService);
  });

  describe("register", () => {
    it("creates new executor if not found", async () => {
      executorRepo.findOne.mockResolvedValue(null);
      await service.register({ appName: "e1", address: "127.0.0.1:3105" });
      expect(executorRepo.save).toHaveBeenCalled();
    });

    it("sends online notification on first registration", async () => {
      executorRepo.findOne.mockResolvedValue(null);
      await service.register({ appName: "e1", address: "127.0.0.1:3105" });
      // give the fire-and-forget promise a tick to settle
      await new Promise((r) => setImmediate(r));
      expect(notificationService.notifyExecutorOnline).toHaveBeenCalledWith(
        "e1",
        "127.0.0.1:3105",
      );
    });

    it("does not send notification on re-register", async () => {
      const existing = { appName: "e1", address: "127.0.0.1:3105", status: ExecutorStatus.OFFLINE };
      executorRepo.findOne.mockResolvedValue(existing);
      await service.register({ appName: "e1", address: "127.0.0.1:3105" });
      await new Promise((r) => setImmediate(r));
      expect(notificationService.notifyExecutorOnline).not.toHaveBeenCalled();
    });

    it("updates existing executor on re-register", async () => {
      const existing = {
        appName: "e1",
        address: "127.0.0.1:3105",
        status: ExecutorStatus.OFFLINE,
      };
      executorRepo.findOne.mockResolvedValue(existing);
      await service.register({ appName: "e1", address: "127.0.0.1:3105" });
      expect(existing.status).toBe(ExecutorStatus.ONLINE);
    });
  });

  describe("dispatch", () => {
    const executor = {
      address: "127.0.0.1:3105",
      status: ExecutorStatus.ONLINE,
      runningTaskCount: 0,
      capabilities: ["node"],
    };
    const execution = { id: "exec-1", params: {} } as TaskExecution;
    const task = {
      id: "task-1",
      name: "test",
      runtime: "node",
      timeout: 10,
      status: "active",
      triggerType: "manual",
    } as unknown as Task;

    it("dispatches to online executor and returns data", async () => {
      executorRepo.find.mockResolvedValue([executor]);
      mockedAxios.post.mockResolvedValue({ data: { success: true, logs: "" } });
      const result = await service.dispatch(task, execution);
      expect(result.success).toBe(true);
      // service uses createQueryBuilder for optimistic-lock increment
      expect(executorRepo.createQueryBuilder).toHaveBeenCalled();
    });

    it("rolls back increment on dispatch failure", async () => {
      executorRepo.find.mockResolvedValue([executor]);
      mockedAxios.post.mockRejectedValue(new Error("network error"));
      await expect(service.dispatch(task, execution)).rejects.toThrow(
        "network error",
      );
      // service calls createQueryBuilder twice: once to increment, once to rollback
      expect(executorRepo.createQueryBuilder).toHaveBeenCalledTimes(2);
    });

    it("throws if no executor available", async () => {
      executorRepo.find.mockResolvedValue([]);
      await expect(service.dispatch(task, execution)).rejects.toThrow(
        "No available executor",
      );
    });
  });
});
