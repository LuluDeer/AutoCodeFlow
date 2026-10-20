import { Test } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConflictException, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ExecutorService } from "../executor.service";
import { Executor, ExecutorStatus } from "../entities/executor.entity";
import { ExecutorMetricsHistory } from "../entities/executor-metrics-history.entity";
import { Task } from "../../task/entities/task.entity";
import { TaskExecution } from "../../task/entities/task-execution.entity";
import { NotificationService } from "../../notification/notification.service";
import { SystemConfigService } from "../../config/config.service";
import { AppError } from "../../../common/errors/app-error";
import { SecretsCryptoService } from "../../../common/utils/secret-crypto.util.service";

/**
 * R32-C5（L1，R32-C4 同族下一处）：register 的地址兜底 findOne 首行获胜。
 *
 * ADR-017 §5 明文允许「同地址多行」（pull 双机同网段同 IP 各自成行 / 存量
 * legacy 行与已升级行并存 / 迁移前 NULL 行）。此时身份只能由 deviceFingerprint
 * 消歧：
 *  - 认证面 validateTokenByAddress → resolveExecutorRow 对「同址多行 + 无指纹」
 *    fail-closed（返回 null），但共享令牌兜底让请求仍然认证通过；
 *  - 心跳面（R32-C4）已 fail-closed（409 EXECUTOR_ADDRESS_TAKEN）；
 *  - 服务面 register 自己做身份解析时只做 findOne({ where: { address } })，无
 *    ORDER BY ⇒ 首行获胜；且 foreignInstall 判据要求「入站指纹非空」——无指纹
 *    上报时它恒 false，判据挡不住。
 *
 * 实测（修复前）：
 *  - 首行是别人那份安装（真实指纹 FP_B）→ 注册 200，复用别人的行，就地改写
 *    appName / executorVersion / capabilities / interpreters / executorStartupId、
 *    点亮 ONLINE，并在 registerExecutor 里按同一行 rotateToken ⇒ 别人那行的
 *    per-executor 令牌被吊销，调用方拿到的是「绑在别人行上」的新令牌；
 *  - 翻转行序（legacy 墓碑行在首）→ 同一个请求改去接管已下线的 legacy 行并把
 *    它点亮成 ONLINE ⇒ 落点由 DB 行序决定，与身份无关。
 *
 * 修复口径：与认证面 / 心跳面同策 fail-closed —— 同址多行且本次未带指纹 ⇒
 * 409 EXECUTOR_ADDRESS_TAKEN，零写入（任何一行都不准被改写，令牌不准被吊销）。
 * 单行地址（引入 ADR-017 前的全部现实形态）行为逐字节不变。
 */

const ADDR = "192.168.1.100:8002";
const FP_A = "a1".repeat(32);
const FP_B = "b2".repeat(32);
const SHARED_TOKEN = "shared-token-for-r32c5";

type Row = Record<string, any>;

const clone = (r: Row | null) => (r ? { ...r } : null);

/**
 * 「真数据库」的查询时序：读出来的是**快照**（clone），写回才落到 rows 上。
 * 这一条很关键 —— 修复前的损害之一正是 register 先改行、registerExecutor 再读
 * prior，若 mock 直接返回对象引用，prior 会「看见」尚未提交的改动，
 * didRestart / sameProcess 判定失真。
 */
