import { Logger } from "@nestjs/common";
import {
  ExecutorService,
  __resetMissingFingerprintWarnForTest,
} from "../executor.service";
import { ExecutorStatus } from "../entities/executor.entity";

/**
 * 方案 b（协议 v8，接管自愈死锁修复 2026-10-26）的专项用例。
 *
 * ## 死锁形态（本批修的根因）
 *
 * 新指纹安装拿不到 per-executor token（/token 409——地址被旧安装的行占用），
 * 退化为静态 token 心跳照常上报。v7 语义下这条心跳照旧刷新活性四列
 * （status/offlineReason/consecutiveHeartbeatMisses/lastHeartbeat），把「指纹
 * 错位的冲突行」保持 ONLINE——而接管窗（canTakeOverAbandonedAddressRow，
 * register 的 foreignInstall 分支）要求目标行 **OFFLINE 且静默超窗**，于是
 * 窗口永不打开：冲突自愈被心跳本体锁死。
 *
 * ## 修法（执行器自报 + 中台停供活性）
 *
 * executor-node 在心跳体恒发送 `registrationConflict`（协议 v8）。中台判据：
 * `=== true` 且心跳指纹与行已存真实指纹错位 → 活性四列不进 adopted → 不落库
 * （指标列照写、回包仍 201、online 事件抑制）→ sweep 照常判死 → 接管窗打开
 * → E-1 CAS 收敛。回滚开关 executor.honorHeartbeatConflictSelfReport。
 *
 * harness 说明：与 executor.register-takeover-cas.spec 同款——**不走**
 * Test.createTestingModule 全家桶，直接 `new ExecutorService(...)`，repo 替身
 * 按"真数据库"语义实现（findOne 按谓词过滤、update 按 criteria 严格匹配应用
 * patch、createQueryBuilder 的 execute 应用 UPDATE 谓词）——这样「活性是否
 * 真的落库」「sweep 是否真的判死」不退化为看内存对象。
 */

const ADDR = "10.7.7.7:8002";
const FP_OLD = "e5".repeat(32);
const FP_NEW = "f6".repeat(32);

type Row = Record<string, any>;

/** 带状态的 repo 替身：谓词式 findOne/find + criteria 严格匹配的 update。 */
const makeRepo = () => {
  const rows: Row[] = [];
  const repo: any = {
    rows,
    findOne: jest.fn(async (opts: any) => {
      const w = opts?.where ?? {};
      const hit = rows.find(
        (r) =>
          (w.id === undefined || r.id === w.id) &&
          (w.deviceFingerprint === undefined ||
            r.deviceFingerprint === w.deviceFingerprint) &&
          (w.address === undefined || r.address === w.address),
      );
      return hit ? { ...hit } : null;
    }),
    find: jest.fn(async (opts: any) => {
      const w = opts?.where ?? {};
      const all = rows.filter((r) =>
        w.address === undefined ? true : r.address === w.address,
      );
      return (opts?.take ? all.slice(0, opts.take) : all).map((r) => ({
        id: r.id,
      }));
    }),
    create: jest.fn((d: any) => ({ ...d })),
    save: jest.fn(async (e: any) => e),
    update: jest.fn(async (criteria: any, patch: any) => {
      let affected = 0;
      for (const r of rows) {
        const hit = Object.entries(criteria ?? {}).every(
          ([k, v]) => r[k] === v,
        );
        if (!hit) continue;
        Object.assign(r, patch);
        affected++;
      }
      return { affected };
    }),
    increment: jest.fn(),
    decrement: jest.fn(),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    findBy: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
    createQueryBuilder: jest.fn(() => {
      const pred: { fp?: string; address?: string; sweep?: any } = {};
      const qb: any = {
        addSelect: () => qb,
        select: () => qb,
        where: (_sql: string, params: any = {}) => {
          if (params.fp !== undefined) pred.fp = params.fp;
          if (params.address !== undefined) pred.address = params.address;
          if (params.status !== undefined) pred.sweep = params;
          return qb;
        },
        andWhere: () => qb,
        update: () => qb,
        set: () => qb,
        returning: () => qb,
        getOne: async () => {
          const hit = rows.find(
            (r) =>
              (pred.fp === undefined || r.deviceFingerprint === pred.fp) &&
              (pred.address === undefined || r.address === pred.address),
          );
          return hit ? { ...hit } : null;
        },
        getMany: async () => rows.filter((r) => r.address === pred.address),
        getRawMany: async () => [],
        getRawOne: async () => null,
        getCount: async () => 0,
        // sweep 的两条 UPDATE（markStaleOffline）：按 where 命名参数应用。
        execute: jest.fn(async () => {
          const p = pred.sweep;
          if (!p) return { affected: 0, raw: [] };
          const cutoff = new Date(p.cutoff).getTime();
          // 第一步：递增计数（无 requiredMisses 参数）
          if (p.requiredMisses === undefined) {
            let affected = 0;
            for (const r of rows) {
              if (
                r.status === p.status &&
                new Date(r.lastHeartbeat).getTime() < cutoff
              ) {
                r.consecutiveHeartbeatMisses =
                  (r.consecutiveHeartbeatMisses ?? 0) + 1;
                affected++;
              }
            }
            return { affected, raw: [] };
          }
          // 第二步：达标行 ONLINE → OFFLINE 跃迁（RETURNING）
          const transitioned: Row[] = [];
          for (const r of rows) {
            if (
              r.status === p.status &&
              new Date(r.lastHeartbeat).getTime() < cutoff &&
              (r.consecutiveHeartbeatMisses ?? 0) >= p.requiredMisses
            ) {
              r.status = ExecutorStatus.OFFLINE;
              r.offlineReason = "stale_timeout";
              transitioned.push({
                id: r.id,
                appName: r.appName,
                address: r.address,
              });
            }
          }
          return { affected: transitioned.length, raw: transitioned };
        }),
      };
      return qb;
    }),
  };
  repo.manager = {
    createQueryBuilder: jest.fn(() => repo.createQueryBuilder()),
  };
  return repo;
};

