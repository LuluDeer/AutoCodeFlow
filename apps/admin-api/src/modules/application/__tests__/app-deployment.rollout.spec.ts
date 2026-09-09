import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { AppDeploymentService } from "../app-deployment.service";
import {
  AppDeployment,
  DeploymentStatus,
  RunMode,
} from "../entities/app-deployment.entity";
import { ApplicationVersion } from "../entities/application-version.entity";
import { ApplicationService } from "../application.service";
import { ExecutorService } from "../../executor/executor.service";
import { RolloutState } from "../entities/app-deployment.entity";

// Mock axios（既有套件同约定：无真实 HTTP）。
jest.mock("axios", () => ({
  __esModule: true,
  default: {
    post: jest.fn().mockResolvedValue({ data: {} }),
    get: jest.fn().mockResolvedValue({ status: 200 }),
  },
}));
import axios from "axios";
const mockAxiosGet = axios.get as jest.Mock;
const mockAxiosPost = axios.post as jest.Mock;

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

/** 行工厂：rolloutState 可注入。 */
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

describe("AppDeploymentService rollout（DEP-02/DEP-03）", () => {
  let service: AppDeploymentService;
  let repo: ReturnType<typeof makeRepo>;
  let versionRepo: ReturnType<typeof makeRepo>;
  let appService: any;
  let executorService: any;

  beforeEach(async () => {
    repo = makeRepo();
    versionRepo = makeRepo();
    appService = {
      findById: jest.fn().mockResolvedValue(mockApp),
      findByIdRaw: jest.fn().mockResolvedValue(mockApp),
      update: jest.fn(),
      maskEnvForRead: jest.fn((env: any) => env),
      maskReadSurface: jest.fn((app: any) => app),
    };
    executorService = {
      findOne: jest.fn(),
      // 对齐真实 getExecutorUrl：裸 host:port 补 http:// scheme
      getExecutorUrl: jest.fn(
        (addr: string, p: string) =>
          `${addr.startsWith("http://") || addr.startsWith("https://") ? "" : "http://"}${addr}/${p}`,
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
          useValue: versionRepo,
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
    mockAxiosPost.mockClear().mockResolvedValue({ data: {} });
    mockAxiosGet.mockClear().mockResolvedValue({ status: 200 });
    mockedLookup.mockReset();
    mockedLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  afterEach(async () => {
    service.onModuleDestroy();
  });

  describe("upgradeAllWithRollout：all 模式零破坏", () => {
    it("缺省（无 rollout）：既有全量语义——逐台 upgrade、不落 rolloutState、无批次残留", async () => {
      const deployments = [row("d1"), row("d2")];
      repo.find.mockResolvedValue(deployments);
      const upSpy = jest
        .spyOn(service, "upgrade")
        .mockResolvedValue(deployments[0]);

      const result = await service.upgradeAllWithRollout("app-1", null);

      expect(result).toEqual({ ok: true, total: 2, succeeded: 2, failed: 0 });
      expect(result.rollout).toBeUndefined();
      expect(upSpy).toHaveBeenCalledTimes(2);
      // FEAT-20: 无触发上下文时 upgrade 以 ("d1", undefined) 调用（零破坏）
      expect(upSpy).toHaveBeenCalledWith("d1", undefined);
      // 无 rolloutState 写入
      const rolloutSaves = repo.save.mock.calls.filter(
        ([e]: any[]) => e.rolloutState !== undefined && e.rolloutState !== null,
      );
      expect(rolloutSaves).toHaveLength(0);
    });

    it("strategy='all' 显式传入：同样走既有全量路径", async () => {
      const deployments = [row("d1")];
      repo.find.mockResolvedValue(deployments);
      const upSpy = jest
        .spyOn(service, "upgrade")
        .mockResolvedValue(deployments[0]);
      const result = await service.upgradeAllWithRollout("app-1", {
        strategy: "all",
      });
      expect(result.ok).toBe(true);
      expect(upSpy).toHaveBeenCalledTimes(1);
    });

    it("0 台 RUNNING + canary：回退全量路径（空升级），不建批次", async () => {
      repo.find.mockResolvedValue([]);
      const result = await service.upgradeAllWithRollout("app-1", {
        strategy: "canary",
      });
      expect(result).toEqual({ ok: true, total: 0, succeeded: 0, failed: 0 });
    });
  });

  describe("upgradeAllWithRollout：canary 分台", () => {
    it("3 台 34% → 首批 2 台（ceil）、promotion 1 台；首批行落 rolloutState=pending + 批次 meta", async () => {
      const deployments = [row("d1"), row("d2"), row("d3")];
      repo.find.mockResolvedValue(deployments);
      // markRolloutState 走 repo.findOne；upgrade 用 spy 截停
      repo.findOne.mockImplementation(
        async ({ where }: any) =>
          deployments.find((d) => d.id === where.id) ?? null,
      );
      const upSpy = jest
        .spyOn(service, "upgrade")
        .mockResolvedValue(deployments[0]);

      const result = await service.upgradeAllWithRollout("app-1", {
        strategy: "canary",
        percentage: 34,
      });

      expect(result.ok).toBe(true);
      expect(result.rollout?.canaryIds).toEqual(["d1", "d2"]);
      expect(result.rollout?.promotedIds).toEqual(["d3"]);
      expect(upSpy).toHaveBeenCalledTimes(2); // 仅首批
      expect(upSpy).not.toHaveBeenCalledWith("d3");
      // 首批两行 pending
      const pendingRows = repo.save.mock.calls
        .map(([e]: any[]) => e)
        .filter((e: any) => e.rolloutState === RolloutState.PENDING);
      expect(pendingRows.map((r: any) => r.id)).toEqual(["d1", "d2"]);
      expect(pendingRows[0].rolloutMeta.batchId).toMatch(/^rollout-/);
      expect(pendingRows[0].rolloutMeta.percentage).toBe(34);
    });

    it("1 台 + canary：首批=该台，promotion 空（探测通过即收尾）", async () => {
      const deployments = [row("d1")];
      repo.find.mockResolvedValue(deployments);
      repo.findOne.mockResolvedValue(deployments[0]);
      const upSpy = jest
        .spyOn(service, "upgrade")
        .mockResolvedValue(deployments[0]);
      const result = await service.upgradeAllWithRollout("app-1", {
        strategy: "canary",
        percentage: 1,
      });
      expect(result.rollout?.canaryIds).toEqual(["d1"]);
      expect(result.rollout?.promotedIds).toEqual([]);
      expect(upSpy).toHaveBeenCalledTimes(1);
    });

    it("canary 首批 upgrade 抛错：批次立即失败（ok=false），行落 FAILED", async () => {
      const deployments = [row("d1"), row("d2")];
      repo.find.mockResolvedValue(deployments);
      repo.findOne.mockResolvedValue(deployments[0]);
      jest
        .spyOn(service, "upgrade")
        .mockRejectedValueOnce(new Error("executor unreachable"));

      const result = await service.upgradeAllWithRollout("app-1", {
        strategy: "canary",
        percentage: 50,
      });

      expect(result.ok).toBe(false);
      expect(result.failed).toBe(1);
      const failedRows = repo.save.mock.calls
        .map(([e]: any[]) => e)
        .filter((e: any) => e.rolloutState === RolloutState.FAILED);
      expect(failedRows.length).toBeGreaterThanOrEqual(1);
      expect(failedRows.some((r: any) => r.id === "d1")).toBe(true);
      expect(failedRows[0].rolloutMeta.failureReason).toContain(
        "upgrade trigger failed",
      );
    });
  });

  describe("健康探测（DEP-03）", () => {
    it("buildProbeUrl：manifest port 优先；缺省回退执行器地址端口；host:port 与 http 前缀两形态", () => {
      expect(service.buildProbeUrl("http://exec:3001", 8080, "/health")).toBe(
        "http://exec:8080/health",
      );
      expect(service.buildProbeUrl("http://exec:3001", null, "/h")).toBe(
        "http://exec:3001/h",
      );
      expect(service.buildProbeUrl("10.0.0.3:3001", null, "/h")).toBe(
        "http://10.0.0.3:3001/h",
      );
      expect(service.buildProbeUrl("10.0.0.3:3001", 9000, "/h")).toBe(
        "http://10.0.0.3:9000/h",
      );
      expect(service.buildProbeUrl("no-port-host", null, "/h")).toBe(
        "http://no-port-host/h",
      );
      expect(service.buildProbeUrl("[::1]:3001", null, "/h")).toBe(
        "http://[::1]:3001/h",
      );
      // 全文本裸 IPv6（无括号）在 host:port 形态下与多冒号歧义（::1:3001
      // 无法可靠切分 host/port），一律拒绝——与 validateExecutorAddress
      // 的保守姿态一致；带括号形态见上。
      expect(service.buildProbeUrl("::1:3001", null, "/h")).toBeNull();
      expect(service.buildProbeUrl("", null, "/h")).toBeNull();
    });

    it("探测成功（首尝试 200）→ promoteRest 触发其余台 upgrade", async () => {
      const deployments = [row("d1"), row("d2")];
      // findRunningByApp → 后续 rolloutTick rows / 心跳读行全走本实现
      repo.find.mockImplementation(async ({ where }: any) => {
        if (where && "rolloutState" in where) return []; // restart sweep 等
        return deployments;
      });
      repo.findOne.mockImplementation(
        async ({ where }: any) =>
          deployments.find((d) => d.id === where.id) ?? null,
      );
      const upSpy = jest
        .spyOn(service, "upgrade")
        .mockResolvedValue(deployments[0]);
      mockApp.manifest = { healthCheck: { path: "/health", port: 8080 } };
      mockAxiosGet.mockResolvedValue({ status: 200 });

      await service.upgradeAllWithRollout("app-1", {
        strategy: "canary",
        percentage: 50,
      });
      // 心跳确认 RUNNING（探测由 notifyHeartbeatToRollout 触发）
      await service.handleHeartbeat({
        deploymentId: "d1",
        status: "running",
      } as any);
      await new Promise((r) => setTimeout(r, 50));

      expect(mockAxiosGet).toHaveBeenCalledWith(
        "http://executor-1:8080/health",
        expect.objectContaining({ maxRedirects: 0 }),
      );
      expect(upSpy).toHaveBeenCalledWith("d2"); // promotion
      // 批次收尾（promotedIds 心跳确认后才清——这里 promote 轮 upgrade 已触发）
      delete mockApp.manifest;
    }, 15000);

    it("failThreshold 重试窗：失败 2 次后第 3 次成功（failThreshold=3）", async () => {
      const deployments = [row("d1")]; // 单台：promotion 空集，仅验证重试
      repo.find.mockImplementation(async ({ where }: any) => {
        if (where && "rolloutState" in where) return [];
        return deployments;
      });
      repo.findOne.mockResolvedValue(deployments[0]);
      jest.spyOn(service, "upgrade").mockResolvedValue(deployments[0]);
      mockApp.manifest = {
        // interval 下限 250（parseManifestHealthCheck 钳制）——两连败后第 3 次成功
        healthCheck: {
          path: "/h",
          port: 8080,
          failThreshold: 3,
          interval: 250,
        },
      };
      mockAxiosGet
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockRejectedValueOnce(new Error("timeout"))
        .mockResolvedValueOnce({ status: 200 });

      await service.upgradeAllWithRollout("app-1", {
        strategy: "canary",
        percentage: 100,
      });
      await service.handleHeartbeat({
        deploymentId: "d1",
        status: "running",
      } as any);
      await new Promise((r) => setTimeout(r, 900));

      expect(mockAxiosGet).toHaveBeenCalledTimes(3);
      // 无 promotion 台 → 批次收尾
      expect((service as any).rolloutBatches.has("app-1")).toBe(false);
      delete mockApp.manifest;
    }, 15000);

    it("failThreshold 窗口耗尽：批次失败 + 已升级台自动回滚（upgradeWithSnapshot 链）", async () => {
      // 部署行地址为 host:port 形态（validateExecutorAddress 只认该形态；
      // 与既有 app-deployment.service.spec 的 203.0.113.10:3001 夹具同约定）。
      const deployments = [
        row("d1", {
          deployedVersion: "2.0.0",
          executorAddress: "203.0.113.10:3001",
        }),
        row("d2", {
          id: "d2",
          deployedVersion: "2.0.0",
          executorAddress: "203.0.113.10:3001",
        }),
        row("d3", {
          id: "d3",
          deployedVersion: "2.0.0",
          executorAddress: "203.0.113.10:3001",
        }),
      ];
      repo.find.mockImplementation(async ({ where }: any) => {
        if (where && "rolloutState" in where) return [];
        return deployments;
      });
      repo.findOne.mockImplementation(
        async ({ where }: any) =>
          deployments.find((d) => d.id === where.id) ?? null,
      );
      jest.spyOn(service, "upgrade").mockResolvedValue(deployments[0]);
      mockApp.manifest = {
        healthCheck: {
          path: "/h",
          port: 8080,
          failThreshold: 2,
          interval: 250,
        },
      };
      mockAxiosGet.mockRejectedValue(new Error("ECONNREFUSED"));
      // 上一版本快照（released、非当前版本）
      versionRepo.find.mockResolvedValue([
        {
          id: "v-prev",
          version: "1.0.0",
          gitCommit: "old-commit",
          status: "released",
          snapshot: {
            packageUrl: "http://reg/pkg-1.0.0.zip",
            env: { NODE_ENV: "production" },
          },
        },
      ]);

      await service.upgradeAllWithRollout("app-1", {
        strategy: "canary",
        percentage: 34, // ceil(3×34%)=2 → 首批 d1+d2，promotion d3
      });
      // d1 心跳确认 RUNNING → probing → 探测窗耗尽 → failBatch（回滚 d2）
      await service.handleHeartbeat({
        deploymentId: "d1",
        status: "running",
      } as any);
      // failThreshold=2 × interval 250ms + 回滚 push 余量
      await new Promise((r) => setTimeout(r, 900));

      // 回滚 push 被触发（d2 为已升级台）——axios.post 走 upgrade 链
      expect(mockAxiosPost).toHaveBeenCalled();
      const rolledBack = repo.save.mock.calls
        .map(([e]: any[]) => e)
        .filter((e: any) => e.rolloutState === RolloutState.ROLLED_BACK);
      expect(rolledBack.map((r: any) => r.id)).toContain("d2");
      // 回滚载荷携带快照版本
      const postPayloads = mockAxiosPost.mock.calls.map(
        ([, payload]: any[]) => payload,
      );
      expect(postPayloads.some((p: any) => p.version === "1.0.0")).toBe(true);
      delete mockApp.manifest;
    }, 15000);
  });

  describe("心跳状态机（DEP-02）", () => {
    it("handleHeartbeat RUNNING：批次 canary 行推进 pending→probing；FAILED 心跳判批次失败", async () => {
      const deployments = [row("d1"), row("d2")];
      repo.find.mockResolvedValue(deployments);
      repo.findOne.mockImplementation(
        async ({ where }: any) =>
          deployments.find((d) => d.id === where.id) ?? null,
      );
      jest.spyOn(service, "upgrade").mockResolvedValue(deployments[0]);

      await service.upgradeAllWithRollout("app-1", {
        strategy: "canary",
        percentage: 50,
      });

      // d1 心跳 FAILED → failBatch
      repo.findOne.mockResolvedValueOnce(
        row("d1", { status: DeploymentStatus.UPGRADING }),
      );
      await service.handleHeartbeat({
        deploymentId: "d1",
        status: "failed",
      } as any);
      await new Promise((r) => setTimeout(r, 10));
      const failedRows = repo.save.mock.calls
        .map(([e]: any[]) => e)
        .filter((e: any) => e.rolloutState === RolloutState.FAILED);
      expect(failedRows.some((r: any) => r.id === "d1")).toBe(true);
    }, 15000);

    it("无批次（手动 upgrade）：心跳路径零 rollout 写入（现状行为）", async () => {
      repo.findOne.mockResolvedValue(
        row("d9", { status: DeploymentStatus.DEPLOYING }),
      );
      await service.handleHeartbeat({
        deploymentId: "d9",
        status: "running",
      } as any);
      const rolloutSaves = repo.save.mock.calls
        .map(([e]: any[]) => e)
        .filter((e: any) => e.rolloutState != null);
      expect(rolloutSaves).toHaveLength(0);
    });
  });

  describe("批次生命周期", () => {
    it("markInterruptedRolloutsFailed：pending/probing 行标记 failed + 原因落 meta", async () => {
      repo.find.mockResolvedValue([
        row("d1", { rolloutState: RolloutState.PENDING }),
        row("d2", { rolloutState: RolloutState.PROBING }),
      ]);
      const count = await service.markInterruptedRolloutsFailed();
      expect(count).toBe(2);
      const saved = repo.save.mock.calls.map(([e]: any[]) => e);
      expect(saved.every((e: any) => e.rolloutState === RolloutState.FAILED));
      expect(saved[0].rolloutMeta.failureReason).toContain("restarted");
      expect(saved[1].rolloutMeta.failureReason).toContain("restarted");
    });

    it("markInterruptedRolloutsFailed：无遗留行返回 0", async () => {
      repo.find.mockResolvedValue([]);
      expect(await service.markInterruptedRolloutsFailed()).toBe(0);
    });

    it("onModuleDestroy 清空批次内存态（优雅关闭）", async () => {
      const deployments = [row("d1")];
      repo.find.mockResolvedValue(deployments);
      repo.findOne.mockResolvedValue(deployments[0]);
      jest.spyOn(service, "upgrade").mockResolvedValue(deployments[0]);
      await service.upgradeAllWithRollout("app-1", {
        strategy: "canary",
        percentage: 100,
      });
      service.onModuleDestroy();
      expect((service as any).rolloutBatches.size).toBe(0);
      expect((service as any).rolloutTimers.size).toBe(0);
    }, 15000);
  });
});
