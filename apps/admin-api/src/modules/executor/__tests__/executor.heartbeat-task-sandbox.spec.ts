import { Logger } from "@nestjs/common";
import {
  ExecutorService,
  __resetMissingFingerprintWarnForTest,
} from "../executor.service";
import { ExecutorStatus } from "../entities/executor.entity";

/**
 * S4-C4（沙箱姿态在控制面可见，协议 v9）的专项用例。
 *
 * ## 要修的缺陷
 *
 * `TASK_SANDBOX` 此前只在执行器本地读一次（executor-node `config.taskSandbox`
 * / executor-python `settings.task_sandbox`），**不上报**：控制面没有任何途径
 * 知道某台机器是否在 fail-closed 沙箱里。于是「默认关」是运维的**显式取舍**
 * 还是**疏忽**在控制面上不可区分，安全评审只能 SSH 上机看环境变量。
 *
 * ## 本 spec 钉住的判据（三态纪律，塌成两态就退回原状）
 *
 * | 心跳载荷 | 期望落库 | 语义 |
 * |---|---|---|
 * | `taskSandbox: 'bwrap'` | `'bwrap'` | 已上报且在沙箱里 |
 * | `taskSandbox: ''` | `''`（**不是** null） | 已上报且**直跑** |
 * | 键**缺席** | `null`（**不是** `''`） | **未上报**（旧执行器） |
 * | 非法值（`'docker'` / `'BWRAP'` / `1` …） | 保持原值 + warn | 按未上报处理（fail-safe） |
 *
 * 最后一行的方向是刻意的：宁可让读面显示「不知道」，也不把非法值猜成直跑
 * （假的安全结论）或沙箱（隐瞒真缺口）。同时「缺席不清空」是兼容性红线——
 * 升级期新旧执行器并存，旧心跳绝不能把一台已上报 `'bwrap'` 的机器擦成未上报。
 *
 * harness：与 executor.heartbeat-conflict-selfreport.spec 同款——直接
 * `new ExecutorService(...)`，repo 替身按「真数据库」语义实现（`update` 按
 * criteria 严格匹配应用 patch），因此「是否真的落库」不退化为看内存对象。
 * 断言用的是**真实输出**（`expect(row.taskSandbox).toBeNull()`）：把「缺席」
 * 误实现成写 `''` 会让绿变红，这正是本项最容易犯的那个错。
 */

const ADDR = "10.9.9.9:8002";
const FP = "ab".repeat(32);

type Row = Record<string, any>;

/** 带状态的 repo 替身：谓词式 findOne + criteria 严格匹配的 update。 */
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
    find: jest.fn(async (_opts: any) => []),
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
      const qb: any = {
        addSelect: () => qb,
        select: () => qb,
        where: () => qb,
        andWhere: () => qb,
        update: () => qb,
        set: () => qb,
        returning: () => qb,
        getOne: async () => null,
        getMany: async () => [],
        getRawMany: async () => [],
        getRawOne: async () => null,
        getCount: async () => 0,
        execute: async () => ({ affected: 0, raw: [] }),
      };
      return qb;
    }),
  };
  repo.manager = {
    createQueryBuilder: jest.fn(() => repo.createQueryBuilder()),
  };
  return repo;
};

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
  // 与 executor.heartbeat-conflict-selfreport.spec 同款 22 位置参数装配。
  const svc = new ExecutorService(
    repo,
    makeRepo(),
    makeRepo(),
    makeRepo(), // metrics history（heartbeat 的 best-effort 快照）
    { add: jest.fn() } as never,
    makeConfig(configOverrides) as never,
    {
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
    null as never, // leaderGate
    null as never, // pullService
    null as never, // applicationRepo
    null as never, // deployment repo
    null as never, // tokenCacheSync
    null as never, // mutexGroupRepo
    null as never, // applicationVersionRepo
    null as never, // executorAppVersionRepo
    {
      transaction: async (fn: any) => fn({ getRepository: () => null }),
    } as never, // DataSource
  );
  return svc;
};

/** 一台健康在线、带真实指纹的 push 执行器（姿态列为初始 null = 未上报）。 */
const healthyRow = (o: Row = {}): Row => ({
  id: "exec-1",
  address: ADDR,
  appName: "exec",
  status: ExecutorStatus.ONLINE,
  dispatchMode: "push",
  deviceFingerprint: FP,
  executorVersion: "2.0.0",
  maxConcurrentTasks: 4,
  runningTaskCount: 0,
  consecutiveHeartbeatMisses: 0,
  lastHeartbeat: new Date(),
  executorStartedAt: new Date(Date.now() - 60_000),
  executorStartupId: "startup-1",
  // 存量行：迁移 1790000000088 之后、本执行器首次上报之前的形态。
  taskSandbox: null,
  version: 1,
  ...o,
});