/** 配置替身：sweep 相关键给真实数值，其余回落 "http"（observe 私网判定用）。 */
const makeConfig = (overrides: Record<string, unknown> = {}) => {
  const values: Record<string, unknown> = {
    "executor.heartbeatInterval": 30_000,
    "executor.heartbeatTimeoutMultiplier": 3,
    "executor.staleOfflineConfirmations": 1,
    ...overrides,
  };
  return {
    get: (key: string) => (key in values ? values[key] : "http"),
  };
};

const buildService = async (
  repo: ReturnType<typeof makeRepo>,
  configOverrides: Record<string, unknown> = {},
): Promise<ExecutorService> => {
  // 直接 new（与 register-takeover-cas.spec 同款 22 位置参数形态——追加带
  // 默认值的尾参不破坏既有装配）。
  const svc = new ExecutorService(
    repo,
    makeRepo(),
    makeRepo(),
    makeRepo(), // metrics history（heartbeat 的 best-effort 快照）
    { add: jest.fn() } as never,
    makeConfig(configOverrides) as never,
    {
      // notify* 全部回 Promise——markStaleOffline 的 fire-and-forget 对返回值
      // 直接 .catch()（undefined 会在 sweep 分支炸，见本 spec 首版教训）。
      notifyExecutorOnline: jest.fn().mockResolvedValue(undefined),
      notifyExecutorOffline: jest.fn().mockResolvedValue(undefined),
      notifyFailure: jest.fn().mockResolvedValue(undefined),
      notifyFailureWithConfig: jest.fn().mockResolvedValue(undefined),
      sendAll: jest.fn().mockResolvedValue(undefined),
    } as never,
    { findOne: jest.fn().mockRejectedValue(new Error("not found")) } as never,
    { decrypt: jest.fn() } as never,
    null as never, // eventBus（fail-open，emit 静默跳过）
    null as never, // tracing
    null as never, // audit
    null as never, // leaderGate（markStaleOffline 的 @Cron 门，直调不经过）
    null as never, // pullService
    null as never, // applicationRepo
    null as never, // deployment repo
    null as never, // tokenCacheSync
    null as never, // mutexGroupRepo
    null as never, // applicationVersionRepo
    null as never, // executorAppVersionRepo
    {
      transaction: async (fn: any) => fn({ getRepository: () => null }),
    } as never, // DataSource（R3-B 整替事务直通）
  );
  return svc;
};

