import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { AppDeploymentService } from "../app-deployment.service";
import {
  AppDeployment,
  DeploymentStatus,
  RunMode,
  RolloutState,
} from "../entities/app-deployment.entity";
import { ApplicationVersion } from "../entities/application-version.entity";
import { ApplicationService } from "../application.service";
import { ExecutorService } from "../../executor/executor.service";

/**
 * ARCH-31：灰度批次（rollout）的多实例一致性。
 *
 * 改造前：批次只存在于接收 upgrade-all 的那个进程的内存 Map 里——
 * ① 落到别的实例上的心跳被 `if (!batch) return` 静默丢弃，批次卡死到硬超时；
 * ② 同应用可并发开两个批次（进程内判重只在单实例有效）；
 * ③ 滚动重启时新起的实例会把另一个实例正在推进的批次直接标 failed。
 */
jest.mock("axios", () => ({
  __esModule: true,
  default: {
    post: jest.fn().mockResolvedValue({ data: {} }),
    get: jest.fn().mockResolvedValue({ status: 200 }),
  },
}));
import axios from "axios";
const mockAxiosGet = axios.get as jest.Mock;

jest.mock("node:dns/promises", () => ({ lookup: jest.fn() }));
import { lookup } from "node:dns/promises";
const mockedLookup = lookup as unknown as jest.Mock;

const makeRepo = (overrides: Partial<Record<string, jest.Mock>> = {}) => ({
  find: jest.fn(),
  findOne: jest.fn(),
  findAndCount: jest.fn(),
  create: jest.fn((d: any) => ({ ...d, id: d.id ?? "deploy-1" })),
  save: jest.fn((e: any) => Promise.resolve(e)),
  ...overrides,
});

const row = (
  id: string,
  overrides: Partial<Record<string, any>> = {},
): AppDeployment =>
  ({
    id,
    applicationId: "app-1",
    executorAddress: "http://executor-1:3001",
    executorId: "exec-1",
    status: DeploymentStatus.RUNNING,
    runMode: RunMode.DAEMON,
    deployedVersion: "1.0.0",
    deployedCommit: null,
    env: null,
    rolloutState: null,
    rolloutMeta: null,
    ...overrides,
  }) as AppDeployment;

const mockApp = {
  id: "app-1",
  name: "my-app",
  gitRepo: "https://github.com/org/repo",
  gitBranch: "main",
  gitCommit: "new-commit",
  runtime: "node",
  entrypoint: "node dist/main.js",
  version: "2.0.0",
  env: { NODE_ENV: "production" },
  manifest: undefined as Record<string, any> | undefined,
};

const qbMock = (affected: number) => {
  const qb: any = {
    update: jest.fn(() => qb),
    set: jest.fn(() => qb),
    where: jest.fn(() => qb),
    andWhere: jest.fn(() => qb),
    execute: jest.fn().mockResolvedValue({ affected }),
  };
  return qb;
};

