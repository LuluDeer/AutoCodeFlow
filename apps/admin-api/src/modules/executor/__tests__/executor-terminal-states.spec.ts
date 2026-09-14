import { Test } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import { getRepositoryToken } from "@nestjs/typeorm";
import { UnauthorizedException } from "@nestjs/common";
import { ExecutorController } from "../executor.controller";
import { ExecutorService } from "../executor.service";
import { Executor } from "../entities/executor.entity";
import { ExecutorMetricsHistory } from "../entities/executor-metrics-history.entity";
import { Task } from "../../task/entities/task.entity";
import {
  TaskExecution,
  ExecutionStatus,
} from "../../task/entities/task-execution.entity";
import {
  TERMINAL_EXECUTION_STATUSES,
  OPEN_EXECUTION_STATUSES,
} from "../../task/execution-terminal";
import { NotificationService } from "../../notification/notification.service";
import { SystemConfigService } from "../../config/config.service";
import { SecretsCryptoService } from "../../../common/utils/secret-crypto.util.service";
import { ConfigService } from "@nestjs/config";
import {
  TERMINAL_STATES_MAX_LIMIT,
  TERMINAL_STATES_MAX_LOOKBACK_MS,
  TERMINAL_STATES_DEFAULT_LOOKBACK_MS,
} from "../executor.service";

/**
 * A6（DEEP_REVIEW §七）：死信对账端点 GET /executors/:address/terminal-states。
 *
 * 本文件的断言按「反证必须有牙」的要求组织：每条断言在把实现改回旧行为（不
 * 校验令牌 / 不钳位 / 不判 hasMore / 终态集合各自抄写）时都必须转红，而不是
 * 恒真通过。
 */

/** 记录 QueryBuilder 调用链的 mock（比 service 主 spec 的 makeRepo 多 take/offset）。 */
function makeExecRepo(rows: Array<Partial<TaskExecution>>) {
  const qb: Record<string, jest.Mock> = {
    select: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    take: jest.fn(),
  };
  const chain = {
    ...qb,
  } as any;
  Object.keys(qb).forEach((k) => {
    chain[k] = jest.fn(() => chain);
  });
  chain.getMany = jest.fn().mockResolvedValue(rows);
  chain.getOne = jest.fn().mockResolvedValue(null);
  chain.execute = jest.fn().mockResolvedValue({ affected: 0, raw: [] });
  return {
    calls: chain,
    repo: {
      createQueryBuilder: jest.fn(() => chain),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn((e: unknown) => Promise.resolve(e)),
    },
  };
}

