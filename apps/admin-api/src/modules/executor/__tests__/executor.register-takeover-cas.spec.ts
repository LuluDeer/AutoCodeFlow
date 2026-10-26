import { Logger } from "@nestjs/common";
import { ExecutorService } from "../executor.service";
import { ExecutorStatus } from "../entities/executor.entity";
import {
  validateRegisterIdentityFields as validateFields,
  REGISTER_ALLOWED_TYPES,
} from "../executor-register-validate.util";
import { ExecutorType } from "../entities/executor.entity";

/**
 * E-1/E-2/E-4（2026-10-26 执行器域审计）修复的专项用例。
 *
 * harness 说明：本文件**不复用** register-address-identity.spec 的全模块装配
 * （Test.createTestingModule 全家桶），只对两类单元做直测：
 *  1. validateRegisterIdentityFields（纯函数，E-4 每闸一例）；
 *  2. ExecutorService 的接管 CAS（E-1/E-2）——register 路径的 repo 替身。
 */

// ── E-4：register 身份键校验（每闸一例）─────────────────────────────────

describe("E-4 — validateRegisterIdentityFields（register 身份键入站校验）", () => {
  const ok = (o: Record<string, unknown>) =>
    expect(validateFields(o as never)).toBeNull();

  it("合法载荷（含仓内真实形态：URL 地址/主机名地址/带点 appName）→ null", () => {
    ok({
      appName: "executor-node-abc.host-1",
      address: "http://exec-a:3001", // version-follow spec :52 的存量形态
    });
    ok({
      appName: "headless-agent-xyz",
      address: "headless-agent-xyz:8010", // demo-headless-agent.mjs 的形态
    });
    ok({ appName: "e1", address: "127.0.0.1" }); // 无端口形态（service.spec:3043）
    ok({ appName: "e1", address: "1.2.3.4:8002", type: "node" });
    ok({}); // 全缺省 = 未上报，三态语义，不校验
  });

  it("appName：空白 → 拒；超 255 字节 → 拒（PG varchar 上限对齐）；控制字符 → 拒", () => {
    expect(validateFields({ appName: "   " } as never)).toMatchObject({
      field: "appName",
    });
    expect(validateFields({ appName: "a".repeat(256) } as never)).toMatchObject(
      { field: "appName", reason: expect.stringContaining("255") },
    );
    expect(validateFields({ appName: "bad\nname" } as never)).toMatchObject({
      field: "appName",
    });
    expect(validateFields({ appName: "bad'name" } as never)).toMatchObject({
      field: "appName",
    });
  });

  it("address：空白/超长/控制字符/内嵌空白 → 拒；URL 与主机名形态 → 放行", () => {
    expect(validateFields({ address: " " } as never)).toMatchObject({
      field: "address",
    });
    expect(validateFields({ address: "a".repeat(256) } as never)).toMatchObject(
      { field: "address", reason: expect.stringContaining("255") },
    );
    expect(
      validateFields({ address: "1.2.3.4\x008002" } as never),
    ).toMatchObject({ field: "address" });
    expect(
      validateFields({ address: "host with space:80" } as never),
    ).toMatchObject({ field: "address" });
    ok({ address: "https://host.example:8443/base" });
  });

  it("type：枚举白名单外 → 拒；白名单与 ExecutorType 枚举一致（漂移钉死）", () => {
    expect(validateFields({ type: "deploy" } as never)).toMatchObject({
      field: "type",
      reason: expect.stringContaining("python"),
    });
    expect(validateFields({ type: "<script>" } as never)).toMatchObject({
      field: "type",
    });
    for (const t of Object.values(ExecutorType)) {
      expect(REGISTER_ALLOWED_TYPES).toContain(t);
    }
    ok({ type: "universal" });
  });

  it("capabilities：非数组 → 拒；>64 项 → 拒；空元素 → 拒；逗号元素 → 拒（simple-array 劈裂，F-7 同型）；超长元素 → 拒", () => {
    expect(
      validateFields({ capabilities: "node" as unknown as string[] } as never),
    ).toMatchObject({ field: "capabilities" });
    expect(
      validateFields({
        capabilities: Array.from({ length: 65 }, (_, i) => `c${i}`),
      } as never),
    ).toMatchObject({
      field: "capabilities",
      reason: expect.stringContaining("64"),
    });
    expect(
      validateFields({ capabilities: ["node", "  "] } as never),
    ).toMatchObject({ field: "capabilities" });
    expect(
      validateFields({ capabilities: ["gpu,a100"] } as never),
    ).toMatchObject({
      field: "capabilities",
      reason: expect.stringContaining("逗号"),
    });
    expect(
      validateFields({ capabilities: ["a".repeat(65)] } as never),
    ).toMatchObject({
      field: "capabilities",
      reason: expect.stringContaining("64"),
    });
    ok({ capabilities: ["node", "shell"] });
    ok({ runtime: ["nodejs", "python3"] }); // runtime 是同一列的别名，同闸
    ok({ capabilities: [] }); // 空数组合法（列允许为空）
  });

  it("tags：与 capabilities 同闸（逗号/数量/元素长度）", () => {
    expect(validateFields({ tags: ["prod,edge"] } as never)).toMatchObject({
      field: "tags",
      reason: expect.stringContaining("逗号"),
    });
    expect(
      validateFields({
        tags: Array.from({ length: 65 }, (_, i) => `t${i}`),
      } as never),
    ).toMatchObject({ field: "tags" });
    ok({ tags: ["nodejs", "prod"] });
    ok({ tags: null }); // 显式 null = 清除，合法
  });

  it("description ≤300 字节；groupName 空白/超长/控制字符 → 拒", () => {
    expect(
      validateFields({ description: "d".repeat(301) } as never),
    ).toMatchObject({
      field: "description",
      reason: expect.stringContaining("300"),
    });
    ok({ description: "生产环境执行器" });
    expect(validateFields({ groupName: "  " } as never)).toMatchObject({
      field: "groupName",
    });
    expect(
      validateFields({ groupName: "g".repeat(256) } as never),
    ).toMatchObject({
      field: "groupName",
    });
    ok({ groupName: "production" });
    ok({ groupName: null });
  });
});

