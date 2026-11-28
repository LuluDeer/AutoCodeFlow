import { Readable } from "node:stream";

import {
  ExecutionLogRead,
  paginateLogStream,
} from "../execution-log-read.collaborator";
import { ExecutionLog } from "../execution-log.collaborator";
import { ExecutionStatus } from "../entities/task-execution.entity";

/**
 * LOG-HARDEN：执行日志「完整、不重复、不丢行」的后端契约测试。
 *
 * 覆盖：① 行号有洞分页无交叠；② SSE 从 fromLine 续传且帧带行号；
 * ③ S3 未终态合并 DB 实时行 + S3 归档行（同号 DB 优先）；
 * ④ 乱序/迟到 chunk 不覆盖已落库的较新行。
 *
 * 验证级别：**单测 / 内存替身**（假仓储 + 假 S3 流；无真 PG/S3/Nest 进程）。
 */

type Row = { lineNumber: number; content: string };

const baseExec = (overrides: Record<string, unknown> = {}) => ({
  id: "exec-log-hardening",
  status: "running",
  startTime: new Date("2026-11-27T10:00:00Z"),
  createdAt: new Date("2026-11-27T10:00:00Z"),
  logStorage: "db",
  logObjectKey: null,
  ...overrides,
});

/** 按 `l.lineNumber >= :from` 过滤的内存查询构造器。 */
const makeQb = (rows: Row[]) => {
  let from = 0;
  const calls: string[] = [];
  const qb: Record<string, jest.Mock> = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn((clause: string, params?: { from?: number }) => {
      calls.push(clause);
      if (clause.includes("lineNumber >= :from")) from = params?.from ?? 0;
      return qb;
    }),
    orderBy: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    getMany: jest.fn(async () => rows.filter((r) => r.lineNumber >= from)),
  };
  return { qb, calls };
};

const makeRead = (opts: {
  exec: Record<string, unknown>;
  rows?: Row[];
  s3Lines?: string[];
}) => {
  const { qb, calls } = makeQb(opts.rows ?? []);
  const getStream = jest.fn(async () =>
    Readable.from((opts.s3Lines ?? []).map((l) => `${l}\n`)),
  );
  const warn = jest.fn();
  const findOne = jest.fn(async () => opts.exec);
  const count = jest.fn(async () => (opts.rows ?? []).length);
  const svc = new ExecutionLogRead({
    execRepo: { findOne } as never,
    logLineRepo: { createQueryBuilder: jest.fn(() => qb), count } as never,
    taskRepo: {} as never,
    logger: { warn } as never,
    aiAnalysisService: {} as never,
    resolveS3Storage: (() => ({ getStream })) as never,
    acquireSseSlot: () => () => undefined,
    maybeNotifyTimeoutWarning: async () => undefined,
    assertCanWriteExecution: async () => undefined,
    configService: { get: <T>() => 30 as T },
    systemConfig: null,
  });
  return { svc, qb, calls, getStream, warn, findOne, count };
};

describe("LOG-HARDEN · REST 行号游标（行号有洞不交叠）", () => {
  it("分页两页：nextCursor 取最后真实行号 + 1，第二页不重发第一页行", async () => {
    const rows = [
      { lineNumber: 0, content: "L0" },
      { lineNumber: 5, content: "L5" },
      { lineNumber: 9, content: "L9" },
    ];
    const { svc } = makeRead({ exec: baseExec(), rows });

    const p1 = await svc.getExecutionLogs("exec-log-hardening", 0, 2);
    expect(p1.lines).toEqual(["L0", "L5"]);
    expect(p1.lineNumbers).toEqual([0, 5]);
    // 旧算法从 0 + 2 = 2 起，会把 5 再发一次；游标必须是 5 + 1 = 6。
    expect(p1.nextCursor).toBe(6);
    expect(p1.hasMore).toBe(true);

    const p2 = await svc.getExecutionLogs(
      "exec-log-hardening",
      p1.nextCursor,
      2,
    );
    expect(p2.lines).toEqual(["L9"]);
    expect(p2.lineNumbers).toEqual([9]);
    expect(p2.nextCursor).toBe(10);
    expect(p2.hasMore).toBe(false);

    expect([...p1.lineNumbers, ...p2.lineNumbers]).toEqual([0, 5, 9]);
  });

  it("paginateLogStream 的 nextCursor 也按最后真实行号推进", async () => {
    const res = await paginateLogStream(
      Readable.from(["a\n", "b\n", "c\n"]),
      1,
      1,
    );
    expect(res.lines).toEqual(["b"]);
    expect(res.lineNumbers).toEqual([1]);
    expect(res.nextCursor).toBe(2);
    expect(res.hasMore).toBe(true);
  });
});

describe("LOG-HARDEN · SSE 从 fromLine 续传", () => {
  it("只推 lineNumber >= fromLine 的帧，且每帧携带 lineNumber/content", async () => {
    const rows = [
      { lineNumber: 3, content: "L3" },
      { lineNumber: 6, content: "L6" },
      { lineNumber: 7, content: "L7" },
    ];
    const { svc } = makeRead({
      exec: baseExec({ status: ExecutionStatus.SUCCESS }),
      rows,
    });
    const send = jest.fn();
    const done = jest.fn();
    const emitFrame = jest.fn();
    const ac = new AbortController();

    await svc.streamExecutionLogs(
      "exec-log-hardening",
      send,
      done,
      ac.signal,
      () => undefined,
      undefined,
      7,
      emitFrame,
    );

    // fromLine=7 ⇒ 不重推 3/6；只推 7。
    expect(emitFrame).toHaveBeenCalledTimes(1);
    expect(emitFrame).toHaveBeenCalledWith({ lineNumber: 7, content: "L7" });
    expect(send).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledTimes(1);
  });
});

