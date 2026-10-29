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
// ARCH-33（ADR-016）：控制面 pull 通道的测试替身（默认 push）
import { controlPlaneMocks } from "../../../common/testing/control-plane-mocks";
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
  // E-P1-R2：心跳走 repo.update 条件 UPDATE（不经 save）。
  update: jest.fn().mockResolvedValue({ affected: 1 }),
  // O-1/O-5: 批量 UPDATE 走 createQueryBuilder().update().set().where().execute()
  // 链（scheduler spec 同款链式 mock）。默认 execute 返回 affected=1。
  createQueryBuilder: jest.fn(() => ({
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    // ADR-026：批量状态写要带「源状态」谓词并用 RETURNING 计数（E-P1-R3 同款）。
    andWhere: jest.fn().mockReturnThis(),
    returning: jest.fn().mockReturnThis(),
    execute: jest
      .fn()
      .mockResolvedValue({ affected: 1, raw: [{ id: "d1" }, { id: "d2" }] }),
  })),
  ...overrides,
});

/**
 * R50：markRolloutState 从整行 save 改为**列级 update**（ADR-026 规则 4）。
 * 「谁被持久化成什么」现在要从 **update 的 patch** 读——把 `where.id` 与 patch 合并成
 * 与旧断言同形的行对象，断言口径不变（只读 save 的实参会漏掉这些行）。
 */
const persisted = (repo: any): any[] => [
  ...repo.save.mock.calls.map(([e]: any[]) => e),
  ...repo.update.mock.calls.map(([w, p]: any[]) => ({ ...w, ...p })),
];
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

/**
 * NETOPT-5⑦: fake timers 有界泵进——按被测真实节奏（interval 钳制下限
 * 250ms）逐段推进探测窗直到条件满足（或步数耗尽，交由后续显式断言给出
 * 可读失败）。消掉此前「900ms 真实预算赌 CI 空闲」的时长赌注：探测窗
 * 不再依赖墙钟，负载下零假红。
 */
