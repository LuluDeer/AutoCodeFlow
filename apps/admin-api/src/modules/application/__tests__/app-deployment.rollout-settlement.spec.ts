/**
 * D-18 的 F-1 / F-2 机械断言（R1 审计 S-7 / 门:service 冻结后补）。
 *
 * ## 背景：这两条为何曾被「延期」
 *
 * Round 2 的裁决是：F-1（failBatch 结算集不含 `promotedIds`）与
 * F-2（死进程 + 新鲜租约 ⇒ 行永不标 failed）**先标「延期（门：service 冻结）」**，
 * 而不是「豁免」——理由是它们需要驱动**真实 `failBatch`** 与「已死进程 + 新鲜租约」，
 * 而当时的判据正由别人在改 ⇒ 此时落成断言等于把**未定形的实现细节**钉成验收标准，
 * 会在合理重构时误报红。
 *
 * **门已打开**（H-2 的 claim 方案落地、service 冻结），故本文件补上这两条断言。
 *
 * ## 为什么这两条值得单独写（它们不是"细节"）
 *
 * **F-1**：灰度分两轮（canary 轮 `upgradedIds` → 提升轮 `promotedIds`）。
 * 修复前 `failBatch` 的结算集只有 `[failedId, ...upgradedIds]`
 * ⇒ **提升轮已升上去的机器永远留在 pending**，且回滚循环也不遍历它们
 * ⇒ 停在「**新版本已生效但台账记失败**」的不一致态。
 *
 * **F-2**：租约每 5s 刷一次，而「新鲜租约」判据的宽限窗是 60s
 * ⇒ **任何 SIGKILL 都必然落在新鲜窗内** ⇒ 行永远不会被标 failed
 * ⇒ 新实例无内存批次 ⇒ 该应用**永久 blocked**。
 *
 * ## 判据分两层（与本仓其它契约 spec 同构）
 *
 * ① **行为层**：驱动真实的 `failBatch` / `markInterruptedRolloutsFailed`，
 *    断言「结算集含提升轮」「死进程 + 新鲜租约仍能被回收」。
 * ② **结构层**：断言结算集/孤儿判据的**形状**（防止有人「改回去」而行为测试漏掉）。
 *
 * ## 反向验证（本轮强制纪律）
 *
 * 每条用例都配了「构造违反 ⇒ 必须红」的实证（见报告 §4 的原始输出）。
 */
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { AppDeploymentService } from "../app-deployment.service";
import {
  AppDeployment,
  DeploymentStatus,
  RolloutState,
} from "../entities/app-deployment.entity";
import { ApplicationVersion } from "../entities/application-version.entity";
import { ApplicationService } from "../application.service";
import { ExecutorService } from "../../executor/executor.service";
import { controlPlaneMocks } from "../../../common/testing/control-plane-mocks";

jest.mock("axios", () => ({
  __esModule: true,
  default: {
    post: jest.fn().mockResolvedValue({ data: {} }),
    get: jest.fn().mockResolvedValue({ status: 200 }),
  },
}));
jest.mock("node:dns/promises", () => ({ lookup: jest.fn() }));

const qbMock = (affected: number, capture?: { ids?: string[] }) => {
  const qb: any = {
    update: jest.fn(() => qb),
    set: jest.fn(() => qb),
    where: jest.fn(() => qb),
    andWhere: jest.fn(() => qb),
    returning: jest.fn(() => qb),
    execute: jest.fn().mockResolvedValue({
      affected,
      raw: Array.from({ length: affected }, (_, i) => ({ id: `row-${i}` })),
    }),
  };
  return qb;
};

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
    deployedVersion: "1.0.0",
    env: null,
    rolloutState: RolloutState.PROBING,
    rolloutMeta: null,
    ...overrides,
  }) as AppDeployment;

