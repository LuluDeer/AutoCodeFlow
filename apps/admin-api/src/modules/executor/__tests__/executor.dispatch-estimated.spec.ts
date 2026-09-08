/**
 * CORE-05: dispatch / selectLeastLoaded 消费新 loadScore 的集成断言——
 * estimatedDurationsFor 取数契约、长任务倾向空闲执行器、查询失败降级。
 * 复用 executor.service.spec 的 mock repo 结构（mk / makeRepo 同形态）。
 */
import { Test } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ExecutorService } from "../executor.service";
import { Executor, ExecutorStatus } from "../entities/executor.entity";
import { ExecutorMetricsHistory } from "../entities/executor-metrics-history.entity";
import { Task } from "../../task/entities/task.entity";
import {
  TaskExecution,
  ExecutionStatus,
} from "../../task/entities/task-execution.entity";
import { ConfigService } from "@nestjs/config";
import { NotificationService } from "../../notification/notification.service";
import { SystemConfigService } from "../../config/config.service";
import { SecretsCryptoService } from "../../../common/utils/secret-crypto.util.service";
import axios from "axios";

jest.mock("axios");
jest.mock("../../../common/utils/safe-http.util", () => ({
  ...jest.requireActual("../../../common/utils/safe-http.util"),
  assertSafeExecutorUrl: jest
    .fn()
    .mockResolvedValue(new URL("http://fixture:3002/")),
}));
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mk = (over: Partial<Executor> = {}): Executor =>
  ({
    id: "e-" + Math.random().toString(36).slice(2, 8),
    appName: "ex",
    address: "127.0.0.1:3105",
    status: ExecutorStatus.ONLINE,
    runningTaskCount: 0,
    version: 1,
    ...over,
  }) as Executor;