describe("AppDeploymentService rollout — ARCH-31 多实例一致性", () => {
  let service: AppDeploymentService;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(async () => {
    repo = makeRepo();
    const appService = {
      findById: jest.fn().mockResolvedValue(mockApp),
      findByIdRaw: jest.fn().mockResolvedValue(mockApp),
      update: jest.fn(),
      maskEnvForRead: jest.fn((env: any) => env),
      maskReadSurface: jest.fn((app: any) => app),
    };
    const executorService = {
      findOne: jest.fn(),
      getExecutorUrl: jest.fn(
        (addr: string, p: string) =>
          `${addr.startsWith("http://") ? "" : "http://"}${addr}/${p}`,
      ),
      getSharedToken: jest.fn().mockResolvedValue("tok"),
      selectLeastLoaded: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        AppDeploymentService,
        { provide: getRepositoryToken(AppDeployment), useValue: repo },
        {
          provide: getRepositoryToken(ApplicationVersion),
          useValue: makeRepo(),
        },
        { provide: ApplicationService, useValue: appService },
        { provide: ExecutorService, useValue: executorService },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(undefined) },
        },
      ],
    }).compile();

    service = module.get(AppDeploymentService);
    mockAxiosGet.mockClear().mockResolvedValue({ status: 200 });
    mockedLookup.mockReset();
    mockedLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    mockApp.manifest = undefined;
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it("非持有实例收到心跳：从 DB 痕迹重建批次上下文并把行推进 probing（此前被静默丢弃）", async () => {
    const d = row("d1", {
      rolloutState: RolloutState.PENDING,
      rolloutMeta: { batchId: "batch-remote", role: "canary", percentage: 50 },
    });
    repo.find.mockResolvedValue([d]);
    repo.findOne.mockResolvedValue(d);

    // 本实例内存里没有该应用的批次（模拟心跳落在另一个实例）
    expect((service as any).rolloutBatches.has("app-1")).toBe(false);

    await (service as any).notifyHeartbeatToRollout(d);

    const saved = repo.save.mock.calls.map(([e]: any[]) => e);
    const probed = saved.filter(
      (e: any) => e.rolloutState === RolloutState.PROBING,
    );
    expect(probed).toHaveLength(1);
    expect(probed[0].id).toBe("d1");
    expect(probed[0].rolloutMeta.batchId).toBe("batch-remote");
  });

  it("hydrated（非持有）上下文不驱动健康探测——探测只由批次持有实例发起", async () => {
    mockApp.manifest = { healthCheck: { path: "/health", port: 8080 } };
    const d = row("d1", {
      rolloutState: RolloutState.PENDING,
      rolloutMeta: { batchId: "batch-remote", role: "canary" },
    });
    repo.find.mockResolvedValue([d]);
    repo.findOne.mockResolvedValue(d);

    await (service as any).notifyHeartbeatToRollout(d);
    await new Promise((r) => setTimeout(r, 50));

    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  it("无任何批次痕迹的行不触发额外的 DB 往返（心跳是高频路径）", async () => {
    repo.find.mockClear();
    const plain = row("d1");
    await (service as any).resolveRolloutBatch("app-1", plain);
    expect(repo.find).not.toHaveBeenCalled();
  });

  it("并发批次守卫：同应用已有在途行 → 拒绝新批次（ok=false + blockedReason），不触发 upgrade", async () => {
    repo.find.mockResolvedValue([
      row("d1"),
      row("d2", {
        rolloutState: RolloutState.PENDING,
        rolloutMeta: { batchId: "batch-other", leasedBy: "admin:42" },
      }),
    ]);
    const upSpy = jest
      .spyOn(service, "upgrade")
      .mockResolvedValue(row("d1") as any);

    const res = await service.upgradeAllWithRollout("app-1", {
      strategy: "canary",
      percentage: 50,
    });

    expect(res.ok).toBe(false);
    expect(res.rollout?.blockedReason).toContain(
      "another rollout batch is in flight",
    );
    expect(res.rollout?.blockedReason).toContain("admin:42");
    expect(upSpy).not.toHaveBeenCalled();
    expect((service as any).rolloutBatches.has("app-1")).toBe(false);
  });

  it("失败终结的 claim：未抢到在途行 → 跳过重复回滚", async () => {
    const qb = qbMock(0);
    (repo as any).createQueryBuilder = jest.fn(() => qb);
    const rollback = jest
      .spyOn(service, "rollbackDeploymentToPrevious")
      .mockResolvedValue(row("d2") as any);
    repo.findOne.mockResolvedValue(row("d2"));

    await (service as any).failBatch(
      {
        batchId: "batch-x",
        applicationId: "app-1",
        strategy: "canary",
        percentage: 50,
        healthCheck: null,
        upgradedIds: ["d1", "d2"],
        promotedIds: [],
        startedAt: Date.now(),
        timer: null,
        tickTimer: null,
      },
      "d1",
      "heartbeat reported failed",
    );

    expect(rollback).not.toHaveBeenCalled();
  });

  it("失败终结的 claim：抢到在途行 → 正常执行自动回滚", async () => {
    const qb = qbMock(1);
    (repo as any).createQueryBuilder = jest.fn(() => qb);
    const rollback = jest
      .spyOn(service, "rollbackDeploymentToPrevious")
      .mockResolvedValue(row("d2") as any);
    repo.findOne.mockResolvedValue(row("d2"));

    await (service as any).failBatch(
      {
        batchId: "batch-x",
        applicationId: "app-1",
        strategy: "canary",
        percentage: 50,
        healthCheck: null,
        upgradedIds: ["d1", "d2"],
        promotedIds: [],
        startedAt: Date.now(),
        timer: null,
        tickTimer: null,
      },
      "d1",
      "heartbeat reported failed",
    );

    expect(rollback).toHaveBeenCalledWith("d2", expect.anything());
  });

  it("重启 sweep 跳过租约新鲜的在途行（滚动重启不再打断另一个实例的灰度）", async () => {
    const fresh = row("d1", {
      rolloutState: RolloutState.PENDING,
      rolloutMeta: {
        batchId: "batch-live",
        leasedAt: new Date().toISOString(),
        leasedBy: "admin:7",
      },
    });
    const orphan = row("d2", {
      rolloutState: RolloutState.PROBING,
      rolloutMeta: {
        batchId: "batch-dead",
        leasedAt: "2020-01-01T00:00:00.000Z",
      },
    });
    repo.find.mockResolvedValue([fresh, orphan]);

    const n = await service.markInterruptedRolloutsFailed();

    expect(n).toBe(1);
    const saved = repo.save.mock.calls.map(([e]: any[]) => e);
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe("d2");
    expect(saved[0].rolloutState).toBe(RolloutState.FAILED);
  });
});
