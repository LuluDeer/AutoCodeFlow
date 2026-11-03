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
// ARCH-33（ADR-016）：控制面 pull 通道的测试替身（默认 push）
import { controlPlaneMocks } from "../../../common/testing/control-plane-mocks";

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
  // R50：markRolloutState / 租约刷新改列级 update（ADR-026 规则 4）——假仓储必须
  // 提供 update，否则这条路径在测试里等于不存在（ADR-027 的同一教训）。
  update: jest.fn().mockResolvedValue({ affected: 1 }),
  // O-1: 批量 UPDATE 走 createQueryBuilder 链；默认链可独立断言（qbMock 见下）。
  createQueryBuilder: jest.fn(() => qbMock(1)),
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
    // ADR-026：批量状态写用 RETURNING 精确计数（affected 在 UPDATE 里不可靠，
    // 且返回给调用方的应是「真正被标记的行数」）——假仓储必须提供该链。
    returning: jest.fn(() => qb),
    execute: jest.fn().mockResolvedValue({
      affected,
      raw: Array.from({ length: affected }, (_, i) => ({ id: `row-${i}` })),
    }),
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
      // ARCH-33（ADR-016）：默认 push（本 spec 验证 push 路径语义）
      ...controlPlaneMocks(),
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
    expect(service.__rolloutStateForTest().hasBatch("app-1")).toBe(false);

    await (service as any).notifyHeartbeatToRollout(d);

    // R50：markRolloutState 改列级 update 后，持久化结果要从 update 的 patch 读
    //（save 的实参里已经没有这次状态写）。
    // R1 阶段 1 · 1-B：markRolloutState 进一步改为**条件写**（走
    // createQueryBuilder 的 set/where 链）⇒ 也要从 set 入参读。
    const persisted = [
      ...repo.save.mock.calls.map(([e]: any[]) => e),
      ...repo.update.mock.calls.map(([w, p]: any[]) => ({ ...w, ...p })),
      ...(repo.createQueryBuilder?.mock?.results ?? [])
        .map((r: any) => r.value)
        .filter((qb: any) => qb?.set?.mock?.calls?.length)
        .map((qb: any) => {
          const whereParams = qb.where?.mock?.calls?.[0]?.[1] ?? {};
          const setArg = qb.set?.mock?.calls?.[0]?.[0] ?? {};
          // 只纳入 markRolloutState 的写入（带 rolloutMeta）；claimRolloutRows
          // 的 `.set({ rolloutState })` 是批量终结认领（多行、无 id）。
          if (!("rolloutMeta" in setArg)) return null;
          return { ...whereParams, ...setArg };
        })
        .filter(Boolean),
    ];
    const probed = persisted.filter(
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
    expect(service.__rolloutStateForTest().hasBatch("app-1")).toBe(false);
  });

  /**
   * R1 阶段 1 · 1-B：**DB 层原子占坑**（根治 P-7 / S-7 的 TOCTOU 窗口）。
   *
   * ## 为什么应用层判定不够
   *
   * 上面的用例覆盖的是「**读判时**已经能看到在途行」——那被
   * `findInFlightRolloutRows` 挡住了。但真正的窗口在**读判之后**：
   *   ① 读判（无在途行）→ ② 写 `rolloutState=PENDING` → ③ 逐台 upgrade
   * ②与③之间没有原子占坑 ⇒ 两实例可同时通过① ⇒ 都建批次。
   *
   * 本用例模拟「①已通过（读不到在途行），但②被 DB 拦住」——
   * 即迁移 `1790000000094` 的部分唯一索引
   * `uq_app_deployments_rollout_in_flight` 生效的场景。
   */
  it("R1 1-B: 占坑被 DB 拦下（唯一索引冲突）→ ok=false + blockedReason，不触发 upgrade", async () => {
    // ① 读判阶段查不到在途行（模拟竞态窗口：此刻确实没有）
    repo.find.mockResolvedValue([row("d1"), row("d2")]);
    // ② 占坑写：条件写 affected=0 ⇒ 该行已在途（别的批次占着）
    const qb = qbMock(0);
    (repo as any).createQueryBuilder = jest.fn(() => qb);
    repo.findOne.mockResolvedValue(row("d1"));
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
    // 关键断言：占坑输掉 ⇒ **不得**触发 upgrade（否则就是第二次执行）
    expect(upSpy).not.toHaveBeenCalled();
    // 批次不得留在进程内 Map（否则本实例会继续推进一个已被拒的批次）
    expect(service.__rolloutStateForTest().hasBatch("app-1")).toBe(false);
  });

  it("R1 1-B: 占坑走 claim 列 CAS（WHERE claim IS NULL），只写 owner 行", async () => {
    repo.find.mockResolvedValue([row("d1"), row("d2")]);
    const qb = qbMock(1);
    (repo as any).createQueryBuilder = jest.fn(() => qb);
    repo.findOne.mockResolvedValue(row("d1"));
    const upSpy = jest
      .spyOn(service, "upgrade")
      .mockResolvedValue(row("d1") as any);

    await service.upgradeAllWithRollout("app-1", {
      strategy: "canary",
      percentage: 50,
    });

    // 占坑 = UPDATE ... SET "rolloutBatchClaimId" = :batchId
    //        WHERE "id" = :id AND "rolloutBatchClaimId" IS NULL
    const setArg = qb.set.mock.calls.map((c: any[]) => c[0]);
    expect(
      setArg.some((a: any) => a && "rolloutBatchClaimId" in a),
    ).toBe(true);
    const andWhereArgs = qb.andWhere.mock.calls.map((c: any[]) => c[0]);
    expect(
      andWhereArgs.some((w: string) =>
        w.includes('"rolloutBatchClaimId" IS NULL'),
      ),
    ).toBe(true);
    expect(upSpy).toHaveBeenCalled();
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
    // O-1: 单条批量 UPDATE 只覆盖 orphan（d2）；租约新鲜的行（d1）被跳过
    expect(repo.save).not.toHaveBeenCalled();
    const qb = repo.createQueryBuilder.mock.results[0].value;
    expect(qb.execute).toHaveBeenCalledTimes(1);
    const whereArg = qb.where.mock.calls[0][1] as { ids: string[] };
    expect(whereArg.ids).toEqual(["d2"]);
    const setArg = qb.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.rolloutState).toBe(RolloutState.FAILED);
    expect(String(setArg.rolloutMeta)).toContain("restarted");
  });

  /**
   * 真机跨实例灰度套件抓到的缺陷：批次成功收尾（finishBatch）只清内存态，
   * **canary 命中台的行永远停在 probing**。后果不只是读面难看：
   * findInFlightRolloutRows 会把该应用永久判定为「有批次在途」，后续任何
   * canary 都被互斥挡死（blockedReason 永远存在）；滚动重启时 sweep 还会把
   * 这条陈旧行误标 failed。
   */
  describe("批次成功收尾的行态收口（finishBatch）", () => {
    const seedBatch = (upgradedIds: string[], promotedIds: string[] = []) => {
      service.__rolloutStateForTest().seedBatch("app-1", {
        batchId: "batch-1",
        applicationId: "app-1",
        strategy: "canary",
        percentage: 50,
        healthCheck: null,
        upgradedIds: [...upgradedIds],
        promotedIds: [...promotedIds],
        startedAt: Date.now(),
        timer: null,
        tickTimer: null,
        probedIds: new Set<string>(),
      });
    };

    it("收尾把本批在途行置 promoted（只动 pending/probing，不覆盖失败痕迹）", async () => {
      const qb = qbMock(1);
      (repo as any).createQueryBuilder = jest.fn(() => qb);
      seedBatch(["d1"], ["d2"]);

      await (service as any).finishBatch("app-1");

      // R1 1-B（迁移 1790000000095）：收尾时**一并释放 claim**——
      // 不释放会让该应用的唯一索引恒有占用行 ⇒ 后续所有灰度永久阻塞。
      expect(qb.set).toHaveBeenCalledWith({
        rolloutState: RolloutState.PROMOTED,
        rolloutBatchClaimId: null,
      });
      expect(qb.where).toHaveBeenCalledWith("id IN (:...ids)", {
        ids: ["d1", "d2"],
      });
      expect(qb.andWhere).toHaveBeenCalledWith("rolloutState IN (:...from)", {
        from: [RolloutState.PENDING, RolloutState.PROBING],
      });
      expect(service.__rolloutStateForTest().hasBatch("app-1")).toBe(false);
    });

    it("无内存批次时收尾是 no-op（不触库）", async () => {
      const spy = jest.fn();
      (repo as any).createQueryBuilder = spy;

      await (service as any).finishBatch("app-1");

      expect(spy).not.toHaveBeenCalled();
    });

    it("收口失败只记 warn 不外抛（收尾动作不改变批次结论）", async () => {
      const qb = qbMock(1);
      qb.execute.mockRejectedValueOnce(new Error("db down"));
      (repo as any).createQueryBuilder = jest.fn(() => qb);
      seedBatch(["d1"]);

      await expect(
        (service as any).finishBatch("app-1"),
      ).resolves.toBeUndefined();
      expect(service.__rolloutStateForTest().hasBatch("app-1")).toBe(false);
    });

    it("空 id 列表不触库（幂等）", async () => {
      const spy = jest.fn();
      (repo as any).createQueryBuilder = spy;

      await (service as any).settleRolloutRows([], RolloutState.PROMOTED);

      expect(spy).not.toHaveBeenCalled();
    });
  });

  /**
   * F-9b 配套（本轮修复）：**周期回收不得误杀正在推进的批次**。
   *
   * 背景：`touchRolloutLease` 只在 `batch.upgradedIds[0]`（owner 行）上写
   * `leasedAt`，同批次其余 canary/promoted 行**本来就没有**该字段。
   * 若「孤儿在途行」判据按**行**求值，30s 周期回收会把同批次的非 owner 行
   * 判成「已死」⇒ **正在推进的批次被自己的回收器杀掉**（引入周期调度后必然发生）。
   * 故判据必须按**批次**（`rolloutMeta.batchId`）求值：同批任一行租约新鲜即整批跳过。
   */
  describe("F-9b：周期回收的孤儿判据必须按批次粒度（不得误杀在途批次）", () => {
    it("同批次非 owner 行无租约、owner 行租约新鲜 ⇒ 整批跳过（不标 failed）", async () => {
      const owner = row("d1", {
        rolloutState: RolloutState.PROBING,
        rolloutMeta: {
          batchId: "batch-live",
          leasedAt: new Date().toISOString(),
          leasedBy: "admin:7",
        },
      });
      // 同批次的兄弟行：**没有** leasedAt（真实形态——租约只写 owner 行）
      const sibling1 = row("d2", {
        rolloutState: RolloutState.PENDING,
        rolloutMeta: { batchId: "batch-live", role: "canary" },
      });
      const sibling2 = row("d3", {
        rolloutState: RolloutState.PENDING,
        rolloutMeta: { batchId: "batch-live", role: "promoted" },
      });
      repo.find.mockResolvedValue([owner, sibling1, sibling2]);

      const n = await service.markInterruptedRolloutsFailed();

      expect(n).toBe(0);
      // 一次批量 UPDATE 都不该发（全批跳过）
      expect(repo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it("整批没有任何新鲜租约 ⇒ 全批判 failed（回收真正生效）", async () => {
      const a = row("d1", {
        rolloutState: RolloutState.PROBING,
        rolloutMeta: {
          batchId: "batch-dead",
          leasedAt: "2020-01-01T00:00:00.000Z",
        },
      });
      const b = row("d2", {
        rolloutState: RolloutState.PENDING,
        rolloutMeta: { batchId: "batch-dead", role: "promoted" },
      });
      repo.find.mockResolvedValue([a, b]);

      await service.markInterruptedRolloutsFailed();

      // 计数来自 UPDATE ... RETURNING（假仓储的 raw 长度），故断言**命中集合**
      // 而不是 mock 的默认返回行数：两行都必须进 WHERE。
      const qb = repo.createQueryBuilder.mock.results[0].value;
      const whereArg = qb.where.mock.calls[0][1] as { ids: string[] };
      expect(new Set(whereArg.ids)).toEqual(new Set(["d1", "d2"]));
      // 且必须**同时清 claim**（否则崩溃后该应用永久开不了灰度）
      const setArg = qb.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.rolloutBatchClaimId).toBeNull();
    });
  });

  /**
   * F-9b 配套（本轮修复）：`markRolloutState` 整列覆盖 `rolloutMeta` 时
   * **必须继承租约字段**，否则一次「心跳推进 probing」就把租约抹掉，
   * 紧接着的周期回收会把这条活批次判死。
   */
  describe("F-9b：markRolloutState 不得抹掉租约（否则周期回收会误杀活批次）", () => {
    const invokeMark = async (
      prevMeta: Record<string, any> | null,
      newMeta: Record<string, any>,
    ) => {
      repo.findOne.mockResolvedValue(
        row("d1", { rolloutState: RolloutState.PENDING, rolloutMeta: prevMeta }),
      );
      const qb = qbMock(1);
      (repo as any).createQueryBuilder = jest.fn(() => qb);
      await (service as any).markRolloutState(
        "d1",
        RolloutState.PROBING,
        newMeta,
        { allowFromInFlight: true },
      );
      return qb.set.mock.calls[0][0] as Record<string, any>;
    };

    it("新 meta 未带 leasedAt/leasedBy ⇒ 从旧 meta 继承（租约不被抹）", async () => {
      const setArg = await invokeMark(
        {
          batchId: "batch-live",
          leasedAt: "2026-11-03T00:00:00.000Z",
          leasedBy: "admin:7",
        },
        { batchId: "batch-live", role: "canary" },
      );
      expect(setArg.rolloutMeta).toMatchObject({
        batchId: "batch-live",
        role: "canary",
        leasedAt: "2026-11-03T00:00:00.000Z",
        leasedBy: "admin:7",
      });
    });

    it("新 meta 显式带 leasedBy ⇒ 以新值为准（新实例接管租约）", async () => {
      const setArg = await invokeMark(
        {
          batchId: "batch-live",
          leasedAt: "2026-11-03T00:00:00.000Z",
          leasedBy: "admin:7",
        },
        { batchId: "batch-live", role: "canary", leasedBy: "admin:9" },
      );
      expect(setArg.rolloutMeta.leasedBy).toBe("admin:9");
      // leasedAt 未显式给 ⇒ 仍继承旧值
      expect(setArg.rolloutMeta.leasedAt).toBe("2026-11-03T00:00:00.000Z");
    });
  });
});
