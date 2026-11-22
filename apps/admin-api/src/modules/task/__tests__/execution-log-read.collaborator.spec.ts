import { Readable } from "node:stream";

import {
  ExecutionLogRead,
  paginateLogStream,
} from "../execution-log-read.collaborator";

/**
 * T2-B4 收尾刀：`ExecutionLogRead` 协作者的**纯逻辑**边界（**不测转发层**）。
 *
 * ## 为什么只测这两个纯函数（Lead 的判据）
 *
 * · 协作者的三个 public 方法（`getExecutionLogs` / `streamExecutionLogs` /
 *   `analyzeExecution`）全是 **① 直调 public API**（扫描器实测 14 / 8 / 5 处），
 *   既有直调本身即行为回归网 ⇒ **转发层不需要独立 spec**（转发层的正确性由
 *   「一次转发 ⇒ 被调 1 次」那类结构断言保证）。
 * · 但 `logPartitionWindow`（分区窗口）与 `paginateLogStream`（S3 流分页）是
 *   **纯逻辑** ⇒ 单测成本极低、价值极高，且**只通过 Facade 的集成路径被覆盖**
 *   ⇒ 一旦集成路径的 mock 宽松，纯逻辑的边界就没人测。
 *
 * ⇒ 本 spec 只测这两个纯函数的**边界**：空窗口 / 跨分区 / 正好落在边界 /
 * 页大小 0 或负数 / level 过滤下的偏移语义 / 空流。
 */