const makeQb = (rows: Row[]) => {
  let resolveOne: () => Row | null = () => null;
  let resolveMany: () => Row[] = () => [];
  const qb: any = {
    addSelect: () => qb,
    select: () => qb,
    where: (sql: string, params: any = {}) => {
      if (sql.includes("deviceFingerprint")) {
        resolveOne = () =>
          clone(rows.find((r) => r.deviceFingerprint === params.fp) ?? null);
        resolveMany = () =>
          rows.filter((r) => r.deviceFingerprint === params.fp).map(clone) as Row[];
      } else if (sql.includes("address")) {
        resolveOne = () =>
          clone(rows.find((r) => r.address === params.address) ?? null);
        resolveMany = () =>
          rows.filter((r) => r.address === params.address).map(clone) as Row[];
      } else if (sql.includes("id")) {
        resolveOne = () => clone(rows.find((r) => r.id === params.id) ?? null);
        resolveMany = () => rows.filter((r) => r.id === params.id).map(clone) as Row[];
      }
      return qb;
    },
    andWhere: () => qb,
    leftJoin: () => qb,
    update: () => qb,
    set: () => qb,
    execute: async () => ({ affected: 1 }),
    getOne: async () => resolveOne(),
    getMany: async () => resolveMany(),
    getCount: async () => 0,
    getRawMany: async () => [],
    getRawOne: async () => null,
  };
  return qb;
};