// ── E-1/E-2：接管 CAS + 幻影计数清零（register 路径，repo 替身直测）──────

/**
 * 最小 repo 替身：只覆盖 register 走到的面（findOne/find/update/save/count）。
 * update 按真实 UPDATE 语义实现——criteria 逐键严格相等匹配（含 status 谓词），
 * 命中行才 merge patch 并计入 affected。这正是 E-1 CAS 可测的关键：并发败家
 * 的 update 谓词（status=OFFLINE）在行已被赢家写成 ONLINE 后不命中 → affected=0。
 */
const ADDR = "10.9.9.9:8002";
const FP_OLD = "c3".repeat(32);
const FP_NEW = "d4".repeat(32);

const makeRepo = () => {
  const rows: Record<string, any>[] = [];
  const repo: any = {
    rows,
    findOne: jest.fn(async (opts: any) => {
      const w = opts?.where ?? {};
      const hit = rows.find(
        (r) =>
          (w.id === undefined || r.id === w.id) &&
          (w.deviceFingerprint === undefined ||
            r.deviceFingerprint === w.deviceFingerprint) &&
          (w.address === undefined || r.address === w.address) &&
          (w.status === undefined || r.status === w.status),
      );
      return hit ? { ...hit } : null;
    }),
    find: jest.fn(async (opts: any) => {
      const w = opts?.where ?? {};
      const all = rows.filter((r) =>
        w.address === undefined ? true : r.address === w.address,
      );
      return (opts?.take ? all.slice(0, opts.take) : all).map((r) => ({
        ...r,
      }));
    }),
    create: jest.fn((d: any) => ({ ...d })),
    save: jest.fn(async (e: any) => {
      if (e.id === undefined) e.id = "new-row";
      const idx = rows.findIndex((r) => r.id === e.id);
      if (idx >= 0) Object.assign(rows[idx], e);
      else rows.push({ ...e });
      return e;
    }),
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
    count: jest.fn().mockResolvedValue(0),
    increment: jest.fn(),
    decrement: jest.fn(),
    findBy: jest.fn().mockResolvedValue([]),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    // registerExecutor 的 prior 读取走 createQueryBuilder（带 tokenHash 的
    // select:false 列）。按 where 形态解析：fingerprint / address。
    createQueryBuilder: jest.fn(() => {
      const pred: { fp?: string; address?: string } = {};
      const qb: any = {
        addSelect: () => qb,
        select: () => qb,
        where: (_sql: string, params: any = {}) => {
          if (params.fp !== undefined) pred.fp = params.fp;
          if (params.address !== undefined) pred.address = params.address;
          return qb;
        },
        andWhere: () => qb,
        getOne: async () => {
          const hit = rows.find(
            (r) =>
              (pred.fp === undefined || r.deviceFingerprint === pred.fp) &&
              (pred.address === undefined || r.address === pred.address),
          );
          return hit ? { ...hit } : null;
        },
        getMany: async () =>
          rows
            .filter(
              (r) =>
                (pred.fp === undefined || r.deviceFingerprint === pred.fp) &&
                (pred.address === undefined || r.address === pred.address),
            )
            .map((r) => ({ ...r })),
        getRawMany: async () => [],
        getRawOne: async () => null,
        getCount: async () => 0,
        update: () => qb,
        set: () => qb,
        execute: async () => ({ affected: 1 }),
      };
      return qb;
    }),
  };
  repo.manager = { createQueryBuilder: jest.fn() };
  return repo;
};

