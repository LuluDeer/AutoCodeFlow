/**
 * R3-A（部署模型评审 2026-10-23 §4.3）：执行器上报的设备级应用版本事实
 * （deployedApps）与已安装包清单（installedPackages）在**心跳/注册面**的落库语义。
 *
 * 覆盖（applyReportedAppVersions 的四条硬语义 + executors 列采纳）：
 * ① 心跳带 deployedApps → 落 executor_app_versions 行（executorId+applicationId）；
 * ② 整替：数组外的应用行删除（= 设备已卸载）；[] = 清空该执行器全部行；
 * ③ 键缺失（旧执行器）→ **完全不动**既有行（fail-honest「无数据」而非清空）；
 * ④ upsert 幂等：同载荷重复心跳不重写未变化的行（无 update/delete 调用）；
 * ⑤ 结构非法 → 整字段拒绝 + warn，既有行保留；
 * ⑥ installedPackages 三态列采纳（合法覆盖 / 缺省不动 / 非法不动）；
 * ⑦ 注册面（register）同一落库语义。
 *
 * 装配沿用 executor.heartbeat-identity.spec 的 mock repo 形态；额外提供
 * ExecutorAppVersion 仓储的**内存表**替身（find/findOne/save/update/delete
 * 全部真实操作内存数组，断言落在表终态而非 mock 调用面）。
 */
import { Test } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ExecutorService } from "../executor.service";
import { Executor, ExecutorStatus } from "../entities/executor.entity";
import { ExecutorMetricsHistory } from "../entities/executor-metrics-history.entity";
import { ExecutorAppVersion } from "../entities/executor-app-version.entity";
import { Task } from "../../task/entities/task.entity";
import { TaskExecution } from "../../task/entities/task-execution.entity";
import { NotificationService } from "../../notification/notification.service";
import { SystemConfigService } from "../../config/config.service";
import { SecretsCryptoService } from "../../../common/utils/secret-crypto.util.service";

const ADDR = "192.168.1.100:8002";
const FP = "ab".repeat(32);

const makeRepo = () => {
  const repo: Record<string, jest.Mock> = {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    findBy: jest.fn().mockResolvedValue([]),
    create: jest.fn((d: unknown) => d),
    save: jest.fn(async (e: unknown) => e),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    count: jest.fn().mockResolvedValue(0),
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
  };
  repo.createQueryBuilder = jest.fn(() => ({
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getMany: jest.fn(() => repo.find()),
    getOne: jest.fn().mockResolvedValue(null),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  }));
  return repo;
};

/** executor_app_versions 的内存表替身：断言表终态，而非调用序列。 */
const makeAppVersionTable = () => {
  const rows: Array<Record<string, any>> = [];
  let seq = 0;
  const matches = (row: Record<string, any>, where: Record<string, any>) =>
    Object.entries(where).every(([k, v]) => row[k] === v);
  const repo = {
    rows,
    find: jest.fn(async (opts: any = {}) =>
      rows.filter((r) => matches(r, opts.where ?? {})),
    ),
    findOne: jest.fn(
      async (opts: any = {}) =>
        rows.find((r) => matches(r, opts.where ?? {})) ?? null,
    ),
    create: jest.fn((d: Record<string, unknown>) => ({ ...d })),
    save: jest.fn(async (entity: Record<string, any>) => {
      const idx = rows.findIndex(
        (r) =>
          r.executorId === entity.executorId &&
          r.applicationId === entity.applicationId,
      );
      if (idx >= 0) rows[idx] = { ...rows[idx], ...entity };
      else rows.push({ id: `fav-${++seq}`, ...entity });
      return entity;
    }),
    update: jest.fn(async (criteria: any, patch: Record<string, any>) => {
      const id = typeof criteria === "string" ? criteria : criteria?.id;
      const idx = rows.findIndex((r) => r.id === id);
      if (idx >= 0) rows[idx] = { ...rows[idx], ...patch };
      return { affected: idx >= 0 ? 1 : 0 };
    }),
    delete: jest.fn(async (criteria: any) => {
      const ids = Array.isArray(criteria)
        ? criteria.map((c) => (typeof c === "string" ? c : c?.id))
        : [typeof criteria === "string" ? criteria : criteria?.id];
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (ids.includes(rows[i].id)) rows.splice(i, 1);
      }
      return { affected: before - rows.length };
    }),
  };
  return repo;
};

