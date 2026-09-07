import { randomBytes } from "crypto";
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { getQueueToken } from "@nestjs/bullmq";
import { ConfigService } from "@nestjs/config";
import { Executor } from "../../../modules/executor/entities/executor.entity";
import { TaskExecution } from "../../../modules/task/entities/task-execution.entity";
import { Task } from "../../../modules/task/entities/task.entity";
import { ExecutorMetricsHistory } from "../../../modules/executor/entities/executor-metrics-history.entity";
import { NotificationService } from "../../../modules/notification/notification.service";
import { SystemConfigService } from "../../../modules/config/config.service";
import { ExecutorService } from "../../../modules/executor/executor.service";
import { SecretsCryptoService } from "../secret-crypto.util.service";
import axios from "axios";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

/**
 * SEC-02: dispatch 注入合并语义 — task.secrets 解密后与 params 合并进执行器
 * HTTP 载荷（secrets 覆盖同名 params），且明文绝不回流 TaskExecution.params。
 */

const HEX_KEY = randomBytes(32).toString("hex");

describe("ExecutorService.dispatch — secrets 注入合并 (SEC-02)", () => {
  let service: ExecutorService;
  let executorRepo: {
    findOne: jest.Mock;
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let taskRepo: { findOne: jest.Mock; findBy: jest.Mock };
  let execRepo: { create: jest.Mock; save: jest.Mock };
  let taskQueue: { add: jest.Mock };
  // 捕获发往执行器的 HTTP 载荷
  let postedPayload: any;
  let cryptoWithKey: SecretsCryptoService;

  const makeExecutor = (overrides: Record<string, unknown> = {}) =>
    ({
      id: "exec-1",
      appName: "node-1",
      address: "10.0.0.9:3002",
      status: "online",
      maxConcurrentTasks: 4,
      runningTaskCount: 0,
      cpuUsage: 0,
      memUsage: 0,
      version: 0,
      capabilities: ["node"],
      ...overrides,
    }) as any;

  const makeTask = (secrets: Record<string, unknown> | null) =>
    ({
      id: "t1",
      name: "sec-task",
      runtime: "node",
      timeout: 30,
      params: { region: "cn-north", shared: "from-params" },
      secrets,
    }) as any;

  const makeExecution = () =>
    ({
      id: "e1",
      taskId: "t1",
      // 既有派发语义：execution.params 存在时完全取代 task.params（?? 右侧
      // 不生效），因此 region 只能来自本对象；secrets 仍在其上覆盖同名键。
      params: { only: "exec-param", region: "cn-north" },
    }) as any;

  beforeEach(async () => {
    jest.clearAllMocks();
    cryptoWithKey = new SecretsCryptoService({
      get: (k: string) => (k === "secrets.key" ? HEX_KEY : undefined),
    } as any);
    executorRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    taskRepo = { findOne: jest.fn(), findBy: jest.fn() };
    execRepo = {
      create: jest.fn(),
      save: jest.fn(),
    };
    taskQueue = { add: jest.fn() };
    postedPayload = undefined;

    const module = await Test.createTestingModule({
      providers: [
        ExecutorService,
        { provide: getRepositoryToken(Executor), useValue: executorRepo },
        { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
        { provide: getRepositoryToken(Task), useValue: taskRepo },
        {
          provide: getRepositoryToken(ExecutorMetricsHistory),
          useValue: { createQueryBuilder: jest.fn() },
        },
        { provide: getQueueToken("task-queue"), useValue: taskQueue },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue("http") },
        },
        {
          provide: NotificationService,
          useValue: {
            notifyExecutorOnline: jest.fn(),
            notifyExecutorOffline: jest.fn(),
          },
        },
        {
          provide: SystemConfigService,
          useValue: { findOne: jest.fn().mockRejectedValue(new Error("nf")) },
        },
        { provide: SecretsCryptoService, useValue: cryptoWithKey },
      ],
    }).compile();
    service = module.get(ExecutorService);

    // Mock axios：捕获载荷并返回 200（与 executor.service.spec 同一 mock 模式）
    mockedAxios.post.mockImplementation(async (_url: string, payload: any) => {
      postedPayload = payload;
      return { data: { ok: true } };
    });

    // 占坑 UPDATE 成功
    executorRepo.createQueryBuilder.mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    });
    executorRepo.findOne.mockResolvedValue(makeExecutor());
    executorRepo.find.mockResolvedValue([makeExecutor()]);
  });

  it("dispatch 载荷 = execution.params ⊕ 解密后的 task.secrets（secrets 胜出）", async () => {
    const task = makeTask({
      API_TOKEN: "sk-live-123",
      shared: "from-secrets",
    });
    await service.dispatch(task, makeExecution());
    expect(postedPayload.params).toEqual({
      only: "exec-param",
      region: "cn-north",
      shared: "from-secrets", // secrets 覆盖同名 params
      API_TOKEN: "sk-live-123",
    });
    expect(postedPayload.params.API_TOKEN).toBe("sk-live-123");
    // 明文不入库：execution.params 原对象保持原样
    expect(makeExecution().params).not.toHaveProperty("API_TOKEN");
  });

  it("无 secrets 时载荷与既有行为一致（仅 params，零回归）", async () => {
    const task = makeTask(null);
    const exec = makeExecution();
    await service.dispatch(task, exec);
    // execution.params 存在 → 完全取代 task.params（?? 语义），零 secrets 参与。
    expect(postedPayload.params).toEqual({
      only: "exec-param",
      region: "cn-north",
    });
  });

  it("降级明文（未配 key）时 secrets 叶子原样合并进载荷", async () => {
    const plaintextCrypto = new SecretsCryptoService({
      get: () => "",
    } as any);
    (service as any).secretsCrypto = plaintextCrypto;
    const task = makeTask({ API_TOKEN: "plain-token" });
    await service.dispatch(task, makeExecution());
    // execution.params 完全取代 task.params（?? 语义），shared 仅在
    // execution.params 缺省时才来自 task.params；secrets 追加其上。
    expect(postedPayload.params).toEqual({
      only: "exec-param",
      region: "cn-north",
      API_TOKEN: "plain-token",
    });
  });

  it("解密失败（key 缺失但有密文）→ dispatch 抛错，执行失败且不派发裸载荷", async () => {
    const encryptedCrypto = new SecretsCryptoService({
      get: (k: string) => (k === "secrets.key" ? HEX_KEY : undefined),
    } as any);
    const encrypted = encryptedCrypto.encryptForStorage({
      API_TOKEN: "sk-123",
    }) as Record<string, string>;
    const task = makeTask(encrypted);
    (service as any).secretsCrypto = new SecretsCryptoService({
      get: () => "",
    } as any);
    await expect(service.dispatch(task, makeExecution())).rejects.toThrow(
      /secrets could not be decrypted/,
    );
    expect(postedPayload).toBeUndefined();
  });
});