const buildService = async (repo: any): Promise<ExecutorService> => {
  // 直 new（与 executor.service.spec 的 15+ 位置参数形态一致）——只挂 register
  // 走到的依赖。@Optional 的依赖全 null 是合法装配（服务注释明示）。
  const svc = new ExecutorService(
    repo, // Executor repo
    makeRepo(), // TaskExecution repo
    makeRepo(), // Task repo
    makeRepo(), // ExecutorMetricsHistory repo
    { add: jest.fn() } as never, // Queue
    { get: () => "http" } as never, // ConfigService（http → observe 的私网判定等）
    {
      notifyExecutorOnline: jest.fn(),
      notifyExecutorOffline: jest.fn(),
      notifyFailure: jest.fn(),
      notifyFailureWithConfig: jest.fn(),
      sendAll: jest.fn(),
    } as never, // NotificationService
    { findOne: jest.fn().mockRejectedValue(new Error("not found")) } as never, // SystemConfigService
    { decrypt: jest.fn() } as never, // SecretsCryptoService
    null as never, // eventBus
    null as never, // tracing
    null as never, // audit
    null as never, // leaderGate
    null as never, // pullService
    null as never, // applicationRepo
    null as never, // deployment repo (ARCH-35)
    null as never, // tokenCacheSync (ARCH-31)
    null as never, // mutexGroupRepo (MUTEX-01)
    null as never, // applicationVersionRepo (FEAT-22)
    null as never, // executorAppVersionRepo (R3-A)
    {
      transaction: async (fn: any) => fn({ getRepository: () => null }),
    } as never, // DataSource (R3-B)
  );
  return svc;
};

/** 已判死的占位行（真实旧指纹，静默 10 分钟 > 5 分钟接管窗）。 */
const deadOccupant = (o: Record<string, any> = {}) => ({
  id: "victim-row",
  address: ADDR,
  appName: "old-install",
  status: ExecutorStatus.OFFLINE,
  dispatchMode: "push",
  deviceFingerprint: FP_OLD,
  executorVersion: "1.0.0",
  maxConcurrentTasks: 4,
  runningTaskCount: 3, // E-2：幻影计数
  lastHeartbeat: new Date(Date.now() - 10 * 60_000),
  tokenHash: "$2b$12$oldhash",
  ...o,
});

