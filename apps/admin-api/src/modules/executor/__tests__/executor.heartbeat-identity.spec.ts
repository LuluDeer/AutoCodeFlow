import { Test } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConflictException, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ExecutorService,
  __resetMissingFingerprintWarnForTest,
} from "../executor.service";
import { Executor, ExecutorStatus } from "../entities/executor.entity";
import { ExecutorMetricsHistory } from "../entities/executor-metrics-history.entity";
import { Task } from "../../task/entities/task.entity";
import { TaskExecution } from "../../task/entities/task-execution.entity";
import { NotificationService } from "../../notification/notification.service";
import { SystemConfigService } from "../../config/config.service";
import { AppError } from "../../../common/errors/app-error";
import { SecretsCryptoService } from "../../../common/utils/secret-crypto.util.service";

/**
 * R32-C4（L1）：heartbeat 的**地址兜底 findOne 首行获胜**。
 *
 * ADR-017 §5 明文允许「同地址多行」（pull 模式两台机器同网段同 IP 各自成行），
 * 此时身份只能由 `deviceFingerprint` 消歧：
 *  - 认证面 `validateTokenByAddress` → `resolveExecutorRow` 对「同址多行 + 无指纹」
 *    是 **fail-closed**（返回 null），但共享令牌兜底让请求仍然**认证通过**；
 *  - 服务面 `heartbeat` 自己做身份解析时只做 `findOne({ where: { address } })`
 *    （无 ORDER BY）⇒ **首行获胜**。
 *
 * 实测（修复前）：心跳把整行（status / runningTaskCount / cpu / lastHeartbeat）
 * 写进首行 —— 已下线的 legacy 旧行被点亮成 ONLINE、槽位被改写成别人上报的值；
 * 把两行的堆序翻转，受害者就换成另一行 ⇒ 落点由 DB 行序决定，与身份无关。
 *
 * 修复口径：与认证面同策 **fail-closed** —— 同址多行且未命中指纹 ⇒ 拒绝
 * （409 EXECUTOR_ADDRESS_TAKEN，register 面同条件同码）。单行地址行为不变。
 */

const ADDR = "192.168.1.100:8002";
const FP_B = "b2".repeat(32);
const SHARED_TOKEN = "shared-token-for-r32c4";

type Row = Record<string, unknown>;

const makeRepo = () => {
  const repo: Record<string, jest.Mock> = {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    findBy: jest.fn().mockResolvedValue([]),
    create: jest.fn((d: unknown) => d),
    save: jest.fn((e: unknown) => Promise.resolve(e)),
    // R53-A1：heartbeat 的写面已改为列级 update。替身**应用** patch（而不是返回
    // 一个空 affected），否则「心跳是否真的落库」这条断言会退化成"看内存对象"。
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    increment: jest.fn().mockResolvedValue(undefined),
    decrement: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    count: jest.fn().mockResolvedValue(0),
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
  };
  repo.createQueryBuilder = jest.fn(() => ({
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    getMany: jest.fn(() => repo.find()),
    getOne: jest.fn().mockResolvedValue(null),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    returning: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
    getRawOne: jest.fn().mockResolvedValue(null),
    getCount: jest.fn().mockResolvedValue(0),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  }));
  repo.manager = {
    createQueryBuilder: jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    })),
  } as never;
  return repo;
};

/**
 * 把仓储 mock 配成「真数据库」的形态：
 *  - `findOne({ where: { address } })` 返回**表里的首行**（无 ORDER BY ⇒ 堆序，
 *    正是生产上「首行获胜」的成因）；
 *  - `find({ where: { address } })` 返回**全部同址行**（唯一性判据的真相）；
 *  - 指纹查询按指纹命中。
 */
const bindRows = (repo: ReturnType<typeof makeRepo>, rows: Row[]) => {
  repo.findOne.mockImplementation(async (opts: any) => {
    const where = opts?.where;
    if (!where) return null;
    if (where.deviceFingerprint !== undefined) {
      return (
        rows.find((r) => r.deviceFingerprint === where.deviceFingerprint) ??
        null
      );
    }
    if (where.address !== undefined) {
      return rows.find((r) => r.address === where.address) ?? null;
    }
    return null;
  });
  repo.find.mockImplementation(async (opts: any) => {
    const where = opts?.where;
    return where?.address !== undefined
      ? rows.filter((r) => r.address === where.address)
      : rows;
  });
};

const row = (overrides: Row = {}): Row => ({
  id: "e1",
  address: ADDR,
  appName: "node-a",
  status: ExecutorStatus.ONLINE,
  dispatchMode: "pull",
  runningTaskCount: 0,
  maxConcurrentTasks: 4,
  version: 1,
  ...overrides,
});