const makeRepo = (rows: Row[], ledger: Row[] = []) => {
  let seq = 0;
  const repo: any = {
    findOne: jest.fn(async (opts: any) => {
      const w = opts?.where ?? {};
      if (w.id !== undefined) return clone(rows.find((r) => r.id === w.id) ?? null);
      if (w.deviceFingerprint !== undefined)
        return clone(
          rows.find((r) => r.deviceFingerprint === w.deviceFingerprint) ?? null,
        );
      if (w.address !== undefined)
        return clone(rows.find((r) => r.address === w.address) ?? null);
      return null;
    }),
    find: jest.fn(async (opts: any) => {
      const w = opts?.where ?? {};
      const all =
        w.address !== undefined ? rows.filter((r) => r.address === w.address) : rows;
      return (opts?.take ? all.slice(0, opts.take) : all).map(clone);
    }),
    findBy: jest.fn().mockResolvedValue([]),
    // 创建同样返回快照（真 repo.create 不落库），save 才落到 rows 上。
    create: jest.fn((d: any) => ({ ...d })),
    save: jest.fn(async (e: any) => {
      ledger.push(JSON.parse(JSON.stringify(e)));
      if (e.id === undefined || e.id === null) e.id = "new-" + ++seq;
      const idx = rows.findIndex((r) => r.id === e.id);
      // 就地合并（模拟 UPDATE 落在同一行上）：fixture 的引用随之可见；读仍是快照。
      if (idx >= 0) Object.assign(rows[idx], e);
      else rows.push({ ...e });
      return e;
    }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    increment: jest.fn().mockResolvedValue(undefined),
    decrement: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    count: jest.fn().mockResolvedValue(0),
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
    createQueryBuilder: jest.fn(() => makeQb(rows)),
  };
  repo.manager = { createQueryBuilder: jest.fn(() => makeQb(rows)) } as never;
  return repo;
};

/** 别人那份安装的行（v3，真实指纹）。 */
const foreignRow = (o: Row = {}): Row => ({
  id: "victim-v3",
  address: ADDR,
  appName: "victim-node",
  status: ExecutorStatus.ONLINE,
  dispatchMode: "push",
  deviceFingerprint: FP_B,
  executorVersion: "1.0.0",
  capabilities: ["victim-cap"],
  interpreters: [{ version: "3.12" }],
  maxConcurrentTasks: 8,
  runningTaskCount: 2,
  tokenHash: "$2b$12$victimhash",
  ...o,
});

/**
 * 存量未升级 / 另一次安装的墓碑行（legacy 合成键，永不算真实指纹）。
 * dispatchMode 默认 'pull'：地址唯一索引是 **partial**（WHERE dispatchMode
 * = 'push'），所以「同址两行」在真库里恒为「至多一行 push + 若干行 pull」——
 * 这个 fixture 组合是 DB 可实现的，不是凭空造的。
 */
const legacyRow = (o: Row = {}): Row => ({
  id: "old-legacy",
  address: ADDR,
  appName: "legacy-node",
  status: ExecutorStatus.OFFLINE,
  dispatchMode: "pull",
  deviceFingerprint: "legacy:" + ADDR,
  executorVersion: "0.9.0",
  capabilities: ["legacy-cap"],
  maxConcurrentTasks: 2,
  runningTaskCount: 0,
  tokenHash: "$2b$12$legacyhash",
  ...o,
});

const INTRUDER = {
  appName: "intruder-node",
  address: ADDR,
  version: "9.9.9",
  capabilities: ["hijacked"],
  interpreters: [{ version: "3.11" }],
  maxConcurrentTasks: 1,
  startupId: "intruder-startup",
};

describe("R32-C5 L1 — register 同址多行 + 无指纹：身份不可判定必须拒绝", () => {
  let executorRepo: any;
  let ledger: Row[];
  let service: ExecutorService;

  const buildService = async (): Promise<ExecutorService> => {
    const module = await Test.createTestingModule({
      providers: [
        ExecutorService,
        { provide: getRepositoryToken(Executor), useValue: executorRepo },
        { provide: getRepositoryToken(TaskExecution), useValue: makeRepo([]) },
        { provide: getRepositoryToken(Task), useValue: makeRepo([]) },
        {
          provide: getRepositoryToken(ExecutorMetricsHistory),
          useValue: makeRepo([]),
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
            notifyFailureWithConfig: jest.fn(),
            notifyExecutorOnline: jest.fn().mockResolvedValue(undefined),
            notifyExecutorOffline: jest.fn().mockResolvedValue(undefined),
            sendAll: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          // 共享令牌：认证面的兜底凭据（DB 优先，env 兜底）—— 缺陷的入口条件。
          provide: SystemConfigService,
          useValue: {
            findOne: jest.fn(async (key: string) =>
              key === "executor.sharedToken" ? { value: SHARED_TOKEN } : null,
            ),
          },
        },
        {
          provide: SecretsCryptoService,
          useValue: new SecretsCryptoService({ get: () => "" } as any),
        },
      ],
    }).compile();
    return module.get(ExecutorService);
  };

  const setup = async (rows: Row[]) => {
    ledger = [];
    executorRepo = makeRepo(rows, ledger);
    service = await buildService();
  };

  const registerPayload = (overrides: Row = {}) => ({ ...INTRUDER, ...overrides });

  beforeEach(() => {
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "debug").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // 双向 × 两模式都钉住：落点不得依赖 DB 行序，也不得因 push/pull 而不同
  // （pull 的下场更糟：本该「各自成行」，实际是接管别人的墓碑行）。
  it.each([
    ["别人 v3 行在首行 / push", true, "push"],
    ["别人 v3 行在首行 / pull", true, "pull"],
    ["legacy 墓碑行在首行 / push", false, "push"],
    ["legacy 墓碑行在首行 / pull", false, "pull"],
  ])(
    "共享令牌 + 无指纹 + 同址两行（%s）→ 409，两行零写入、令牌不被吊销",
    async (_label: string, foreignFirst: boolean, dispatchMode: string) => {
      const foreign = foreignRow();
      const legacy = legacyRow();
      await setup(foreignFirst ? [foreign, legacy] : [legacy, foreign]);

      // 前置：认证面对这种请求是**通过**的（共享令牌兜底）—— 缺陷的真实入口。
      await expect(
        service.validateTokenByAddress(ADDR, SHARED_TOKEN),
      ).resolves.toBe(true);

      const err = await service
        .registerExecutor(registerPayload({ dispatchMode }) as any)
        .then(
          () => null,
          (e: unknown) => e,
        );

      expect(err).toBeInstanceOf(ConflictException);
      expect((err as AppError).errorCode).toBe("EXECUTOR_ADDRESS_TAKEN");
      expect((err as AppError).getStatus()).toBe(409);
      // 零写入：register 的白名单改写与 registerExecutor 的 rotateToken 都不许发生。
      expect(executorRepo.save).not.toHaveBeenCalled();
      expect(ledger).toEqual([]);
      // 两行都保持原样（身份 / 元数据 / 令牌 / 在线态 / 槽位）。
      expect(foreign).toMatchObject({
        appName: "victim-node",
        status: ExecutorStatus.ONLINE,
        executorVersion: "1.0.0",
        capabilities: ["victim-cap"],
        interpreters: [{ version: "3.12" }],
        maxConcurrentTasks: 8,
        runningTaskCount: 2,
        tokenHash: "$2b$12$victimhash",
      });
      expect(foreign.executorStartupId).toBeUndefined();
      expect(legacy).toMatchObject({
        appName: "legacy-node",
        status: ExecutorStatus.OFFLINE,
        executorVersion: "0.9.0",
        capabilities: ["legacy-cap"],
        maxConcurrentTasks: 2,
        tokenHash: "$2b$12$legacyhash",
      });
      expect(legacy.executorStartupId).toBeUndefined();
    },
  );

  it("同址两行 + 上报了自己的指纹（v3 执行器常态）→ 按指纹命中自己的行，不碰别人", async () => {
    const foreign = foreignRow();
    const mine = legacyRow({ id: "mine-v3", deviceFingerprint: FP_A, appName: "mine-node" });
    await setup([foreign, mine]);

    const { executor, perExecutorToken } = await service.registerExecutor(
      registerPayload({ appName: "mine-node", deviceFingerprint: FP_A }) as any,
    );

    expect(executor.id).toBe("mine-v3");
    // 自己那行照常采纳上报（修复不得把 v3 执行器一起挡死）。
    expect(mine).toMatchObject({ executorVersion: "9.9.9", capabilities: ["hijacked"] });
    expect(perExecutorToken).not.toBeNull();
    // 别人那行一个字都不动。
    expect(foreign).toMatchObject({
      appName: "victim-node",
      executorVersion: "1.0.0",
      capabilities: ["victim-cap"],
      tokenHash: "$2b$12$victimhash",
    });
  });

  it("同址两行 + 全新指纹（pull：地址只是标签）→ 仍按 ADR-017 §5 各自成行", async () => {
    const foreign = foreignRow();
    const legacy = legacyRow();
    await setup([foreign, legacy]);

    const { executor, perExecutorToken } = await service.registerExecutor(
      registerPayload({ dispatchMode: "pull", deviceFingerprint: FP_A }) as any,
    );

    expect(executor.id).toBe("new-1");
    expect(executor.deviceFingerprint).toBe(FP_A);
    expect(perExecutorToken).not.toBeNull();
    // 既有两行零改写（含令牌）。
    expect(foreign).toMatchObject({
      appName: "victim-node",
      tokenHash: "$2b$12$victimhash",
      status: ExecutorStatus.ONLINE,
    });
    expect(legacy).toMatchObject({
      appName: "legacy-node",
      tokenHash: "$2b$12$legacyhash",
      status: ExecutorStatus.OFFLINE,
    });
  });

  it("同址两行 + 陌生指纹（push：地址是路由面）→ 409，沿用既有 foreignInstall 口径", async () => {
    const foreign = foreignRow();
    const other = legacyRow({ id: "other-v3", deviceFingerprint: FP_A });
    await setup([foreign, other]);

    const err = await service
      .registerExecutor(
        registerPayload({ deviceFingerprint: "c3".repeat(32) }) as any,
      )
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as AppError).errorCode).toBe("EXECUTOR_ADDRESS_TAKEN");
    expect(executorRepo.save).not.toHaveBeenCalled();
  });

  it("单行地址 + 无指纹（存量 legacy 执行器）→ 行为逐字节不变：复用自己的行", async () => {
    const onlyRow = legacyRow({ appName: "legacy-node", status: ExecutorStatus.OFFLINE });
    await setup([onlyRow]);

    await expect(
      service.validateTokenByAddress(ADDR, SHARED_TOKEN),
    ).resolves.toBe(true);

    const { executor, perExecutorToken } = await service.registerExecutor(
      registerPayload({ appName: "legacy-node" }) as any,
    );

    expect(executor.id).toBe("old-legacy");
    expect(onlyRow).toMatchObject({
      appName: "legacy-node",
      status: ExecutorStatus.ONLINE,
      executorVersion: "9.9.9",
      capabilities: ["hijacked"],
      executorStartupId: "intruder-startup",
    });
    // 该地址的第一份令牌照常签发（与引入本改动前一致）。
    expect(perExecutorToken).not.toBeNull();
    expect(onlyRow.tokenHash).not.toBe("$2b$12$legacyhash");
  });

  // ── R32-C6（C5 遗留①）：带**真实指纹**但首行是 legacy 行时的「升级接管」歧义 ──
  //
  // foreignInstall 把 legacy / NULL 行判为"不算占用"，于是落到 else 分支直接
  // e = byAddress —— 语义是"这台机器升级上来了，接管自己那行老行"。当地址只有
  // 一行时成立；同址还有别的行时，byAddress 只是**首行**，接管就是把别人的墓碑行
  // 改写成自己（随后 rotateToken 吊销对方令牌）。
  it("首行是 legacy 行 + 同址还有别的行 + 上报真实指纹 / push → 409，两行零写入", async () => {
    const legacy = legacyRow();
    const foreign = foreignRow();
    await setup([legacy, foreign]);

    const err = await service
      .registerExecutor(registerPayload({ dispatchMode: "push", deviceFingerprint: FP_A }) as any)
      .then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as AppError).errorCode).toBe("EXECUTOR_ADDRESS_TAKEN");
    expect(executorRepo.save).not.toHaveBeenCalled();
    expect(ledger).toEqual([]);
    expect(legacy).toMatchObject({
      appName: "legacy-node",
      status: ExecutorStatus.OFFLINE,
      tokenHash: "$2b$12$legacyhash",
    });
    expect(foreign).toMatchObject({ appName: "victim-node", tokenHash: "$2b$12$victimhash" });
  });

  it("同形态 / pull → 不接管、新建独立行；legacy 行与别人那行都原样不动", async () => {
    const legacy = legacyRow();
    const foreign = foreignRow();
    await setup([legacy, foreign]);

    const { executor } = await service.registerExecutor(
      registerPayload({ dispatchMode: "pull", deviceFingerprint: FP_A }) as any,
    );

    // 新行：不是 legacy 那行，也不是别人那行。
    expect(executor.id).not.toBe("old-legacy");
    expect(executor.id).not.toBe("victim-v3");
    expect(executor.deviceFingerprint).toBe(FP_A);
    expect(executor.appName).toBe("intruder-node");
    // legacy 行一个字都没被改写（含令牌与在线态）。
    expect(legacy).toMatchObject({
      appName: "legacy-node",
      status: ExecutorStatus.OFFLINE,
      executorVersion: "0.9.0",
      capabilities: ["legacy-cap"],
      tokenHash: "$2b$12$legacyhash",
    });
    expect(legacy.executorStartupId).toBeUndefined();
    expect(foreign).toMatchObject({ appName: "victim-node", tokenHash: "$2b$12$victimhash" });
  });

  it("对照组：地址只有一行 legacy + 上报真实指纹 → 仍按「升级接管」复用该行（不加严）", async () => {
    const onlyRow = legacyRow();
    await setup([onlyRow]);

    const { executor } = await service.registerExecutor(
      registerPayload({ dispatchMode: "push", deviceFingerprint: FP_A, appName: "legacy-node" }) as any,
    );

    expect(executor.id).toBe("old-legacy");
    expect(onlyRow.deviceFingerprint).toBe(FP_A);
    expect(onlyRow.status).toBe(ExecutorStatus.ONLINE);
  });
});