describe("E-1/E-2 — foreignInstall 接管：CAS 收口与幻影计数清零", () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "debug").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const takeoverPayload = (o: Record<string, any> = {}) => ({
    appName: "new-install",
    address: ADDR,
    version: "2.0.0",
    dispatchMode: "push",
    deviceFingerprint: FP_NEW,
    startupId: "new-startup",
    ...o,
  });

  it("E-1 单请求常规接管：CAS 谓词命中（行仍 OFFLINE）→ 接管成功，patch 带 status=OFFLINE 谓词落库", async () => {
    const repo = makeRepo();
    repo.rows.push(deadOccupant());
    const svc = await buildService(repo);

    const { executor, perExecutorToken } = await svc.registerExecutor(
      takeoverPayload() as never,
    );

    expect(executor.id).toBe("victim-row");
    expect(perExecutorToken).not.toBeNull();
    const row = repo.rows[0];
    expect(row.status).toBe(ExecutorStatus.ONLINE);
    expect(row.deviceFingerprint).toBe(FP_NEW);
    // CAS 形态验证：写库调用必须带 status=OFFLINE 谓词（E-1 的核心落点）。
    expect(repo.update).toHaveBeenCalledWith(
      { id: "victim-row", status: ExecutorStatus.OFFLINE },
      expect.objectContaining({
        status: ExecutorStatus.ONLINE,
        deviceFingerprint: FP_NEW,
      }),
    );
  });

  it("E-1 并发败家：判定通过但 CAS 谓词失配（行已被并发赢家点亮）→ 409 EXECUTOR_ADDRESS_TAKEN 且零写入", async () => {
    const repo = makeRepo();
    repo.rows.push(deadOccupant());
    const svc = await buildService(repo);

    // 模拟并发赢家：在「判定之后、尾部 update 之前」的窗口把行点亮（并发
    // 心跳/另一接管方的 update 落地）。判定的 findOne 是快照读，不受影响；
    // 失配点在尾部 CAS update。
    const origUpdate = repo.update.getMockImplementation();
    repo.update.mockImplementation(async (criteria: any, patch: any) => {
      // 仅拦截**带 status 谓词**的接管写：先让行变 ONLINE（赢家落库），再按
      // 严格谓词执行 → 必失配。
      if (criteria?.status === ExecutorStatus.OFFLINE) {
        const row = repo.rows.find((r: any) => r.id === criteria.id);
        if (row) row.status = ExecutorStatus.ONLINE;
      }
      return origUpdate(criteria, patch);
    });

    const err = await svc.registerExecutor(takeoverPayload() as never).then(
      () => null,
      (e: unknown) => e,
    );

    expect((err as any)?.errorCode).toBe("EXECUTOR_ADDRESS_TAKEN");
    // 零写入：败家的指纹/身份列不得覆盖赢家。
    const row = repo.rows[0];
    expect(row.deviceFingerprint).toBe(FP_OLD);
    expect(row.appName).toBe("old-install");
  });

  it("E-1 令牌不被并发败家重签：失配路径在 rotateToken 之前收口", async () => {
    const repo = makeRepo();
    repo.rows.push(deadOccupant());
    const svc = await buildService(repo);
    const origUpdate = repo.update.getMockImplementation();
    repo.update.mockImplementation(async (criteria: any, patch: any) => {
      if (criteria?.status === ExecutorStatus.OFFLINE) {
        const row = repo.rows.find((r: any) => r.id === criteria.id);
        if (row) row.status = ExecutorStatus.ONLINE;
      }
      return origUpdate(criteria, patch);
    });

    await svc
      .registerExecutor(takeoverPayload() as never)
      .catch(() => undefined);

    // registerExecutor 的 rotateToken 只在 register 成功后触达——失配路径
    // 409 抛出后行上的 tokenHash 必须保持赢家/原值，不被败家轮换。
    expect(repo.rows[0].tokenHash).toBe("$2b$12$oldhash");
  });

  it("E-1 常规注册路径行为不变：非接管注册仍走裸 id update（无 status 谓词）", async () => {
    const repo = makeRepo();
    // 同安装重注册（同指纹 → byFingerprint 命中，不进接管分支）。
    repo.rows.push(
      deadOccupant({
        status: ExecutorStatus.ONLINE,
        deviceFingerprint: FP_NEW,
        appName: "same-install",
      }),
    );
    const svc = await buildService(repo);

    await svc.registerExecutor(
      takeoverPayload({ appName: "same-install" }) as never,
    );

    const casCalls = repo.update.mock.calls.filter(
      (c: any[]) => c[0]?.status === ExecutorStatus.OFFLINE,
    );
    expect(casCalls).toEqual([]); // 常规路径不带谓词
    expect(repo.update).toHaveBeenCalledWith(
      { id: "victim-row" },
      expect.objectContaining({ status: ExecutorStatus.ONLINE }),
    );
  });

  it("E-2 接管清零幻影 runningTaskCount：无重启信号（无 startupId/restartedAt）也清零并落库", async () => {
    const repo = makeRepo();
    repo.rows.push(deadOccupant({ runningTaskCount: 3 }));
    const svc = await buildService(repo);

    // 关键：不携带 startupId/restartedAt → didRestart 与
    // shouldRecoverMissingBaseline 都判假 → 既有清零分支不进，清零必须来自
    // 接管分支（E-2）。
    const { executor } = await svc.registerExecutor(
      takeoverPayload({ startupId: undefined }) as never,
    );

    expect(executor.id).toBe("victim-row");
    expect(repo.rows[0].runningTaskCount).toBe(0);
  });

  it("E-2 didRestart 判真时清零语义不变（幂等，计数仍为 0）", async () => {
    const repo = makeRepo();
    repo.rows.push(deadOccupant({ runningTaskCount: 5 }));
    const svc = await buildService(repo);

    await svc.registerExecutor(takeoverPayload() as never); // 带 startupId → didRestart

    expect(repo.rows[0].runningTaskCount).toBe(0);
  });

  it("E-2 非接管的重注册不清零他人计数（防误伤：常规路径无清零）", async () => {
    const repo = makeRepo();
    // 同安装重注册，行上计数 3（心跳真实值），payload 不带重启信号。
    repo.rows.push(
      deadOccupant({
        status: ExecutorStatus.ONLINE,
        deviceFingerprint: FP_NEW,
        runningTaskCount: 3,
      }),
    );
    const svc = await buildService(repo);

    await svc.registerExecutor(
      takeoverPayload({ startupId: undefined }) as never,
    );

    expect(repo.rows[0].runningTaskCount).toBe(3); // 未被注册面清掉（心跳是计数主人）
  });
});