/** 已下线的 legacy 旧行（表里首行；无真实指纹，只有合成键）。 */
const legacyRow = (overrides: Row = {}): Row =>
  row({
    id: "old-legacy-row",
    appName: "legacy-node",
    status: ExecutorStatus.OFFLINE,
    deviceFingerprint: `legacy:${ADDR}`,
    cpuUsage: 3,
    lastHeartbeat: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  });

/** 活着的 v3 行（带真实指纹），只是本次心跳没带指纹。 */
const liveRow = (overrides: Row = {}): Row =>
  row({
    id: "live-v3-row",
    appName: "v3-node",
    deviceFingerprint: FP_B,
    cpuUsage: 1,
    lastHeartbeat: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  });

describe("R32-C4 L1 — heartbeat 同址多行 + 无指纹：身份不可判定必须拒绝", () => {
  let executorRepo: ReturnType<typeof makeRepo>;
  let metricsHistoryRepo: ReturnType<typeof makeRepo>;
  let service: ExecutorService;

  const buildService = async (): Promise<ExecutorService> => {
    const module = await Test.createTestingModule({
      providers: [
        ExecutorService,
        { provide: getRepositoryToken(Executor), useValue: executorRepo },
        { provide: getRepositoryToken(TaskExecution), useValue: makeRepo() },
        { provide: getRepositoryToken(Task), useValue: makeRepo() },
        {
          provide: getRepositoryToken(ExecutorMetricsHistory),
          useValue: metricsHistoryRepo,
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
          // 共享令牌：认证面的兜底凭据（DB 优先，env 兜底）。
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

  beforeEach(() => {
    executorRepo = makeRepo();
    metricsHistoryRepo = makeRepo();
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "debug").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // 双向都钉住：受害行不得依赖 DB 行序（修复前两个方向各写坏一行，其中一个方向
  // 甚至会把 legacy 旧行点亮成 ONLINE，派发闸门随后按它的空槽位派任务）。
  it.each([
    ["legacy 旧行排在首行", true],
    ["v3 活行排在首行", false],
  ])(
    "共享令牌 + 无指纹 + 同址两行（%s）→ 409，两行都不被改写",
    async (_label, legacyFirst) => {
      const legacy = legacyRow();
      const live = liveRow();
      bindRows(executorRepo, legacyFirst ? [legacy, live] : [live, legacy]);
      service = await buildService();

      // 前置：认证面此时是**通过**的（共享令牌兜底）——缺陷的入口条件。
      await expect(
        service.validateTokenByAddress(ADDR, SHARED_TOKEN),
      ).resolves.toBe(true);

      const err = await service
        .heartbeat(ADDR, { cpuUsage: 87, memUsage: 55, runningTaskCount: 3 })
        .then(
          () => null,
          (e: unknown) => e,
        );

      // AppError 按状态码把原型挂到内置异常类上（app-error.ts），409 ⇒ ConflictException。
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as AppError).errorCode).toBe("EXECUTOR_ADDRESS_TAKEN");
      expect((err as AppError).getStatus()).toBe(409);
      // 整行零写入：谁都没被点亮 / 被改指标，也没留 metrics history。
      expect(legacy).toMatchObject({
        status: ExecutorStatus.OFFLINE,
        cpuUsage: 3,
        runningTaskCount: 0,
      });
      expect(live).toMatchObject({
        status: ExecutorStatus.ONLINE,
        cpuUsage: 1,
        runningTaskCount: 0,
      });
      // R53-A1：写面是列级 update —— 拒绝路径必须**两种写面都没有**调用。
      expect(executorRepo.save).not.toHaveBeenCalled();
      expect(executorRepo.update).not.toHaveBeenCalled();
      expect(metricsHistoryRepo.save).not.toHaveBeenCalled();
    },
  );

  it("同址两行但带指纹（v3 执行器常态）→ 按指纹命中自己的行，不误伤", async () => {
    const rowA = legacyRow();
    const rowB = liveRow();
    bindRows(executorRepo, [rowA, rowB]);
    service = await buildService();

    const saved = (await service.heartbeat(ADDR, {
      cpuUsage: 87,
      deviceFingerprint: FP_B,
    })) as unknown as Row;

    expect(saved.id).toBe("live-v3-row");
    expect(rowB.cpuUsage).toBe(87);
    // 首行（legacy 旧行）一个字都不动。
    expect(rowA).toMatchObject({ status: ExecutorStatus.OFFLINE, cpuUsage: 3 });
  });

  it("单行地址 + 无指纹（存量 legacy 执行器）→ 行为逐字节不变：正常写入该行", async () => {
    const onlyRow = row({
      id: "legacy-only",
      appName: "legacy-node",
      deviceFingerprint: null,
      cpuUsage: 5,
    });
    bindRows(executorRepo, [onlyRow]);
    service = await buildService();

    // 前置：单行时认证面同样通过（共享令牌兜底，与引入本改动前一致）。
    await expect(
      service.validateTokenByAddress(ADDR, SHARED_TOKEN),
    ).resolves.toBe(true);

    const saved = (await service.heartbeat(ADDR, {
      cpuUsage: 42,
      runningTaskCount: 2,
    })) as unknown as Row;

    expect(saved.id).toBe("legacy-only");
    expect(onlyRow).toMatchObject({ cpuUsage: 42, runningTaskCount: 2 });
    // R53-A1：写面从整行 save 换成「实际采纳字段」的列级 patch。
    expect(executorRepo.save).not.toHaveBeenCalled();
    expect(executorRepo.update).toHaveBeenCalledTimes(1);
    const [hbCriteria, hbPatch] = (executorRepo.update as jest.Mock).mock
      .calls[0];
    expect(hbCriteria).toEqual({ id: "legacy-only" });
    // 本次上报的两列必须进 patch；管理台拥有的列一个都不许进。
    expect(hbPatch).toMatchObject({ cpuUsage: 42, runningTaskCount: 2 });
    expect(hbPatch).toHaveProperty("status", ExecutorStatus.ONLINE);
    for (const notOwned of [
      "appName",
      "maxConcurrentTasks",
      "dispatchMode",
      "version",
    ]) {
      expect(hbPatch).not.toHaveProperty(notOwned);
    }
  });

  // P1（生产报告 2026-10-22 §4.6 / 结论 H）：日志里要能回答「刚才那条
  // fail-closed 是哪台机器发的」。现场 36 次 `Identity resolution … is ambiguous`
  // 只证明了「有一台不带指纹」，却指不出是哪台（请求体不落日志）。
  it("不带指纹的心跳 → 一条节流诊断 warn（含 appName/address/dispatchMode）", async () => {
    __resetMissingFingerprintWarnForTest();
    const onlyRow = row({
      id: "no-fp",
      appName: "legacy-node",
      deviceFingerprint: null,
    });
    bindRows(executorRepo, [onlyRow]);
    service = await buildService();
    const warnSpy = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);

    await service.heartbeat(ADDR, { cpuUsage: 10 });
    await service.heartbeat(ADDR, { cpuUsage: 11 });

    const hits = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes("without a parseable deviceFingerprint"),
    );
    // 第一跳记一条；第二跳被 1h 节流（心跳 30s 一台，不节流会刷屏）。
    expect(hits).toHaveLength(1);
    expect(String(hits[0][0])).toContain("legacy-node");
    expect(String(hits[0][0])).toContain(ADDR);
    expect(String(hits[0][0])).toContain("dispatchMode=");
    warnSpy.mockRestore();
  });

  // P1-2（ADR-017 阶段 3 复查补口）：同一地址被**另一份安装**接手（DHCP 把同一
  // IP 先后分给两台机器，现场 17:33/17:34 实证）时，心跳不得把别人的指纹写进
  // 这一行。旧实现会如此：两台机器每 30s 互改同一行的指纹，行身份来回漂移，
  // 注册面刚裁定的归属被心跳面悄悄推翻。
  it("单行地址 + **不同**的真实指纹 → 不覆盖本行已存指纹（身份不互窃）", async () => {
    const ownerRow = row({
      id: "owner-row",
      appName: "boss1",
      deviceFingerprint: FP_B,
      cpuUsage: 1,
    });
    bindRows(executorRepo, [ownerRow]);
    service = await buildService();
    const intrusiveFp = "c3".repeat(32);

    const saved = (await service.heartbeat(ADDR, {
      cpuUsage: 66,
      deviceFingerprint: intrusiveFp,
    })) as unknown as Row;

    // 心跳本身仍然成功（状态/指标照常收敛——拒绝的是"改身份"，不是"拒绝心跳"）。
    expect(saved.id).toBe("owner-row");
    // 指纹这一列**不进** patch：行身份留在它自己的安装手里。
    const [, patch] = (executorRepo.update as jest.Mock).mock.calls[0];
    expect(patch).not.toHaveProperty("deviceFingerprint");
    expect(ownerRow.deviceFingerprint).toBe(FP_B);
  });
});
