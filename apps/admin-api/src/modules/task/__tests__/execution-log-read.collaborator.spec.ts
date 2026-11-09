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