describe("LOG-HARDEN · S3 未终态合并", () => {
  it("S3 指针存在且 RUNNING：归档行 + DB 实时行按行号合并，同号 DB 优先", async () => {
    const { svc, getStream, count } = makeRead({
      exec: baseExec({ logStorage: "s3", logObjectKey: "logs/e.gz" }),
      rows: [
        { lineNumber: 1, content: "DB live 1" },
        { lineNumber: 2, content: "DB live 2" },
      ],
      s3Lines: ["[INFO] archived 0", "[INFO] archived 1"],
    });

    const result = await svc.getExecutionLogs("exec-log-hardening", 0, 10);

    expect(getStream).toHaveBeenCalledWith("logs/e.gz");
    expect(result.lines).toEqual([
      "[INFO] archived 0",
      "DB live 1",
      "DB live 2",
    ]);
    expect(result.lineNumbers).toEqual([0, 1, 2]);
    expect(result.nextCursor).toBe(3);
    expect(result.hasMore).toBe(false);
    // 合并页非空 ⇒ 不触发 purged 判定，也不做全量 count。
    expect(count).not.toHaveBeenCalled();
  });
});

describe("LOG-HARDEN · appendLogChunk 单调保护", () => {
  it("乱序 chunk 的同号旧内容不覆盖较新行，只补写未落库行", async () => {
    const warn = jest.fn();
    const save = jest.fn(async (_entity: unknown, _rows: unknown) => undefined);
    const manager = {
      find: jest.fn(async () => [{ lineNumber: 1, content: "NEWER" }]),
      save,
    };
    const collab = new ExecutionLog({
      dataSource: {
        transaction: jest.fn(async (fn: (m: unknown) => Promise<void>) =>
          fn(manager),
        ),
      } as never,
      execRepo: {
        findOne: jest.fn(async () => ({ id: "exec-log-hardening" })),
      } as never,
      logLineRepo: { create: jest.fn((d: unknown) => d) } as never,
      logger: { warn } as never,
      resolveS3Storage: () => null,
      s3GetExistingLog: async () => null,
      storeLogLines: async () => undefined,
      hasStreamedLogLines: async () => false,
      backfillFullLogsFromExecutor: async () => false,
    });

    const result = await collab.appendLogChunk("exec-log-hardening", 0, [
      "old 0",
      "old 1",
      "old 2",
    ]);

    expect(result).toEqual({ count: 3 });
    const saved = save.mock.calls[0][1] as Array<{
      lineNumber: number;
      content: string;
    }>;
    // 行 1 已落库且内容不同 ⇒ 保留较新行；行 0/2 未落库 ⇒ 补写。
    expect(saved.map((e) => e.lineNumber)).toEqual([0, 2]);
    expect(saved.map((e) => e.content)).toEqual(["old 0", "old 2"]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("stale log line"),
    );
  });

  it("S3 多页 append：读旧对象失败时用缓存前页，put 内容不会只剩本页", async () => {
    const put = jest.fn(
      async (_executionId: string, _content: string) => "logs/e.gz",
    );
    const s3 = { put, get: jest.fn(), getStream: jest.fn() } as never;
    const warn = jest.fn();
    const collab = new ExecutionLog({
      dataSource: { transaction: jest.fn() } as never,
      execRepo: { update: jest.fn(async () => undefined) } as never,
      logLineRepo: {
        delete: jest.fn(),
        create: jest.fn((d: unknown) => d),
      } as never,
      logger: { warn } as never,
      resolveS3Storage: () => s3,
      s3GetExistingLog: async () => null, // 模拟读旧对象失败
      storeLogLines: async () => undefined,
      hasStreamedLogLines: async () => false,
      backfillFullLogsFromExecutor: async () => false,
    });

    await collab.storeLogLines("s3-pages", ["page0"], 0, { append: false });
    await collab.storeLogLines("s3-pages", ["page1"], 1, { append: true });

    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[0][1]).toBe("page0");
    // 根因回归点：旧实现这里 put 的内容只有 "page1"，前页被整页覆盖。
    expect(put.mock.calls[1][1]).toBe("page0\npage1");
  });

  it("同内容重传视为幂等成功：不写、不报冲突", async () => {
    const warn = jest.fn();
    const save = jest.fn(async (_entities: unknown) => undefined);
    const manager = {
      find: jest.fn(async () => [{ lineNumber: 0, content: "same" }]),
      save,
    };
    const collab = new ExecutionLog({
      dataSource: {
        transaction: jest.fn(async (fn: (m: unknown) => Promise<void>) =>
          fn(manager),
        ),
      } as never,
      execRepo: {
        findOne: jest.fn(async () => ({ id: "exec-log-hardening" })),
      } as never,
      logLineRepo: { create: jest.fn((d: unknown) => d) } as never,
      logger: { warn } as never,
      resolveS3Storage: () => null,
      s3GetExistingLog: async () => null,
      storeLogLines: async () => undefined,
      hasStreamedLogLines: async () => false,
      backfillFullLogsFromExecutor: async () => false,
    });

    await collab.appendLogChunk("exec-log-hardening", 0, ["same"]);

    expect(save).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