/** 旧安装的行：真实指纹、push、ONLINE、静默 10 分钟（> 5min 接管窗）。 */
const occupiedRow = (o: Row = {}): Row => ({
  id: "victim-row",
  address: ADDR,
  appName: "old-install",
  status: ExecutorStatus.ONLINE,
  dispatchMode: "push",
  deviceFingerprint: FP_OLD,
  executorVersion: "1.0.0",
  maxConcurrentTasks: 4,
  runningTaskCount: 0,
  consecutiveHeartbeatMisses: 0,
  lastHeartbeat: new Date(Date.now() - 10 * 60_000),
  executorStartedAt: new Date(Date.now() - 10 * 60_000),
  executorStartupId: "old-startup",
  version: 1,
  ...o,
});

const conflictHeartbeat = (o: Record<string, unknown> = {}) => ({
  cpuUsage: 11,
  memUsage: 22,
  runningTaskCount: 0,
  deviceFingerprint: FP_NEW,
  registrationConflict: true,
  ...o,
});

beforeEach(() => {
  __resetMissingFingerprintWarnForTest();
  jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, "debug").mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("方案 b — 冲突自报 + 指纹错位的心跳停止供活性（协议 v8）", () => {
  it("全链：冲突自报心跳不刷新活性 → sweep 判死 → 接管窗打开 → E-1 CAS 收敛", async () => {
    const repo = makeRepo();
    repo.rows.push(occupiedRow());
    const staleAt = (repo.rows[0].lastHeartbeat as Date).getTime();
    const svc = await buildService(repo);

    // ① 冲突自报 + 指纹错位的心跳（新安装的静态 token 心跳）
    await svc.heartbeat(ADDR, conflictHeartbeat());

    // patch 不登记活性四列；指标列照写（回包 201 语义 = service 正常返回）。
    const patch = repo.update.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(patch).not.toHaveProperty("status");
    expect(patch).not.toHaveProperty("offlineReason");
    expect(patch).not.toHaveProperty("consecutiveHeartbeatMisses");
    expect(patch).not.toHaveProperty("lastHeartbeat");
    expect(patch).toHaveProperty("cpuUsage", 11);
    // DB 权威状态未被动过：lastHeartbeat 停在心跳前值（死锁解除的关键）。
    expect((repo.rows[0].lastHeartbeat as Date).getTime()).toBe(staleAt);
    expect(repo.rows[0].status).toBe(ExecutorStatus.ONLINE);

    // ② sweep 判死（staleOfflineConfirmations=1：一轮即判；静默 10min > 90s 阈值）
    await svc.markStaleOffline();
    expect(repo.rows[0].status).toBe(ExecutorStatus.OFFLINE);

    // ③ 既有接管窗：新安装（push + 新指纹 + 静默已超 5min）注册接管。
    const { executor } = await svc.registerExecutor({
      appName: "new-install",
      address: ADDR,
      version: "2.0.0",
      dispatchMode: "push",
      deviceFingerprint: FP_NEW,
      startupId: "new-startup",
      restartedAt: new Date().toISOString(),
    } as never);
    expect(executor.id).toBe("victim-row");
    expect(repo.rows[0].status).toBe(ExecutorStatus.ONLINE);
    expect(repo.rows[0].deviceFingerprint).toBe(FP_NEW);

    // ④ E-1 CAS 收敛：接管写必须带 status=OFFLINE 谓词（与
    // register-takeover-cas.spec 的核心断言同形——这里只证明链路走的是接管）。
    expect(repo.update).toHaveBeenCalledWith(
      { id: "victim-row", status: ExecutorStatus.OFFLINE },
      expect.objectContaining({
        status: ExecutorStatus.ONLINE,
        deviceFingerprint: FP_NEW,
      }),
    );
  });

  it("反例一：指纹匹配的自报冲突不采信（行主人的心跳照常续命）", async () => {
    const repo = makeRepo();
    repo.rows.push(occupiedRow());
    const svc = await buildService(repo);

    // 行主人自己也处于冲突态（token 轮换竞态等），但指纹与行匹配——
    // 判据第 4 条不成立，活性照常刷新（否则健康行会被自己的心跳饿死）。
    await svc.heartbeat(ADDR, conflictHeartbeat({ deviceFingerprint: FP_OLD }));

    const patch = repo.update.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(patch).toHaveProperty("lastHeartbeat");
    expect(patch).toHaveProperty("status", ExecutorStatus.ONLINE);
    expect(repo.rows[0].status).toBe(ExecutorStatus.ONLINE);
  });

  it("反例二：无指纹的冲突自报心跳不采信（R32-C4 单行地址兜底，v7 语义不变）", async () => {
    const repo = makeRepo();
    repo.rows.push(occupiedRow());
    const svc = await buildService(repo);

    // 无指纹 → 判据第 2 条不成立（单行地址兜底解析到行，无从判定「错位」）。
    // python 执行器（后续批才带该键/指纹）的冲突态不参与本判据。
    await svc.heartbeat(
      ADDR,
      conflictHeartbeat({ deviceFingerprint: undefined }),
    );

    const patch = repo.update.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(patch).toHaveProperty("lastHeartbeat");
  });

  it("反例三：健康行 + 骚扰者谎报 → 行存活（主人心跳不受谎报影响）", async () => {
    const repo = makeRepo();
    repo.rows.push(occupiedRow());
    const svc = await buildService(repo);

    // 谎报者（无冲突却自报 + 指纹错位）：活性被抑制——这正确（错位心跳本就
    // 不该替别人的行续命）。
    await svc.heartbeat(ADDR, conflictHeartbeat());
    expect(repo.update.mock.calls.at(-1)![1]).not.toHaveProperty(
      "lastHeartbeat",
    );

    // 关键断言：行主人的下一次心跳（指纹匹配、无冲突自报）照常把行点亮，
    // 且计数器被清零——骚扰者的谎报不能把健康行拖入判死轨道。
    await svc.heartbeat(ADDR, {
      cpuUsage: 5,
      deviceFingerprint: FP_OLD,
      registrationConflict: false,
    });
    const ownerPatch = repo.update.mock.calls.at(-1)![1] as Record<
      string,
      unknown
    >;
    expect(ownerPatch).toHaveProperty("status", ExecutorStatus.ONLINE);
    expect(ownerPatch).toHaveProperty("consecutiveHeartbeatMisses", 0);
    expect(repo.rows[0].status).toBe(ExecutorStatus.ONLINE);
  });

  it("回滚开关：honorHeartbeatConflictSelfReport=false 恢复 v7 语义（错位冲突心跳照常续命）", async () => {
    const repo = makeRepo();
    repo.rows.push(occupiedRow());
    const svc = await buildService(repo, {
      "executor.honorHeartbeatConflictSelfReport": false,
    });

    await svc.heartbeat(ADDR, conflictHeartbeat());

    const patch = repo.update.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(patch).toHaveProperty("lastHeartbeat");
    expect(patch).toHaveProperty("status", ExecutorStatus.ONLINE);
  });

  it("可观测性：抑制路径发节流 warn（同地址 1h 一条），未抑制路径不发", async () => {
    const repo = makeRepo();
    repo.rows.push(occupiedRow());
    const svc = await buildService(repo);
    const warnSpy = jest.spyOn(Logger.prototype, "warn");

    await svc.heartbeat(ADDR, conflictHeartbeat());
    const suppressedWarns = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes("liveness columns are"),
    );
    expect(suppressedWarns).toHaveLength(1);

    // 30s 后同一地址再来自报 → 节流（不刷屏）
    await svc.heartbeat(ADDR, conflictHeartbeat());
    expect(
      warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes("liveness columns are"),
      ),
    ).toHaveLength(1);

    // 行主人（指纹匹配）心跳不触发该 warn
    warnSpy.mockClear();
    await svc.heartbeat(ADDR, conflictHeartbeat({ deviceFingerprint: FP_OLD }));
    expect(
      warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes("liveness columns are"),
      ),
    ).toHaveLength(0);
  });
});