describe("A6 — GET /executors/:address/terminal-states", () => {
  describe("service: getTerminalStates", () => {
    let service: ExecutorService;
    let execRepo: ReturnType<typeof makeExecRepo>;

    const buildService = async (repo: unknown) => {
      const module = await Test.createTestingModule({
        providers: [
          ExecutorService,
          { provide: getRepositoryToken(Executor), useValue: {} },
          { provide: getRepositoryToken(TaskExecution), useValue: repo },
          { provide: getRepositoryToken(Task), useValue: {} },
          {
            provide: getRepositoryToken(ExecutorMetricsHistory),
            useValue: {},
          },
          {
            provide: getQueueToken("task-queue"),
            useValue: { add: jest.fn() },
          },
          { provide: ConfigService, useValue: { get: () => undefined } },
          {
            provide: NotificationService,
            useValue: {
              notifyFailure: jest.fn(),
              notifyExecutorOnline: jest.fn(),
              notifyExecutorOffline: jest.fn(),
              sendAll: jest.fn(),
            },
          },
          {
            provide: SystemConfigService,
            useValue: { findOne: jest.fn().mockRejectedValue(new Error("x")) },
          },
          {
            provide: SecretsCryptoService,
            useValue: new SecretsCryptoService({ get: () => "" } as any),
          },
        ],
      }).compile();
      return module.get(ExecutorService);
    };

    beforeEach(async () => {
      execRepo = makeExecRepo([]);
      service = await buildService(execRepo.repo);
    });

    it("只查终态：传给 IN 的集合等于 TERMINAL_EXECUTION_STATUSES（不自带字面量）", async () => {
      await service.getTerminalStates("10.0.0.9:3002", { since: new Date(0) });
      const statusCall = execRepo.calls.andWhere.mock.calls.find((c) =>
        String(c[0]).includes("IN"),
      );
      expect(statusCall).toBeDefined();
      expect(statusCall![1].statuses).toEqual(
        TERMINAL_EXECUTION_STATUSES as unknown as ExecutionStatus[],
      );
      // 反证：终态集合与打开态集合必须互斥——若有人给 ExecutionStatus 加了
      // 新取值却只往一边加，这里的长度断言会红。
      const all = Object.values(ExecutionStatus);
      expect(
        TERMINAL_EXECUTION_STATUSES.length + OPEN_EXECUTION_STATUSES.length,
      ).toBe(all.length);
      for (const s of TERMINAL_EXECUTION_STATUSES) {
        expect(OPEN_EXECUTION_STATUSES).not.toContain(s);
      }
      expect(TERMINAL_EXECUTION_STATUSES).not.toContain(
        ExecutionStatus.RUNNING,
      );
      expect(TERMINAL_EXECUTION_STATUSES).not.toContain(
        ExecutionStatus.PENDING,
      );
    });

    it("水印用 COALESCE(endTime, createdAt)——endTime 为 NULL 的终态行也必须可见", async () => {
      await service.getTerminalStates("10.0.0.9:3002", { since: new Date(0) });
      const whereTexts = [
        execRepo.calls.where.mock.calls.map((c) => String(c[0])),
        execRepo.calls.andWhere.mock.calls.map((c) => String(c[0])),
      ].flat();
      expect(
        whereTexts.some((t) =>
          /COALESCE\(\s*e\.endTime\s*,\s*e\.createdAt\s*\)/.test(t),
        ),
      ).toBe(true);
    });

    it("多取一条用于判 hasMore，但绝不返回那一条", async () => {
      execRepo = makeExecRepo([
        { id: "a", status: ExecutionStatus.SUCCESS, endTime: new Date(1) },
        { id: "b", status: ExecutionStatus.FAILED, endTime: new Date(2) },
        { id: "c", status: ExecutionStatus.KILLED, endTime: new Date(3) },
      ]);
      service = await buildService(execRepo.repo);
      const res = await service.getTerminalStates("addr", {
        since: new Date(0),
        limit: 2,
      });
      expect(execRepo.calls.take).toHaveBeenCalledWith(3);
      expect(res.items.map((i) => i.executionId)).toEqual(["a", "b"]);
      expect(res.hasMore).toBe(true);
    });

    it("未达 limit 时 hasMore 为 false", async () => {
      execRepo = makeExecRepo([
        { id: "a", status: ExecutionStatus.SUCCESS, endTime: new Date(1) },
      ]);
      service = await buildService(execRepo.repo);
      const res = await service.getTerminalStates("addr", {
        since: new Date(0),
        limit: 500,
      });
      expect(res.hasMore).toBe(false);
      expect(res.items).toHaveLength(1);
    });

    it("endTime 缺失时 endedAt 回落到 createdAt（不是 undefined）", async () => {
      execRepo = makeExecRepo([
        {
          id: "a",
          status: ExecutionStatus.CANCELLED,
          endTime: null,
          createdAt: new Date("2026-09-14T00:00:00.000Z"),
        } as Partial<TaskExecution> as TaskExecution,
      ]);
      service = await buildService(execRepo.repo);
      const res = await service.getTerminalStates("addr", {
        since: new Date(0),
      });
      expect(res.items[0].endedAt).toBe("2026-09-14T00:00:00.000Z");
    });

    it.each([
      [0, 1],
      [-5, 1],
      [1.9, 1],
      [999999, TERMINAL_STATES_MAX_LIMIT],
    ])("limit %p 被钳到 %p", async (input, expected) => {
      await service.getTerminalStates("addr", {
        since: new Date(0),
        limit: input,
      });
      expect(execRepo.calls.take).toHaveBeenCalledWith(expected + 1);
    });

    it("service 对空令牌 fail-closed——对账端点靠它挡住无凭据读取", async () => {
      // 真机冒烟教训（round-16）：presented=undefined 曾在 Buffer.from 处抛 500。
      // 未携带凭据就是未通过，直接 false，不进 bcrypt。
      await expect(
        service.validateTokenByAddress("addr", undefined as unknown as string),
      ).resolves.toBe(false);
    });

    it("回 serverTime，供执行器校正时钟偏差后算 since", async () => {
      const before = Date.now();
      const res = await service.getTerminalStates("addr", {
        since: new Date(0),
      });
      const after = Date.now();
      const t = Date.parse(res.serverTime);
      expect(t).toBeGreaterThanOrEqual(before - 1000);
      expect(t).toBeLessThanOrEqual(after + 1000);
    });
  });

  describe("controller: 鉴权与参数解析", () => {
    const makeSvc = (overrides: Record<string, jest.Mock> = {}) =>
      ({
        validateTokenByAddress: jest.fn().mockResolvedValue(true),
        getTerminalStates: jest.fn().mockResolvedValue({
          items: [],
          hasMore: false,
          serverTime: new Date().toISOString(),
        }),
        ...overrides,
      }) as unknown as ExecutorService;

    const build = (svc: ExecutorService) =>
      new ExecutorController(svc, { get: () => undefined } as any, {} as any);

    it("令牌无效 → 401，且绝不触达 service（对账视图不得泄露执行清单）", async () => {
      const svc = makeSvc({
        validateTokenByAddress: jest.fn().mockResolvedValue(false),
      });
      await expect(
        build(svc).getTerminalStates(
          "10.0.0.9:3002",
          undefined,
          undefined,
          "Bearer bad",
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(svc.getTerminalStates).not.toHaveBeenCalled();
    });

    it("无 Authorization 头 → undefined 原样透传给 service（fail-closed 判定在 service 侧）", async () => {
      const svc = makeSvc();
      await build(svc).getTerminalStates(
        "10.0.0.9:3002",
        undefined,
        undefined,
        undefined,
      );
      expect(svc.validateTokenByAddress).toHaveBeenCalledWith(
        "10.0.0.9:3002",
        undefined,
      );
    });

    it("Bearer 前缀被剥离后校验（与 heartbeat/pull 同款取令牌逻辑）", async () => {
      const svc = makeSvc();
      await build(svc).getTerminalStates(
        "10.0.0.9:3002",
        undefined,
        undefined,
        "Bearer tok-123",
      );
      expect(svc.validateTokenByAddress).toHaveBeenCalledWith(
        "10.0.0.9:3002",
        "tok-123",
      );
    });

    it("since 合法 → 原样透传为 Date", async () => {
      const svc = makeSvc();
      await build(svc).getTerminalStates(
        "addr",
        "2026-09-14T08:00:00.000Z",
        undefined,
        "Bearer t",
      );
      const arg = (svc.getTerminalStates as jest.Mock).mock.calls[0][1];
      expect(arg.since.toISOString()).toBe("2026-09-14T08:00:00.000Z");
    });

    it("since 非法 → 回退 24h 窗口（不是抛错——对账是尽力而为的后台动作）", async () => {
      const svc = makeSvc();
      const before = Date.now();
      await build(svc).getTerminalStates(
        "addr",
        "not-a-date",
        undefined,
        "Bearer t",
      );
      const arg = (svc.getTerminalStates as jest.Mock).mock.calls[0][1];
      const delta = before - arg.since.getTime();
      expect(delta).toBeGreaterThanOrEqual(
        TERMINAL_STATES_DEFAULT_LOOKBACK_MS - 2000,
      );
      expect(delta).toBeLessThanOrEqual(
        TERMINAL_STATES_DEFAULT_LOOKBACK_MS + 2000,
      );
    });

    it("since 过老 → 钳到 30 天上界（防时钟错乱的执行器拖垮扫描）", async () => {
      const svc = makeSvc();
      const before = Date.now();
      await build(svc).getTerminalStates(
        "addr",
        "1999-01-01T00:00:00.000Z",
        undefined,
        "Bearer t",
      );
      const arg = (svc.getTerminalStates as jest.Mock).mock.calls[0][1];
      expect(before - arg.since.getTime()).toBeLessThanOrEqual(
        TERMINAL_STATES_MAX_LOOKBACK_MS + 2000,
      );
      expect(arg.since.getTime()).toBeGreaterThan(
        Date.parse("1999-01-01T00:00:00.000Z"),
      );
    });

    it("limit 非数字 → 交回 undefined，由 service 用默认页大小", async () => {
      const svc = makeSvc();
      await build(svc).getTerminalStates("addr", undefined, "abc", "Bearer t");
      const arg = (svc.getTerminalStates as jest.Mock).mock.calls[0][1];
      expect(arg.limit).toBeUndefined();
    });

    it("limit 合法 → 透传（钳位在 service 侧）", async () => {
      const svc = makeSvc();
      await build(svc).getTerminalStates("addr", undefined, "10", "Bearer t");
      const arg = (svc.getTerminalStates as jest.Mock).mock.calls[0][1];
      expect(arg.limit).toBe(10);
    });
  });
});