async function pumpUntil(
  condition: () => boolean,
  stepMs = 250,
  maxSteps = 12,
): Promise<void> {
  for (let i = 0; i < maxSteps && !condition(); i++) {
    await jest.advanceTimersByTimeAsync(stepMs);
  }
  // 收尾刷一次微任务（promoteRest / failBatch 的尾段）
  await jest.advanceTimersByTimeAsync(0);
}

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
      // ARCH-33（ADR-016）：默认 push（本 spec 验证 push/rollout 语义）
      ...controlPlaneMocks(),
    } as unknown as typeof executorService;

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

      // R2 §4.4：既有四键形状不变，只**增** coverage/skipped（daemon 行全
      // 落 running 组）。
      expect(result).toEqual({
        ok: true,
        total: 2,
        succeeded: 2,
        failed: 0,
        coverage: {
          running: 2,
          scheduled: 0,
          stopped: 0,
          failed: 0,
          inFlight: 0,
        },
        skipped: [],
      });
      expect(result.rollout).toBeUndefined();
      expect(upSpy).toHaveBeenCalledTimes(2);
      // FEAT-20: 无触发上下文时 upgrade 以 ("d1", undefined) 调用（零破坏）
      expect(upSpy).toHaveBeenCalledWith("d1", undefined);
      // 无 rolloutState 写入
      const rolloutSaves = persisted(repo).filter(
        (e: any) => e.rolloutState !== undefined && e.rolloutState !== null,
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
      expect(result).toEqual({
        ok: true,
        total: 0,
        succeeded: 0,
        failed: 0,
        coverage: {
          running: 0,
          scheduled: 0,
          stopped: 0,
          failed: 0,
          inFlight: 0,
        },
        skipped: [],
      });
    });
  });

  // R2（部署模型评审 §4.4/§9.4，2026-10-24）：upgrade-all 覆盖面显式化——
  // 默认 = 全部 RUNNING 行（scheduled「仅部署」行实证稳态即 RUNNING，见
  // service 方法头注释）；stopped 显式 opt-in；在途行跳过进 skipped 明细。
  describe("upgradeAllWithRollout：R2 覆盖面分组（§4.4）", () => {
    const mixedRows = (): AppDeployment[] => [
      row("d-daemon", { executorId: "exec-a" }),
      row("d-sched", {
        executorId: "exec-b",
        runMode: RunMode.SCHEDULED,
      }),
      row("d-stopped", {
        executorId: "exec-c",
        status: DeploymentStatus.STOPPED,
      }),
      row("d-failed", {
        executorId: "exec-d",
        status: DeploymentStatus.FAILED,
      }),
      row("d-deploying", {
        executorId: "exec-e",
        status: DeploymentStatus.DEPLOYING,
      }),
      row("d-upgrading", {
        executorId: "exec-f",
        status: DeploymentStatus.UPGRADING,
      }),
      row("d-approval", {
        executorId: "exec-g",
        status: DeploymentStatus.PENDING,
        approvalStatus: "pending_approval" as any,
      }),
    ];

    it("缺省：只升级 RUNNING（daemon+scheduled），stopped/failed 排除，在途行进 skipped 明细（待审批单独归因）", async () => {
      repo.find.mockResolvedValue(mixedRows());
      const upSpy = jest
        .spyOn(service, "upgrade")
        .mockImplementation(async (id: string) => row(id));

      const result = await service.upgradeAllWithRollout("app-1", null);

      expect(result.coverage).toEqual({
        running: 1,
        scheduled: 1,
        stopped: 1,
        failed: 1,
        inFlight: 3,
      });
      // 默认覆盖 = running + scheduled = 2 台
      expect(upSpy).toHaveBeenCalledTimes(2);
      expect(upSpy).toHaveBeenCalledWith("d-daemon", undefined);
      expect(upSpy).toHaveBeenCalledWith("d-sched", undefined);
      // stopped/failed 不触发 upgrade
      expect(upSpy).not.toHaveBeenCalledWith("d-stopped", expect.anything());
      expect(upSpy).not.toHaveBeenCalledWith("d-failed", expect.anything());
      // 在途 3 行全部进 skipped；待审批行单独归因
      expect(result.skipped).toEqual([
        {
          deploymentId: "d-deploying",
          executorId: "exec-e",
          status: "deploying",
          reason: "in_flight",
        },
        {
          deploymentId: "d-upgrading",
          executorId: "exec-f",
          status: "upgrading",
          reason: "in_flight",
        },
        {
          deploymentId: "d-approval",
          executorId: "exec-g",
          status: "pending",
          reason: "awaiting_approval",
        },
      ]);
      expect(result.total).toBe(2);
    });

    it("includeStopped=true：stopped 行纳入升级（total 相应扩大），failed 仍排除", async () => {
      repo.find.mockResolvedValue(mixedRows());
      const upSpy = jest
        .spyOn(service, "upgrade")
        .mockImplementation(async (id: string) => row(id));

      const result = await service.upgradeAllWithRollout(
        "app-1",
        null,
        undefined,
        undefined,
        true,
      );

      expect(upSpy).toHaveBeenCalledWith("d-stopped", undefined);
      expect(upSpy).not.toHaveBeenCalledWith("d-failed", expect.anything());
      expect(result.total).toBe(3);
      expect(result.coverage.stopped).toBe(1);
    });

    it("canary + includeStopped=true：灰度集合维持全部 RUNNING 口径（stopped 不进批次），形状不变", async () => {
      repo.find.mockResolvedValue(mixedRows());
      // markRolloutState 走 repo.findOne；upgrade 用 spy 截停
      repo.findOne.mockImplementation(async ({ where }: any) => {
        const rows = mixedRows();
        return rows.find((d) => d.id === where.id) ?? null;
      });
      const upSpy = jest
        .spyOn(service, "upgrade")
        .mockImplementation(async (id: string) => row(id));

      const result = await service.upgradeAllWithRollout(
        "app-1",
        { strategy: "canary", percentage: 100 },
        undefined,
        undefined,
        true,
      );

      // canary 批次集合 = 2 台 RUNNING（daemon+scheduled），stopped 不扩入
      expect(result.rollout).toMatchObject({
        strategy: "canary",
        canaryIds: ["d-daemon", "d-sched"],
        promotedIds: [],
      });
      expect(upSpy).not.toHaveBeenCalledWith("d-stopped", expect.anything());
      // 分组回显仍如实携带 stopped 计数与 skipped 明细
      expect(result.coverage.stopped).toBe(1);
      expect(result.skipped).toHaveLength(3);
    });

    it("canary 空集回退 + includeStopped=true：仍空升级（canary 忽略该参数零例外，不偷扩覆盖）", async () => {
      const rows = [
        row("d-stopped", {
          executorId: "exec-c",
          status: DeploymentStatus.STOPPED,
        }),
      ];
      repo.find.mockResolvedValue(rows);
      const upSpy = jest
        .spyOn(service, "upgrade")
        .mockImplementation(async (id: string) => row(id));

      const result = await service.upgradeAllWithRollout(
        "app-1",
        { strategy: "canary" },
        undefined,
        undefined,
        true,
      );

      expect(upSpy).not.toHaveBeenCalled();
      expect(result.total).toBe(0);
      expect(result.coverage.stopped).toBe(1);
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
      const pendingRows = persisted(repo).filter(
        (e: any) => e.rolloutState === RolloutState.PENDING,
      );
      expect(pendingRows.map((r: any) => r.id)).toEqual(["d1", "d2"]);
      // R50：批次痕迹必须走**列级写**——整行 save 会用本方法读到的快照覆盖并发的
      // status/statusMessage（心跳推进终态、管理员停止）。这条断言把「不许整行写」钉住。
      expect(
        repo.save.mock.calls.some(
          ([e]: any[]) => e.rolloutState === RolloutState.PENDING,
        ),
      ).toBe(false);
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
      const failedRows = persisted(repo).filter(
        (e: any) => e.rolloutState === RolloutState.FAILED,
      );
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
      // NETOPT-5⑦: fake timers 逐段泵进探测窗（真实节奏 waitMs(250)×2），
      // 不再赌真实 900ms 预算在 CI 负载下足够。
      jest.useFakeTimers();
      try {
        await service.handleHeartbeat({
          deploymentId: "d1",
          status: "running",
        } as any);
        await pumpUntil(() => mockAxiosGet.mock.calls.length >= 3);
        await pumpUntil(() => !(service as any).rolloutBatches.has("app-1"));
      } finally {
        jest.useRealTimers();
      }

      expect(mockAxiosGet).toHaveBeenCalledTimes(3);
      // 无 promotion 台 → 批次收尾
      expect((service as any).rolloutBatches.has("app-1")).toBe(false);
      delete mockApp.manifest;
    }, 15000);

    it("R-07: 探针 URL 过 SSRF 策略——地址解析到 link-local 云元数据即拒绝且不发出请求（fail-closed）", async () => {
      const deployments = [row("d1"), row("d2")];
      repo.find.mockImplementation(async ({ where }: any) => {
        if (where && "rolloutState" in where) return [];
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
      // 执行器地址由执行器自报（register/heartbeat 可注入）——解析到云元数据
      mockedLookup.mockResolvedValue([
        { address: "169.254.169.254", family: 4 },
      ]);

      await service.upgradeAllWithRollout("app-1", {
        strategy: "canary",
        percentage: 50,
      });
      await service.handleHeartbeat({
        deploymentId: "d1",
        status: "running",
      } as any);
      await new Promise((r) => setTimeout(r, 100));

      // 盲探被拦：出站 GET 根本没发出（此前会真的打过去拿 2xx-4xx 当"端口活体"）
      expect(mockAxiosGet).not.toHaveBeenCalled();
      // fail-closed：canary 台判失败，不提升其余台
      expect(upSpy).not.toHaveBeenCalledWith("d2");
      const failedRows = persisted(repo).filter(
        (e: any) => e.id === "d1" && e.rolloutState === RolloutState.FAILED,
      );
      // save 收到的是同一被就地改写的行对象，故按 ≥1 断言（存在即已落 FAILED）。
      expect(failedRows.length).toBeGreaterThanOrEqual(1);
      expect(failedRows[0].rolloutMeta?.failureReason).toContain(
        "health probe URL refused",
      );
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
      // NETOPT-5⑦: fake timers 逐段泵进（failThreshold=2 × interval 250ms），
      // 条件为「回滚 push 已发出」，消掉真实 900ms 预算的时长赌注。
      jest.useFakeTimers();
      try {
        await service.handleHeartbeat({
          deploymentId: "d1",
          status: "running",
        } as any);
        await pumpUntil(() => mockAxiosPost.mock.calls.length > 0);
      } finally {
        jest.useRealTimers();
      }

      // 回滚 push 被触发（d2 为已升级台）——axios.post 走 upgrade 链
      expect(mockAxiosPost).toHaveBeenCalled();
      const rolledBack = persisted(repo).filter(
        (e: any) => e.rolloutState === RolloutState.ROLLED_BACK,
      );
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
      const failedRows = persisted(repo).filter(
        (e: any) => e.rolloutState === RolloutState.FAILED,
      );
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
      const rolloutSaves = persisted(repo).filter(
        (e: any) => e.rolloutState != null,
      );
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
      // O-1: 单条批量 UPDATE 覆盖全部 orphaned 行（不再逐行 repo.save）
      expect(repo.save).not.toHaveBeenCalled();
      const qb = repo.createQueryBuilder.mock.results[0].value;
      expect(qb.execute).toHaveBeenCalledTimes(1);
      const setArg = qb.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.rolloutState).toBe(RolloutState.FAILED);
      // rolloutMeta 用 jsonb || 在 SQL 内合并 failureReason（保留各行原 meta）
      expect(String(setArg.rolloutMeta)).toContain('"failureReason"');
      expect(String(setArg.rolloutMeta)).toContain("restarted");
      const whereArg = qb.where.mock.calls[0][1] as { ids: string[] };
      expect(new Set(whereArg.ids)).toEqual(new Set(["d1", "d2"]));
      // ADR-026（T2 守卫抓到的真实违规）：find 与 update 之间别的实例可能已把行
      // 推进出 pending/probing——按 id 盲写会把「已成功」盖回 failed。必须带源状态
      // 谓词，并用 RETURNING 精确计数（返回的是真正标记的行数，不是快照长度）。
      const andWhereArg = qb.andWhere.mock.calls[0] as [
        string,
        { expected: string[] },
      ];
      expect(andWhereArg[0]).toContain("rolloutState");
      expect(new Set(andWhereArg[1].expected)).toEqual(
        new Set([RolloutState.PENDING, RolloutState.PROBING]),
      );
      expect(qb.returning).toHaveBeenCalledWith("id");
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

  // NETOPT-1①: rolloutTick / probeDeployment 以 `void` fire-and-forget 运行，
  // 顶层必须有兜底 catch——否则瞬时 DB 抖动以 unhandledRejection 冒泡到
  // main.ts 的 process.on → gracefulFatalShutdown → 整实例退出。
  describe("NETOPT-1①: fire-and-forget tick/探测的顶层兜底（unhandledRejection 防线）", () => {
    const seedBatch = (overrides: Record<string, any> = {}) => {
      const batch = {
        batchId: "rollout-netopt1",
        applicationId: "app-1",
        strategy: "canary" as const,
        percentage: 34,
        healthCheck: null,
        upgradedIds: ["d1"],
        promotedIds: [] as string[],
        startedAt: Date.now(),
        timer: null,
        tickTimer: null,
        ...overrides,
      };
      (service as any).rolloutBatches.set("app-1", batch);
      return batch;
    };

    it("rolloutTick：repo.find 拒绝 → 方法正常 resolve 不外抛，批次保留并续排下一 tick", async () => {
      const batch = seedBatch();
      const errSpy = jest
        .spyOn((service as any).logger, "error")
        .mockImplementation(() => {});
      repo.find.mockRejectedValue(new Error("transient db down"));

      // 缺陷形态（无兜底）：此调用会 reject → void 前缀下成为
      // unhandledRejection → main.ts gracefulFatalShutdown 整实例退出。
      await expect(
        (service as any).rolloutTick("app-1"),
      ).resolves.toBeUndefined();

      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("transient db down"),
      );
      // 批次状态保持（不改行级状态、不误判失败），留待下一 tick 重试。
      expect((service as any).rolloutBatches.has("app-1")).toBe(true);
      expect(batch.tickTimer).not.toBeNull();
      // 续排的 timer 已登记，onModuleDestroy（afterEach）可统一清理。
      expect((service as any).rolloutTimers.has(batch.tickTimer)).toBe(true);
    });

    it("rolloutTick：批次已被 failBatch 收尾删除后出错 → 不续排僵尸 tick", async () => {
      seedBatch();
      jest.spyOn((service as any).logger, "error").mockImplementation(() => {});
      repo.find.mockRejectedValue(new Error("db down"));
      // 模拟错误发生前批次已被收尾删除（failBatch 会 delete rolloutBatches）
      const inner = (service as any).rolloutTickInner.bind(service);
      (service as any).rolloutTickInner = async (appId: string) => {
        (service as any).rolloutBatches.delete(appId);
        await inner(appId);
      };

      await expect(
        (service as any).rolloutTick("app-1"),
      ).resolves.toBeUndefined();
      expect((service as any).rolloutBatches.has("app-1")).toBe(false);
      // 批次已不在内存 → catch 分支不得续排（无批次可推进）
      const seeded = (service as any).rolloutBatches.get("app-1");
      expect(seeded).toBeUndefined();
    });

    it("probeDeployment：探测链路拒绝 → 方法正常 resolve 不外抛，批次状态不推进", async () => {
      const batch = seedBatch({
        healthCheck: {
          path: "/health",
          port: 3001,
          interval: 100,
          failThreshold: 1,
          timeoutMs: 100,
        },
      });
      const errSpy = jest
        .spyOn((service as any).logger, "error")
        .mockImplementation(() => {});
      // findByIdRaw 需要拿到行（否则走 "deployment row vanished" 失败路径）
      repo.findOne.mockResolvedValue(row("d1"));
      // probeOnce 内部任何重抛（探测/HTTP 层异常）此前会经 void 前缀
      // 变成 unhandledRejection；以 mock 直接模拟该重抛形态。
      (service as any).probeOnce = jest
        .fn()
        .mockRejectedValue(new Error("probe layer blew up"));

      await expect(
        (service as any).probeDeployment(batch, "d1"),
      ).resolves.toBeUndefined();

      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("probe layer blew up"),
      );
      // 不推进批次状态：批次仍在内存、行级收尾交给 tick 硬超时兜底。
      expect((service as any).rolloutBatches.has("app-1")).toBe(true);
    });
  });

  describe("upgradeAllWithRollout：版本定向灰度（渐进回滚，2026-10-07 立项）", () => {
    const versionRow = {
      id: "ver-1",
      applicationId: "app-1",
      version: "1.9.0",
      status: "released",
      gitCommit: "old-commit",
      snapshot: {
        packageUrl: "http://host/uploads/old.zip",
        entrypoint: "node old.js",
        env: { FOO: "old" },
      },
    };

    it("缺省（无 version）：零变化——不查 versionRepo、不恢复快照", async () => {
      const deployments = [row("d1")];
      repo.find.mockResolvedValue(deployments);
      const findOne = jest.spyOn(versionRepo, "findOne");
      const upSpy = jest
        .spyOn(service, "upgrade")
        .mockResolvedValue(deployments[0]);

      const result = await service.upgradeAllWithRollout("app-1", null);

      expect(result.ok).toBe(true);
      expect(result.version).toBeUndefined();
      expect(findOne).not.toHaveBeenCalled();
      expect(appService.update).not.toHaveBeenCalled();
      expect(upSpy).toHaveBeenCalledTimes(1);
    });

    it("version 指向不存在版本 → 400", async () => {
      versionRepo.findOne.mockResolvedValue(null);
      await expect(
        service.upgradeAllWithRollout("app-1", null, undefined, "9.9.9"),
      ).rejects.toThrow('该应用下未找到版本 "9.9.9"');
      expect(appService.update).not.toHaveBeenCalled();
    });

    it("version 非 released → 400", async () => {
      versionRepo.findOne.mockResolvedValue({
        ...versionRow,
        status: "superseded",
      });
      await expect(
        service.upgradeAllWithRollout("app-1", null, undefined, "1.9.0"),
      ).rejects.toThrow("只有已发布的应用版本");
      expect(appService.update).not.toHaveBeenCalled();
    });

    it("version 与当前相同：跳过快照恢复，纯升级语义", async () => {
      repo.find.mockResolvedValue([row("d1")]);
      versionRepo.findOne.mockResolvedValue({
        ...versionRow,
        version: "2.0.0",
      });
      jest.spyOn(service, "upgrade").mockResolvedValue(row("d1"));

      const result = await service.upgradeAllWithRollout(
        "app-1",
        null,
        undefined,
        "2.0.0",
      );

      expect(result.ok).toBe(true);
      expect(result.version).toBe("2.0.0");
      expect(appService.update).not.toHaveBeenCalled();
    });

    it("version 指向历史版本：快照恢复 app 字段（与 rollbackApplication 同映射）再走全量升级，响应回显 version", async () => {
      repo.find.mockResolvedValue([row("d1"), row("d2")]);
      versionRepo.findOne.mockResolvedValue(versionRow);
      const upSpy = jest.spyOn(service, "upgrade").mockResolvedValue(row("d1"));

      const result = await service.upgradeAllWithRollout(
        "app-1",
        null,
        undefined,
        "1.9.0",
      );

      expect(appService.update).toHaveBeenCalledWith(
        "app-1",
        expect.objectContaining({
          version: "1.9.0",
          gitCommit: "old-commit",
          packageUrl: "http://host/uploads/old.zip",
          entrypoint: "node old.js",
          env: { FOO: "old" },
        }),
        undefined, // P0-1：定版写面经属主守卫——actor 第三参（本用例未带 actor）
      );
      expect(result).toMatchObject({
        ok: true,
        total: 2,
        succeeded: 2,
        version: "1.9.0",
      });
      expect(upSpy).toHaveBeenCalledTimes(2);
    });
  });
});