describe("T2-B4 收尾刀 · ExecutionLogRead 的纯逻辑边界", () => {
  const HOUR = 60 * 60 * 1000;

  /** 造一个只含 deps 的协作者（纯函数不需要任何仓储）。 */
  const makeService = () =>
    new ExecutionLogRead({
      execRepo: {} as never,
      logLineRepo: {} as never,
      taskRepo: {} as never,
      logger: {} as never,
      aiAnalysisService: {} as never,
      resolveS3Storage: () => null,
      acquireSseSlot: () => () => undefined,
      maybeNotifyTimeoutWarning: async () => undefined,
      assertCanWriteExecution: async () => undefined,
      // R284-LOGPURGE-01：保留期解析依赖（纯函数用例用不到，给最小桩）。
      configService: { get: <T>() => 30 as unknown as T },
      systemConfig: null,
    });

  describe("logPartitionWindow（分区窗口 = 起止各外扩 1 小时）", () => {
    const svc = makeService() as unknown as {
      logPartitionWindow: (
        exec:
          | {
              startTime?: Date | null;
              createdAt?: Date | null;
              endTime?: Date | null;
            }
          | null
          | undefined,
      ) => { since: Date; until: Date };
    };

    it("① startTime 存在 ⇒ since = startTime − 1h；until = now + 1h（未结束）", () => {
      const start = new Date("2026-01-01T10:00:00Z");
      const w = svc.logPartitionWindow({ startTime: start });
      expect(w.since.getTime()).toBe(start.getTime() - HOUR);
      // until 依赖 now ⇒ 只断言「在未来约 1 小时内」
      const delta = w.until.getTime() - Date.now();
      expect(delta).toBeGreaterThan(HOUR - 5000);
      expect(delta).toBeLessThanOrEqual(HOUR + 1000);
    });

    it("② startTime 优先于 createdAt；两者都无 ⇒ 用 createdAt 作基准", () => {
      const created = new Date("2026-01-01T08:00:00Z");
      const start = new Date("2026-01-01T09:00:00Z");
      expect(
        svc
          .logPartitionWindow({ startTime: start, createdAt: created })
          .since.getTime(),
      ).toBe(start.getTime() - HOUR);
      expect(
        svc.logPartitionWindow({ createdAt: created }).since.getTime(),
      ).toBe(created.getTime() - HOUR);
    });

    it("③ endTime 存在 ⇒ until = endTime + 1h（**不**依赖 now）", () => {
      const end = new Date("2026-01-01T12:00:00Z");
      const w = svc.logPartitionWindow({
        startTime: new Date("2026-01-01T10:00:00Z"),
        endTime: end,
      });
      expect(w.until.getTime()).toBe(end.getTime() + HOUR);
    });

    it("④ 空执行行（null / undefined / 三个时间戳全空）⇒ since = epoch（不抛）", () => {
      for (const input of [null, undefined, {}]) {
        const w = svc.logPartitionWindow(input as never);
        expect(w.since.getTime()).toBe(0);
        expect(w.until.getTime()).toBeGreaterThan(Date.now());
      }
    });

    it("⑤ 跨分区边界时两端各留 1 小时余量（边界外 30 分钟的行仍可查）", () => {
      const start = new Date("2026-01-01T10:30:00Z"); // 跨小时分区
      const w = svc.logPartitionWindow({ startTime: start });
      // since 落在 09:30 ⇒ 覆盖 09:00 分区（起点前 30 分钟的行也在窗口内）
      expect(w.since.getTime()).toBe(start.getTime() - HOUR);
      expect(w.since.getUTCMinutes()).toBe(30);
    });
  });

  describe("paginateLogStream（S3 流分页 + level 过滤）", () => {
    /** 造一个可读的流（逐行）。 */
    const streamOf = (lines: string[]) =>
      Readable.from(lines.map((l) => `${l}\n`));

    it("⑥ 无过滤：fromLine 偏移 + limit 截断 + totalLines/hasMore 正确", async () => {
      const res = await paginateLogStream(
        streamOf(["a", "b", "c", "d", "e"]),
        1,
        2,
      );
      expect(res.lines).toEqual(["b", "c"]);
      expect(res.totalLines).toBe(5);
      expect(res.hasMore).toBe(true);
    });

    it("⑦ 最后一页：hasMore = false（fromLine + lines.length === totalLines）", async () => {
      const res = await paginateLogStream(streamOf(["a", "b", "c"]), 2, 5);
      expect(res.lines).toEqual(["c"]);
      expect(res.totalLines).toBe(3);
      expect(res.hasMore).toBe(false);
    });

    it("⑧ 页大小为 0 ⇒ 返回空页但 totalLines 仍正确（不吞内容、不越界）", async () => {
      const res = await paginateLogStream(streamOf(["a", "b", "c"]), 0, 0);
      expect(res.lines).toEqual([]);
      expect(res.totalLines).toBe(3);
      // 还有下一页（没读到任何行）
      expect(res.hasMore).toBe(true);
    });

    it("⑨ 页大小为负数 ⇒ 视作 0（不返回负数长度、不越界）", async () => {
      const res = await paginateLogStream(streamOf(["a", "b", "c"]), 0, -5);
      expect(res.lines).toEqual([]);
      expect(res.totalLines).toBe(3);
    });

    it("⑩ fromLine 超出总行数 ⇒ 空页 + hasMore = false", async () => {
      const res = await paginateLogStream(streamOf(["a", "b"]), 99, 10);
      expect(res.lines).toEqual([]);
      expect(res.totalLines).toBe(2);
      expect(res.hasMore).toBe(false);
    });

    it("⑪ 空流 ⇒ 空页、totalLines = 0、hasMore = false", async () => {
      const res = await paginateLogStream(streamOf([]), 0, 10);
      expect(res.lines).toEqual([]);
      expect(res.totalLines).toBe(0);
      expect(res.hasMore).toBe(false);
    });

    it("⑫ level 过滤下 fromLine 是**过滤后**序列的偏移（被滤掉的行不占窗口）", async () => {
      // ⚠️ 级别标记形态：`[ERROR]` / `Error: ` / `info ` 都可识别，且级别值**大写**
      // （见 log-level.util 的 LEVEL_MARKER_RE / LEVEL_WORDS）⇒ 过滤值要用 "ERROR"。
      const lines = ["[INFO] x", "[ERROR] y", "[INFO] z", "[ERROR] w"];
      // 只看 ERROR：过滤后序列 = ["[ERROR] y", "[ERROR] w"]
      const res = await paginateLogStream(streamOf(lines), 1, 1, {
        level: "ERROR",
      });
      expect(res.lines).toEqual(["[ERROR] w"]);
      // totalLines = **过滤后**的行数（不是物理行数）
      expect(res.totalLines).toBe(2);
      expect(res.hasMore).toBe(false);
    });

    it("⑬ level 过滤后无命中 ⇒ 空页、totalLines = 0", async () => {
      const res = await paginateLogStream(
        streamOf(["[INFO] a", "[INFO] b"]),
        0,
        10,
        {
          level: "ERROR",
        },
      );
      expect(res.lines).toEqual([]);
      expect(res.totalLines).toBe(0);
      expect(res.hasMore).toBe(false);
    });

    it("⑭ 末尾无换行的最后一行也算一行", async () => {
      // 最后一行的内容不是空串 ⇒ 必须被计入（不因缺 \\n 被丢弃）
      const res = await paginateLogStream(
        Readable.from(["first\n", "second"]),
        0,
        10,
      );
      expect(res.lines).toEqual(["first", "second"]);
      expect(res.totalLines).toBe(2);
    });
  });
});

/**
 * R284-LOGPURGE-01：日志读面的「已按保留期清理」判定。
 *
 * ## 为什么这组用例必须存在
 *
 * 日志行留 30 天、执行行留 90 天 ⇒ 31~90 天前的执行详情日志区是空的，而此前
 * 这个空被 UI 显示成「切日志级别」。本组用例钉住**三态**可区分：
 * ① 超期 + 空日志 ⇒ purged（带截止时刻）；② 窗口内 + 空日志 ⇒ **不是** purged
 * （真没输出）；③ 保留期不可读 ⇒ **未知**（既非 true 也非 false）。
 *
 * ④ 反证：把 purged 分支去掉（只在 `lineCount===0` 就返回 purged、不看时间），
 * ② 立刻变红 —— 这正是「不能只按时间/只看空数组推」的那条纪律。
 */
