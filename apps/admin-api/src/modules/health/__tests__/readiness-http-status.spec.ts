import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { HealthController } from "../health.controller";
import { HealthService } from "../health.service";
import { Task } from "../../task/entities/task.entity";
import { Executor } from "../../executor/entities/executor.entity";
import { TaskExecution } from "../../task/entities/task-execution.entity";

/**
 * A3（DEEP_REVIEW §七 · executor-protocol）：就绪探针的 **HTTP 状态码**。
 *
 * 此前 `/api/health/ready` 恒返 200——不就绪只在 body 里写 `status:"not_ready"`。
 * 而 K8s readinessProbe 与主流 LB **只看 HTTP 状态码**，等于 DB 与 Redis 全挂了
 * 也不会被摘流量，就绪探针形同虚设。现在按契约返回 503。
 */

// ARCH-008: `on` 必须存在——HealthService 构造时会注册 redis error 监听器
// （缺它是击穿进程的根因，见 health.service.ts 内注释与 health.service.spec.ts
// 的红线用例）。mock 漏掉 `on` 会在构造期抛 "on is not a function"。
jest.mock("redis", () => ({
  createClient: jest.fn(() => ({
    isReady: true,
    connect: jest.fn().mockResolvedValue(undefined),
    ping: jest.fn().mockResolvedValue("PONG"),
    on: jest.fn(),
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

describe("HealthController.ready（A3 readiness 状态码）", () => {
  let controller: HealthController;
  let taskRepo: ReturnType<typeof makeRepoMock>;
  let res: { status: jest.Mock };
  let moduleRef: TestingModule | null = null;

  const build = async (): Promise<HealthController> => {
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        HealthService,
        { provide: getRepositoryToken(Task), useValue: taskRepo },
        { provide: getRepositoryToken(Executor), useValue: makeRepoMock() },
        {
          provide: getRepositoryToken(TaskExecution),
          useValue: makeRepoMock(),
        },
        { provide: "BullQueue_task-queue", useValue: makeQueueMock() },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((_k: string, def?: unknown) => def) },
        },
      ],
    }).compile();
    moduleRef = module;
    return module.get(HealthController);
  };

  beforeEach(async () => {
    taskRepo = makeRepoMock();
    res = { status: jest.fn() };
    controller = await build();
  });

  // 不关模块会留下未收的句柄（jest 报 "worker process failed to exit
  // gracefully"），长跑下会污染同进程的其它套件。
  afterEach(async () => {
    if (moduleRef) {
      await moduleRef.close();
      moduleRef = null;
    }
  });

  it("依赖健康时返回 200 且 payload.status = ready", async () => {
    const payload = await controller.ready(res as never);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(payload.status).toBe("ready");
    expect(payload.reason).toBeUndefined();
  });

  it("DB 不可用时必须返回 503（否则 K8s 探针永不摘流量）", async () => {
    taskRepo.query.mockRejectedValue(new Error("connection refused"));
    const payload = await controller.ready(res as never);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(payload.status).toBe("not_ready");
    // 契约：not_ready 时 reason 必须是非空字符串
    expect(typeof payload.reason).toBe("string");
    expect(payload.reason).toContain("database");
    expect(payload.checks).toEqual(
      expect.arrayContaining([{ name: "database", status: "fail" }]),
    );
  });
});