describe("ExecutorService CORE-05（estimatedDurationSec 参与调度评分）", () => {
  let service: ExecutorService;
  let executorRepo: Record<string, jest.Mock>;
  let execRepo: Record<string, jest.Mock>;
  let taskRepo: Record<string, jest.Mock>;

  const execution = { id: "exec-1", params: {} } as unknown as TaskExecution;

  beforeEach(async () => {
    executorRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      createQueryBuilder: jest.fn(() => ({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      })),
    };
    execRepo = {
      find: jest.fn().mockResolvedValue([]),
    };
    taskRepo = {
      find: jest.fn().mockResolvedValue([]),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        ExecutorService,
        { provide: getRepositoryToken(Executor), useValue: executorRepo },
        {
          provide: getRepositoryToken(TaskExecution),
          useValue: execRepo,
        },
        { provide: getRepositoryToken(Task), useValue: taskRepo },
        {
          provide: getRepositoryToken(ExecutorMetricsHistory),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        { provide: getQueueToken("task-queue"), useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: NotificationService, useValue: {} },
        { provide: SystemConfigService, useValue: {} },
        {
          provide: SecretsCryptoService,
          useValue: { decryptForDispatch: jest.fn() },
        },
      ],
    }).compile();
    service = moduleRef.get(ExecutorService);
    jest.spyOn(service["logger"], "error").mockImplementation(() => undefined);
    jest.spyOn(service["logger"], "log").mockImplementation(() => undefined);
    jest.spyOn(service["logger"], "warn").mockImplementation(() => undefined);
    mockedAxios.post.mockClear();
    mockedAxios.post.mockResolvedValue({ data: {}, status: 200 });
  });

  it("selectLeastLoaded：跑长任务的执行器被让位——数值更满但只有短任务的执行器胜出", async () => {
    executorRepo.find.mockResolvedValue([
      mk({ id: "e-long", runningTaskCount: 3, maxConcurrentTasks: 10 }),
      mk({ id: "e-short", runningTaskCount: 4, maxConcurrentTasks: 10 }),
    ]);
    execRepo.find
      // e-long 的 RUNNING 行 → 关联任务预估 3600s
      .mockResolvedValueOnce([{ taskId: "t1" }])
      // e-short 的 RUNNING 行 → 关联任务预估 60s
      .mockResolvedValueOnce([{ taskId: "t2" }]);
    taskRepo.find
      .mockResolvedValueOnce([{ id: "t1", estimatedDurationSec: 3600 }])
      .mockResolvedValueOnce([{ id: "t2", estimatedDurationSec: 60 }]);

    const chosen = await service.selectLeastLoaded();
    expect(chosen.id).toBe("e-short");
  });

  it("estimatedDurationsFor 取数契约：按地址+RUNNING 查执行行、去重 taskId 批量查任务表", async () => {
    executorRepo.find.mockResolvedValue([
      mk({ id: "e1", address: "a:1", runningTaskCount: 2 }),
    ]);
    execRepo.find.mockResolvedValue([
      { taskId: "t1" },
      { taskId: "t1" },
      { taskId: "t2" },
    ]);
    taskRepo.find.mockResolvedValue([
      { id: "t1", estimatedDurationSec: 120 },
      { id: "t2", estimatedDurationSec: null },
    ]);

    await service.selectLeastLoaded();
    expect(execRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { executorAddress: "a:1", status: ExecutionStatus.RUNNING },
      }),
    );
    // 批量查询携带去重后的 taskId 集合（In(...) FindOperator）
    expect(taskRepo.find).toHaveBeenCalledTimes(1);
    const arg = taskRepo.find.mock.calls[0][0];
    expect(arg.select).toEqual(["id", "estimatedDurationSec"]);
    expect(arg.where.id.value).toEqual(expect.arrayContaining(["t1", "t2"]));
  });

  it("估时查询抛错时降级：选主照常返回（评分为旧公式，不中断调度）", async () => {
    executorRepo.find.mockResolvedValue([
      mk({ id: "e1", runningTaskCount: 5, maxConcurrentTasks: 10 }),
      mk({ id: "e2", runningTaskCount: 1, maxConcurrentTasks: 10 }),
    ]);
    execRepo.find.mockRejectedValue(new Error("db down"));

    const chosen = await service.selectLeastLoaded();
    expect(chosen.id).toBe("e2");
  });

  it("runningTaskCount=0 的执行器不做估时查询（无运行任务即无惩罚项）", async () => {
    executorRepo.find.mockResolvedValue([
      mk({ id: "e-idle", runningTaskCount: 0, maxConcurrentTasks: 10 }),
      mk({ id: "e-none", runningTaskCount: 1, maxConcurrentTasks: 10 }),
    ]);
    execRepo.find.mockResolvedValue([{ taskId: "t9" }]);
    taskRepo.find.mockResolvedValue([{ id: "t9", estimatedDurationSec: 3600 }]);

    const chosen = await service.selectLeastLoaded();
    // e-idle：load 0 + 惩罚 0 = 0；e-none：load 0.1 + 惩罚 0.1 = 0.2
    expect(chosen.id).toBe("e-idle");
    expect(execRepo.find).toHaveBeenCalledTimes(1);
  });

  it("dispatch：长任务倾向空闲执行器（同 CPU/内存、load 差距小于惩罚差距时让位）", async () => {
    executorRepo.find.mockResolvedValue([
      mk({
        id: "e-long",
        address: "long:3105",
        runningTaskCount: 2,
        maxConcurrentTasks: 10,
        cpuUsage: 0,
        memUsage: 0,
      }),
      mk({
        id: "e-short",
        address: "short:3105",
        runningTaskCount: 3,
        maxConcurrentTasks: 10,
        cpuUsage: 0,
        memUsage: 0,
      }),
    ]);
    execRepo.find
      .mockResolvedValueOnce([{ taskId: "t1" }])
      .mockResolvedValueOnce([{ taskId: "t2" }]);
    taskRepo.find
      .mockResolvedValueOnce([{ id: "t1", estimatedDurationSec: 7200 }])
      .mockResolvedValueOnce([{ id: "t2", estimatedDurationSec: 30 }]);

    await service.dispatch(
      { id: "task-1", name: "t", timeout: 10 } as unknown as Task,
      execution,
    );
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    const calledUrl = String(mockedAxios.post.mock.calls[0][0]);
    expect(calledUrl).toContain("short:3105");
  });

  it("dispatch：全舰队无估时数据（空 RUNNING 行）时选择与旧公式同序", async () => {
    executorRepo.find.mockResolvedValue([
      mk({
        id: "e-a",
        address: "a:3101",
        runningTaskCount: 1,
        maxConcurrentTasks: 10,
        cpuUsage: 10,
        memUsage: 10,
      }),
      mk({
        id: "e-b",
        address: "b:3102",
        runningTaskCount: 4,
        maxConcurrentTasks: 10,
        cpuUsage: 90,
        memUsage: 90,
      }),
    ]);
    execRepo.find.mockResolvedValue([]);

    await service.dispatch(
      { id: "task-1", name: "t", timeout: 10 } as unknown as Task,
      execution,
    );
    const calledUrl = String(mockedAxios.post.mock.calls[0][0]);
    expect(calledUrl).toContain("a:3101");
  });

  it("dispatch：乐观锁槽位占用成功后新评分不再影响本轮（首个胜者直接锁定）", async () => {
    executorRepo.find.mockResolvedValue([
      mk({
        id: "e-win",
        address: "w:1",
        runningTaskCount: 0,
        maxConcurrentTasks: 10,
      }),
    ]);
    execRepo.find.mockResolvedValue([]);

    await service.dispatch(
      { id: "task-1", name: "t", timeout: 10 } as unknown as Task,
      execution,
    );
    // 槽位原子 UPDATE 走 repo.createQueryBuilder().update(...).execute()
    const qbCalls = executorRepo.createQueryBuilder.mock.calls.length;
    expect(qbCalls).toBeGreaterThanOrEqual(1);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });
});