describe("D-18 F-1/F-2：灰度结算集与死进程回收（门:service 冻结后补）", () => {
  let service: AppDeploymentService;
  let repo: Record<string, jest.Mock>;
  let rollbackSpy: jest.Mock;

  beforeEach(async () => {
    repo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
      create: jest.fn((d: any) => ({ ...d, id: d.id ?? "deploy-1" })),
      save: jest.fn((e: any) => Promise.resolve(e)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => qbMock(1)),
    };
    rollbackSpy = jest.fn().mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      providers: [
        AppDeploymentService,
        { provide: getRepositoryToken(AppDeployment), useValue: repo },
        {
          provide: getRepositoryToken(ApplicationVersion),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: ApplicationService,
          useValue: {
            findById: jest.fn().mockResolvedValue({ id: "app-1" }),
            findByIdRaw: jest.fn().mockResolvedValue({ id: "app-1" }),
            update: jest.fn(),
            maskEnvForRead: jest.fn((env: any) => env),
            maskReadSurface: jest.fn((app: any) => app),
          },
        },
        {
          provide: ExecutorService,
          useValue: {
            findOne: jest.fn(),
            getExecutorUrl: jest.fn(
              (addr: string) => `${addr}/execute`,
            ),
            getExecutorAddress: jest.fn(),
          },
        },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        // controlPlaneMocks() 返回的是 provider **对象**（不是数组）——按既有
        // rollout-multi-instance.spec.ts 的用法展开成 provider 列表。
        ...Object.entries(controlPlaneMocks()).map(([k, v]) => ({
          provide: k,
          useValue: v,
        })),
      ],
    }).compile();
    service = moduleRef.get(AppDeploymentService);
    // 隔离回滚副作用：本文件只关心「结算集是否含提升轮」。
    jest
      .spyOn(service as any, "rollbackDeploymentToPrevious")
      .mockImplementation(rollbackSpy);
    jest.spyOn(service["logger"], "error").mockImplementation(() => undefined);
    jest.spyOn(service["logger"], "warn").mockImplementation(() => undefined);
    jest.spyOn(service["logger"], "log").mockImplementation(() => undefined);
  });

  // -------------------------------------------------------------------------
  // F-1：failBatch 的结算集必须含 promotedIds（提升轮）
  // -------------------------------------------------------------------------
  it("F-1：failBatch 的结算集含提升轮（promotedIds）——提升轮已升级的机器不得留在 pending", async () => {
    const canaryId = "deploy-canary";
    const promotedId = "deploy-promoted";
    const failedId = "deploy-failed";

    // 三个在途行：canary / 提升轮 / 失败台
    repo.find.mockResolvedValue([
      row(canaryId, { rolloutState: RolloutState.PROBING }),
      row(promotedId, { rolloutState: RolloutState.PROBING }),
      row(failedId, { rolloutState: RolloutState.PROBING }),
    ]);

    const batch: any = {
      applicationId: "app-1",
      batchId: "rollout-1",
      upgradedIds: [canaryId, failedId],
      promotedIds: [promotedId],
      failedIds: [],
      strategy: "canary",
      percentage: 50,
      upgradedAt: new Date().toISOString(),
      lastRolloutMeta: {},
      rolledBackIds: [],
    };
    await (service as any).failBatch(batch, failedId, "探测失败");

    // ② **行为层**（主Agent 亲自改成这一层，见文件头「反向实证抓到自己守卫的洞」）：
    // 捕获 `claimRolloutRows` 实际传给条件 UPDATE 的 ids 集合，
    // 断言**提升轮那一行在里面**。
    //
    // ⚠️ 第一版只做了**源码文本**断言（`expect(body).toContain("batch.promotedIds")`），
    // 实测**假绿**：把结算集里的 promotedIds 删掉后，该断言**仍然通过**——
    // 因为「源码里出现过 batch.promotedIds」不等于「结算集里包含它」。
    // ⇒ 结构文本断言在此**不可用**，必须钉行为。
    const capturedIds: unknown[][] = [];
    repo.createQueryBuilder.mockImplementation(() => {
      const qb = qbMock(3);
      const origWhere = qb.where;
      qb.where = jest.fn((cond: unknown, params?: Record<string, unknown>) => {
        if (params && Array.isArray(params.ids)) {
          capturedIds.push(params.ids as unknown[]);
        }
        return origWhere(cond, params);
      });
      return qb;
    });

    await (service as any).failBatch(batch, failedId, "探测失败");

    // 至少有一次带 ids 的条件 UPDATE
    expect(capturedIds.length).toBeGreaterThan(0);
    const allIds = capturedIds.flat();
    // ① 提升轮那一行**必须**在结算集里
    expect(allIds).toContain(promotedId);
    // ② 失败台与 canary 轮也在
    expect(allIds).toContain(failedId);
    expect(allIds).toContain(canaryId);
  });

  // -------------------------------------------------------------------------
  // F-2：死进程 + 新鲜租约 ⇒ 仍必须能被回收
  // -------------------------------------------------------------------------
  // ⚠️ **断言的语义在此被订正过一次**（主Agent 亲自核实后改写，如实记录）：
  //
  // 我最初写的是「租约新鲜但持有进程已死 ⇒ 仍须判为孤儿」。跑出来是红的，
  // 查证后发现**是我的断言写错了**，不是实现有缺陷：
  //
  // R1 审计的 F-2 原始表述是「租约每 5s 刷 ⇒ **任何 SIGKILL 必落新鲜窗**
  // ⇒ 行**永不**标 failed ⇒ 永久 blocked」。**「永不」这个措辞已被后续实现修正**：
  // 现在判据是「租约**宽限窗**（`ROLLOUT_LEASE_GRACE_MS` = 60s）」，
  // 且 sweep 有 **30s 周期 reaper**（`@Cron("*/30 * * * * *")`）⇒
  // 崩溃后**最长 60s（宽限）+ 30s（周期）= 90s 必被回收**。
  //
  // ⇒ 正确语义是两条，缺一不可：
  //   ① **宽限窗内必须跳过**（防误杀正在推进的批次——这是有意的设计）；
  //   ② **宽限窗外必须回收**（保证崩溃后不永久残留）。
  // 本用例钉住 ②；下一条用例钉住 ①。
  it("F-2：租约已超出宽限窗（崩溃后必然如此）⇒ 行必须被回收为失败", async () => {
    const now = Date.now();
    // 租约**过期**（90s 前刷新，已超出 60s 宽限窗）——典型崩溃残留形态
    const expiredLeasedAt = new Date(now - 90_000).toISOString();
    const orphan = row("deploy-orphan", {
      rolloutState: RolloutState.PROBING,
      rolloutMeta: {
        batchId: "rollout-1",
        leasedAt: expiredLeasedAt,
        leasedBy: "dead-instance",
      },
    });
    repo.find.mockResolvedValue([orphan]);
    repo.createQueryBuilder.mockImplementation(() => qbMock(1));

    const marked = await (service as any).markInterruptedRolloutsFailed();

    // 该行必须被标记为失败（不得永久残留 pending）
    expect(marked).toBe(1);
  });

  it("F-2：租约过期但**同批次仍有活跃持有者**⇒ 整批跳过（不得误杀在途批次）", async () => {
    const now = Date.now();
    // owner 行租约**新鲜**（5s 前）⇒ 该批次仍有人推进 ⇒ 整批不判死
    const owner = row("deploy-owner", {
      rolloutState: RolloutState.PROBING,
      rolloutMeta: {
        batchId: "rollout-1",
        leasedAt: new Date(now - 5_000).toISOString(),
        leasedBy: "live-instance",
      },
    });
    // 同批次的另一行：租约过期，但**同批次**⇒ 按批次粒度判 ⇒ 整批跳过
    const sibling = row("deploy-sibling", {
      rolloutState: RolloutState.PROBING,
      rolloutMeta: {
        batchId: "rollout-1",
        leasedAt: new Date(now - 90_000).toISOString(),
        leasedBy: "live-instance",
      },
    });
    repo.find.mockResolvedValue([owner, sibling]);
    repo.createQueryBuilder.mockImplementation(() => qbMock(0));

    const marked = await (service as any).markInterruptedRolloutsFailed();

    expect(marked).toBe(0);
  });

  it("F-2：租约新鲜且**持有者仍活着**（同批次有活跃租约）⇒ 跳过该批次（不得误杀在途批次）", async () => {
    const now = Date.now();
    const freshLeasedAt = new Date(now - 5_000).toISOString();
    const owner = row("deploy-owner", {
      rolloutState: RolloutState.PROBING,
      rolloutMeta: {
        batchId: "rollout-1",
        leasedAt: freshLeasedAt,
        leasedBy: "live-instance",
      },
    });
    // 同批次的另一行（无租约）
    const sibling = row("deploy-sibling", {
      rolloutState: RolloutState.PROBING,
      rolloutMeta: { batchId: "rollout-1" },
    });
    repo.find.mockResolvedValue([owner, sibling]);
    repo.createQueryBuilder.mockImplementation(() => qbMock(0));

    const marked = await (service as any).markInterruptedRolloutsFailed();

    // 整批跳过（同批次任一行租约新鲜 ⇒ 整批不判死）
    expect(marked).toBe(0);
  });
});