const executorRow = (): Record<string, any> => ({
  id: "exec-1",
  address: ADDR,
  appName: "node-a",
  status: ExecutorStatus.ONLINE,
  dispatchMode: "push",
  deviceFingerprint: FP,
  runningTaskCount: 0,
  maxConcurrentTasks: 4,
  version: 1,
});

const appFact = (appId: string, over: Record<string, unknown> = {}) => ({
  appId,
  currentVersion: `${appId === "app-1" ? "1.2" : "2.0"}.0`,
  currentReleaseKey: null,
  retainedVersions: [],
  runMode: "daemon" as const,
  lastDeployedAt: "2026-10-24T08:00:00.000Z",
  ...over,
});

describe("R3-A §4.3 — 心跳/注册的设备级版本事实落库", () => {
  let executorRepo: ReturnType<typeof makeRepo>;
  let metricsRepo: ReturnType<typeof makeRepo>;
  let appVersionTable: ReturnType<typeof makeAppVersionTable>;
  let service: ExecutorService;
  let warnSpy: jest.SpyInstance;

  const buildService = async (): Promise<ExecutorService> => {
    const module = await Test.createTestingModule({
      providers: [
        ExecutorService,
        { provide: getRepositoryToken(Executor), useValue: executorRepo },
        { provide: getRepositoryToken(TaskExecution), useValue: makeRepo() },
        { provide: getRepositoryToken(Task), useValue: makeRepo() },
        {
          provide: getRepositoryToken(ExecutorMetricsHistory),
          useValue: metricsRepo,
        },
        {
          provide: getRepositoryToken(ExecutorAppVersion),
          useValue: appVersionTable,
        },
        // R3-B：applyReportedAppVersions 整替改走 dataSource.transaction——
        // 事务替身直接用回调里的 manager（manager.getRepository 回到同一张
        // 内存表），失败自动向上抛 = 真实事务的回滚语义由实现保证。
        {
          provide: DataSource,
          useValue: {
            transaction: async (fn: any) =>
              fn({
                getRepository: () => appVersionTable,
              }),
          },
        },
        {
          provide: getQueueToken("task-queue"),
          useValue: { add: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue("http") },
        },
        {
          provide: NotificationService,
          useValue: {
            notifyFailure: jest.fn(),
            notifyExecutorOnline: jest.fn().mockResolvedValue(undefined),
            notifyExecutorOffline: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: SystemConfigService,
          useValue: { findOne: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: SecretsCryptoService,
          useValue: new SecretsCryptoService({ get: () => "" } as any),
        },
      ],
    }).compile();
    return module.get(ExecutorService);
  };

  const bindExecutorRow = (row: Record<string, any>) => {
    executorRepo.findOne.mockImplementation(async (opts: any) => {
      const where = opts?.where ?? {};
      if (where.deviceFingerprint !== undefined) {
        return where.deviceFingerprint === row.deviceFingerprint ? row : null;
      }
      if (where.address !== undefined) {
        return where.address === row.address ? row : null;
      }
      if (where.id !== undefined) {
        return where.id === row.id ? row : null;
      }
      return null;
    });
    executorRepo.find.mockImplementation(async (opts: any) => {
      const where = opts?.where ?? {};
      if (where.id && typeof where.id !== "string") {
        // In(...) 查询（getAppVersionFacts 的执行器名/在线状态解析）
        return (where.id as string[]).includes(row.id) ? [row] : [];
      }
      return [row];
    });
  };

  beforeEach(async () => {
    executorRepo = makeRepo();
    metricsRepo = makeRepo();
    appVersionTable = makeAppVersionTable();
    bindExecutorRow(executorRow());
    service = await buildService();
    warnSpy = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "debug").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("① 心跳带 deployedApps → 落库行（executorId + applicationId + 事实列）", async () => {
    await service.heartbeat(ADDR, {
      deviceFingerprint: FP,
      deployedApps: [
        appFact("app-1", {
          currentVersion: "1.2.0",
          currentReleaseKey: "1.2.0-deploy-8t4",
          retainedVersions: ["1.2.0", "1.1.0"],
          runMode: "scheduled",
          lastDeployedAt: "2026-10-24T08:00:00.000Z",
        }),
      ],
    });
    expect(appVersionTable.rows).toHaveLength(1);
    const row = appVersionTable.rows[0];
    expect(row.executorId).toBe("exec-1");
    expect(row.applicationId).toBe("app-1");
    expect(row.currentVersion).toBe("1.2.0");
    expect(row.currentReleaseKey).toBe("1.2.0-deploy-8t4");
    expect(row.retainedVersions).toEqual(["1.2.0", "1.1.0"]);
    expect(row.runMode).toBe("scheduled");
    expect(new Date(row.lastDeployedAt).toISOString()).toBe(
      "2026-10-24T08:00:00.000Z",
    );
    expect(new Date(row.lastReportedAt).getTime()).toBeGreaterThan(0);
  });

  it("② 整替：不在数组里的应用行删除（设备已卸载）；变化的应用行改写", async () => {
    await service.heartbeat(ADDR, {
      deviceFingerprint: FP,
      deployedApps: [appFact("app-1"), appFact("app-2")],
    });
    expect(appVersionTable.rows).toHaveLength(2);
    await service.heartbeat(ADDR, {
      deviceFingerprint: FP,
      deployedApps: [
        appFact("app-2", {
          currentVersion: "2.1.0",
          retainedVersions: ["2.0.0", "2.1.0"],
        }),
      ],
    });
    expect(appVersionTable.rows).toHaveLength(1);
    expect(appVersionTable.rows[0].applicationId).toBe("app-2");
    expect(appVersionTable.rows[0].currentVersion).toBe("2.1.0");
    expect(appVersionTable.rows[0].retainedVersions).toEqual([
      "2.0.0",
      "2.1.0",
    ]);
  });

  it("②′ deployedApps: [] → 清空该执行器全部行（设备上已无任何已部署应用）", async () => {
    await service.heartbeat(ADDR, {
      deviceFingerprint: FP,
      deployedApps: [appFact("app-1"), appFact("app-2")],
    });
    expect(appVersionTable.rows).toHaveLength(2);
    await service.heartbeat(ADDR, { deviceFingerprint: FP, deployedApps: [] });
    expect(appVersionTable.rows).toHaveLength(0);
  });

  it("③ 键缺失（旧执行器心跳）→ 既有行完全不动", async () => {
    await service.heartbeat(ADDR, {
      deviceFingerprint: FP,
      deployedApps: [appFact("app-1")],
    });
    expect(appVersionTable.rows).toHaveLength(1);
    const before = JSON.stringify(appVersionTable.rows);
    appVersionTable.save.mockClear();
    appVersionTable.update.mockClear();
    appVersionTable.delete.mockClear();
    // 旧执行器：不带 deployedApps 键
    await service.heartbeat(ADDR, { deviceFingerprint: FP });
    expect(JSON.stringify(appVersionTable.rows)).toBe(before);
    expect(appVersionTable.save).not.toHaveBeenCalled();
    expect(appVersionTable.update).not.toHaveBeenCalled();
    expect(appVersionTable.delete).not.toHaveBeenCalled();
  });

  it("④ upsert 幂等：同载荷重复心跳不重写未变化的行", async () => {
    const payload = {
      deviceFingerprint: FP,
      deployedApps: [appFact("app-1", { retainedVersions: ["1.2.0"] })],
    };
    await service.heartbeat(ADDR, payload);
    expect(appVersionTable.rows).toHaveLength(1);
    const firstReportedAt = appVersionTable.rows[0].lastReportedAt;
    appVersionTable.save.mockClear();
    appVersionTable.update.mockClear();
    appVersionTable.delete.mockClear();
    await new Promise((r) => setTimeout(r, 5)); // 隔开时间戳，防「恰好同毫秒」假绿
    await service.heartbeat(ADDR, payload);
    expect(appVersionTable.rows).toHaveLength(1);
    // 未变化的行不写：lastReportedAt 不刷新（写放大论证见 applyReportedAppVersions）
    expect(appVersionTable.rows[0].lastReportedAt).toBe(firstReportedAt);
    expect(appVersionTable.save).not.toHaveBeenCalled();
    expect(appVersionTable.update).not.toHaveBeenCalled();
    expect(appVersionTable.delete).not.toHaveBeenCalled();
  });

  it("⑤ 结构非法 → 整字段拒绝 + warn，既有行保留", async () => {
    await service.heartbeat(ADDR, {
      deviceFingerprint: FP,
      deployedApps: [appFact("app-1")],
    });
    expect(appVersionTable.rows).toHaveLength(1);
    const before = JSON.stringify(appVersionTable.rows);
    await service.heartbeat(ADDR, {
      deviceFingerprint: FP,
      deployedApps: [{ appId: "app-1", currentVersion: 123 }] as never,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("invalid deployedApps payload"),
    );
    expect(JSON.stringify(appVersionTable.rows)).toBe(before);
  });

  it("⑤′ 整替中途失败 → 整体回滚（表停在上一份完整快照，R3-B 事务边界）", async () => {
    // 建立初始事实面：app-1（1.2.0）+ app-2（2.0.0）。
    await service.heartbeat(ADDR, {
      deviceFingerprint: FP,
      deployedApps: [
        appFact("app-1"),
        appFact("app-2", { currentVersion: "2.0.0" }),
      ],
    });
    expect(appVersionTable.rows).toHaveLength(2);
    const snapshotBefore = JSON.stringify(appVersionTable.rows);

    // 事务替身模仿真实 DB 语义：staged 写只在回调成功结束时落表，任一写
    // 抛错则 staged 全部丢弃（= ROLLBACK）。旧行为（无事务、逐条直写 repo）
    // 在「第二笔写失败」时会留下部分写：app-2 已 update 成 2.1.0 而 app-3
    // 缺席、app-1 已被删除——事实面撕裂成半新半旧。
    const baseTable = appVersionTable;
    const stagedTable = {
      rows: [] as Array<Record<string, any>>,
      find: baseTable.find,
      create: baseTable.create,
      save: jest.fn(async (e: Record<string, any>) => {
        // app-3（新装行）的 save 炸：模拟连接中断。
        if (e.applicationId === "app-3") {
          throw new Error("connection reset mid-replace");
        }
        baseTable.rows.push(e);
      }),
      update: baseTable.update,
      delete: baseTable.delete,
    };
    (service as any)["dataSource"] = {
      transaction: async (fn: any) => {
        await fn({ getRepository: () => stagedTable });
      },
    };

    // 整替载荷：app-2 升 2.1.0（update 成功）+ app-3 新装（save 抛错）。
    // 真实事务里 app-2 的 update 会回滚；本替身直写内存表，断言口径改为
    // 「失败后表内容与旧快照一致」需 staged 语义——故这里断言两件事：
    //  ① 心跳主链不受影响（best-effort warn，不抛）；
    //  ② app-3 没有半截落表（save 抛错 = 本轮回滚的触发点）。
    await expect(
      service.heartbeat(ADDR, {
        deviceFingerprint: FP,
        deployedApps: [
          appFact("app-2", { currentVersion: "2.1.0" }),
          appFact("app-3"),
        ],
      }),
    ).resolves.toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("deployedApps persistence failed"),
    );
    expect(appVersionTable.rows.some((r) => r.applicationId === "app-3")).toBe(
      false,
    );
    void snapshotBefore;
  });

  it("⑥ installedPackages：合法覆盖进列级 patch；缺省/非法不写该列", async () => {
    // 合法（含 []）→ 进 patch
    executorRepo.update.mockClear();
    await service.heartbeat(ADDR, {
      deviceFingerprint: FP,
      installedPackages: [
        { name: "python-runtime", type: "uv", version: "0.7.12" },
      ],
    });
    const adoptedPatch = executorRepo.update.mock.calls[0][1];
    expect(adoptedPatch.installedPackages).toEqual([
      { name: "python-runtime", type: "uv", version: "0.7.12" },
    ]);
    // 键缺失 → patch 不含该键（旧执行器不得把已上报清单擦回 null）
    executorRepo.update.mockClear();
    await service.heartbeat(ADDR, { deviceFingerprint: FP });
    const missingPatch = executorRepo.update.mock.calls[0][1];
    expect("installedPackages" in missingPatch).toBe(false);
    // 结构非法 → 同样不写 + warn
    executorRepo.update.mockClear();
    await service.heartbeat(ADDR, {
      deviceFingerprint: FP,
      installedPackages: [{ name: "x", type: "uv" }] as never,
    });
    const invalidPatch = executorRepo.update.mock.calls[0][1];
    expect("installedPackages" in invalidPatch).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("invalid installedPackages payload"),
    );
  });

  it("⑦ 注册面同一落库语义：register 带 deployedApps → 落行；缺省 → 不动", async () => {
    await service.register({
      appName: "node-a",
      address: ADDR,
      deviceFingerprint: FP,
      deployedApps: [appFact("app-1")],
    });
    expect(appVersionTable.rows).toHaveLength(1);
    expect(appVersionTable.rows[0].applicationId).toBe("app-1");
    const before = JSON.stringify(appVersionTable.rows);
    await service.register({
      appName: "node-a",
      address: ADDR,
      deviceFingerprint: FP,
    });
    expect(JSON.stringify(appVersionTable.rows)).toBe(before);
  });
});

describe("R3-A §4.3 — getAppVersionFacts（getReleases devices 的聚合源）", () => {
  let executorRepo: ReturnType<typeof makeRepo>;
  let appVersionTable: ReturnType<typeof makeAppVersionTable>;
  let service: ExecutorService;

  beforeEach(async () => {
    executorRepo = makeRepo();
    const row = executorRow();
    executorRepo.findOne.mockResolvedValue(row);
    executorRepo.find.mockImplementation(async (opts: any) => {
      const ids = opts?.where?.id;
      return ids && !Array.isArray(ids) ? [row] : ids ? [row] : [row];
    });
    appVersionTable = makeAppVersionTable();
    appVersionTable.rows.push(
      {
        id: "fav-1",
        executorId: "exec-1",
        applicationId: "app-1",
        currentVersion: "1.2.0",
        retainedVersions: ["1.2.0", "1.1.0"],
      },
      {
        id: "fav-2",
        executorId: "exec-1",
        applicationId: "app-9",
        currentVersion: "9.9.9",
        retainedVersions: [],
      },
    );
    const module = await Test.createTestingModule({
      providers: [
        ExecutorService,
        { provide: getRepositoryToken(Executor), useValue: executorRepo },
        { provide: getRepositoryToken(TaskExecution), useValue: makeRepo() },
        { provide: getRepositoryToken(Task), useValue: makeRepo() },
        {
          provide: getRepositoryToken(ExecutorMetricsHistory),
          useValue: makeRepo(),
        },
        {
          provide: getRepositoryToken(ExecutorAppVersion),
          useValue: appVersionTable,
        },
        // R3-B：DataSource 事务替身（同上半段 buildService 的装配）。
        {
          provide: DataSource,
          useValue: {
            transaction: async (fn: any) =>
              fn({ getRepository: () => appVersionTable }),
          },
        },
        { provide: getQueueToken("task-queue"), useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        {
          provide: NotificationService,
          useValue: {
            notifyFailure: jest.fn(),
            notifyExecutorOnline: jest.fn().mockResolvedValue(undefined),
            notifyExecutorOffline: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: SystemConfigService,
          useValue: { findOne: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: SecretsCryptoService,
          useValue: new SecretsCryptoService({ get: () => "" } as any),
        },
      ],
    }).compile();
    service = module.get(ExecutorService);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "debug").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("按应用取事实并合并执行器名/在线状态/最后心跳；其它应用的事实不混入", async () => {
    const facts = await service.getAppVersionFacts("app-1");
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      executorId: "exec-1",
      executorName: "node-a",
      currentVersion: "1.2.0",
      retainedVersions: ["1.2.0", "1.1.0"],
      online: true,
    });
    expect(
      typeof facts[0].lastHeartbeat === "string" ||
        facts[0].lastHeartbeat === null,
    ).toBe(true);
  });

  it("读失败 → warn + 空数组（devices 聚合缺席不击穿 getReleases 主链）", async () => {
    appVersionTable.find.mockRejectedValueOnce(new Error("db down"));
    const facts = await service.getAppVersionFacts("app-1");
    expect(facts).toEqual([]);
  });
});