const heartbeat = (o: Record<string, unknown> = {}) => ({
  cpuUsage: 10,
  memUsage: 20,
  runningTaskCount: 0,
  deviceFingerprint: FP,
  ...o,
});

let warnSpy: jest.SpyInstance;

beforeEach(() => {
  __resetMissingFingerprintWarnForTest();
  jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, "debug").mockImplementation(() => undefined);
  warnSpy = jest
    .spyOn(Logger.prototype, "warn")
    .mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("S4-C4 — 沙箱姿态在控制面可见（协议 v9 心跳键 taskSandbox）", () => {
  it("心跳带 'bwrap' ⇒ 落库 'bwrap'，且出现在执行器详情响应里", async () => {
    const repo = makeRepo();
    repo.rows.push(healthyRow());
    const svc = await buildService(repo);

    const saved = await svc.heartbeat(
      ADDR,
      heartbeat({ taskSandbox: "bwrap" }),
    );

    // 落库（repo 替身按 criteria 应用 patch —— 这条断言的是真写库）
    expect(repo.rows[0].taskSandbox).toBe("bwrap");
    // 返回体（心跳回执）
    expect(saved.taskSandbox).toBe("bwrap");
    // 详情读面（GET /executors/:id → svc.findOne：直接展开实体）
    const detail = await svc.findOne("exec-1");
    expect(detail.taskSandbox).toBe("bwrap");
  });

  it("心跳带 '' ⇒ 落库 ''（**不是** null）：已上报且直跑是一个真值", async () => {
    const repo = makeRepo();
    repo.rows.push(healthyRow());
    const svc = await buildService(repo);

    await svc.heartbeat(ADDR, heartbeat({ taskSandbox: "" }));

    // 真实输出：空串必须被当成合法值落库，绝不能与「未上报」混为一谈。
    expect(repo.rows[0].taskSandbox).toBe("");
    expect(repo.rows[0].taskSandbox).not.toBeNull();
    // 且不能触发非法值 warn（空串是合法取值）
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("invalid taskSandbox"),
    );
  });

  it("心跳**缺席** ⇒ 字段为 null（**不是** ''）——「未上报」≠「直跑」", async () => {
    const repo = makeRepo();
    repo.rows.push(healthyRow());
    const svc = await buildService(repo);

    // 旧执行器：整个键不存在（JSON 里没有这个字段）
    await svc.heartbeat(ADDR, heartbeat());

    // 这条断言就是本项的核心：缺席读成空串 = 把「不知道」伪装成「确认直跑」，
    // 安全评审会据此得出一个假结论。真实输出必须是 null。
    expect(repo.rows[0].taskSandbox).toBeNull();
    expect(repo.rows[0].taskSandbox).not.toBe("");
    const detail = await svc.findOne("exec-1");
    expect(detail.taskSandbox).toBeNull();
  });

  it("旧执行器缺席**不清空**已上报的姿态（升级期新旧并存）", async () => {
    const repo = makeRepo();
    repo.rows.push(healthyRow({ taskSandbox: "bwrap" }));
    const svc = await buildService(repo);

    // 一台还没升级的执行器在同一行上发心跳（没有 taskSandbox 键）
    await svc.heartbeat(ADDR, heartbeat());

    expect(repo.rows[0].taskSandbox).toBe("bwrap");
  });

  it.each([
    ["docker", "非枚举值"],
    ["BWRAP", "大小写变体"],
    ["off", "别的约定"],
    [1, "非字符串"],
  ])(
    "非法值 %p（%s）⇒ warn + 按未上报处理（DB 保持 null）",
    async (bad, _why) => {
      const repo = makeRepo();
      repo.rows.push(healthyRow());
      const svc = await buildService(repo);

      await svc.heartbeat(ADDR, heartbeat({ taskSandbox: bad }));

      // fail-safe 方向：不猜，保持「不知道」
      expect(repo.rows[0].taskSandbox).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("invalid taskSandbox"),
      );
    },
  );

  it("非法值**不覆盖**已存姿态（不半采纳）", async () => {
    const repo = makeRepo();
    repo.rows.push(healthyRow({ taskSandbox: "" }));
    const svc = await buildService(repo);

    await svc.heartbeat(ADDR, heartbeat({ taskSandbox: "off" }));

    // 已上报「直跑」的行被一次畸形上报打回「未上报」是信息丢失，必须拒绝。
    expect(repo.rows[0].taskSandbox).toBe("");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("invalid taskSandbox"),
    );
  });
});