describe("R284-LOGPURGE-01 · 日志已按保留期清理的读面判定", () => {
  const DAY = 86_400_000;

  /**
   * 造一个**带仓储替身**的协作者。
   * @param opts.lineCount 日志行表 count 的返回值（0 = 该执行窗口内没有行）
   * @param opts.retentionDays 保留期（null = 读不到 ⇒ 未知态）
   */
  const makeService = (opts: {
    lineCount: number;
    retentionDays: number | null;
    exec: Record<string, unknown>;
  }) => {
    const count = jest.fn().mockResolvedValue(opts.lineCount);
    const getMany = jest.fn().mockResolvedValue([]);
    const qb: Record<string, jest.Mock> = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      getMany,
    };
    const svc = new ExecutionLogRead({
      execRepo: {
        findOne: jest.fn().mockResolvedValue(opts.exec),
      } as never,
      logLineRepo: {
        createQueryBuilder: jest.fn().mockReturnValue(qb),
        count,
      } as never,
      taskRepo: {} as never,
      logger: { warn: jest.fn() } as never,
      aiAnalysisService: {} as never,
      resolveS3Storage: () => null,
      acquireSseSlot: () => () => undefined,
      maybeNotifyTimeoutWarning: async () => undefined,
      assertCanWriteExecution: async () => undefined,
      configService: {
        get: <T>(key: string) =>
          (key === "logRetention.days" ? opts.retentionDays : undefined) as
            T | undefined,
      },
      systemConfig: null,
    });
    return { svc, count, getMany };
  };

  it("① 31 天前 + 空日志 ⇒ logsPurged=true 且给出 logsPurgedAt", async () => {
    const startedAt = new Date(Date.now() - 31 * DAY);
    const { svc } = makeService({
      lineCount: 0,
      retentionDays: 30,
      exec: {
        id: "e-old",
        startTime: startedAt,
        createdAt: startedAt,
        logStorage: "db",
      },
    });

    const res = await svc.getExecutionLogs("e-old", 0);

    // 「空数组」不是结论：同一个空必须带上是哪种空。
    expect(res.lines).toEqual([]);
    expect(res.logsPurged).toBe(true);
    expect(typeof res.logsPurgedAt).toBe("string");
    // 截止时刻 = now − 30 天（允许几秒漂移）
    const cutoff = new Date(res.logsPurgedAt as string).getTime();
    expect(Math.abs(cutoff - (Date.now() - 30 * DAY))).toBeLessThan(10_000);
  });

  it("② 3 天前 + 空日志 ⇒ logsPurged=false（真没输出，不是被清理）", async () => {
    const startedAt = new Date(Date.now() - 3 * DAY);
    const { svc } = makeService({
      lineCount: 0,
      retentionDays: 30,
      exec: {
        id: "e-new",
        startTime: startedAt,
        createdAt: startedAt,
        logStorage: "db",
      },
    });

    const res = await svc.getExecutionLogs("e-new", 0);

    expect(res.lines).toEqual([]);
    // 反证点：只按「日志为空」推的话这里会是 true（见文件头 ④）。
    expect(res.logsPurged).toBe(false);
    expect(res.logsPurgedAt).toBeNull();
  });

  it("③ 保留期读不到 + 空日志 ⇒ 未知（既非 true 也非 false）", async () => {
    const startedAt = new Date(Date.now() - 31 * DAY);
    const { svc } = makeService({
      lineCount: 0,
      retentionDays: null,
      exec: {
        id: "e-unknown",
        startTime: startedAt,
        createdAt: startedAt,
        logStorage: "db",
      },
    });

    const res = await svc.getExecutionLogs("e-unknown", 0);

    expect(res.logsPurged).toBeNull();
    expect(res.logsPurged).not.toBe(true);
    expect(res.logsPurged).not.toBe(false);
    expect(res.logsPurgedAt).toBeNull();
  });

  it("超期但日志行仍在（清理 job 停摆）⇒ 不判 purged，不谎报", async () => {
    const startedAt = new Date(Date.now() - 31 * DAY);
    const { svc } = makeService({
      lineCount: 7,
      retentionDays: 30,
      exec: {
        id: "e-stuck",
        startTime: startedAt,
        createdAt: startedAt,
        logStorage: "db",
      },
    });

    const res = await svc.getExecutionLogs("e-stuck", 0);

    // 行还在 ⇒ 不是"已清理"。时间只是必要条件，不是充分条件。
    expect(res.logsPurged).toBe(false);
  });

  it("有日志的页不触发保留期判定（不白打 count）", async () => {
    const startedAt = new Date(Date.now() - 31 * DAY);
    const { svc, count } = makeService({
      lineCount: 3,
      retentionDays: 30,
      exec: {
        id: "e-has-logs",
        startTime: startedAt,
        createdAt: startedAt,
        logStorage: "db",
      },
    });
    const qb = (
      svc as unknown as {
        deps: { logLineRepo: { createQueryBuilder: jest.Mock } };
      }
    ).deps.logLineRepo.createQueryBuilder();
    qb.getMany.mockResolvedValue([{ lineNumber: 0, content: "boom" }]);

    const res = await svc.getExecutionLogs("e-has-logs", 0);

    expect(res.lines).toEqual(["boom"]);
    expect(res.logsPurged).toBe(false);
    // 分页 count（totalLines）一次即可；不该再为"空态判定"打第二次。
    expect(count).toHaveBeenCalledTimes(1);
  });
});
