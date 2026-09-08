import {
  partitionDayLiteral,
  partitionNameFor,
  parseDayFromPartitionName,
  partitionRangeFor,
  parsePartitionUpperBound,
  LOG_PARTITION_NAME_PREFIX,
} from "../log-retention/log-partition.util";

describe("log-partition.util（ARCH-22）", () => {
  describe("partitionDayLiteral / partitionNameFor", () => {
    it("按 UTC 日历日取 YYYY-MM-DD 字面量", () => {
      // UTC 2026-09-08 00:30 —— 北京时间已是 9-08，UTC 日期取 09-08
      expect(partitionDayLiteral(new Date("2026-09-08T00:30:00Z"))).toBe(
        "2026-09-08",
      );
      // UTC 2026-09-08 23:59 仍是同一日历日
      expect(partitionDayLiteral(new Date("2026-09-08T23:59:59Z"))).toBe(
        "2026-09-08",
      );
    });

    it("分区名 = execution_log_lines_YYYYMMDD", () => {
      expect(partitionNameFor(new Date("2026-09-08T12:00:00Z"))).toBe(
        "execution_log_lines_20260908",
      );
      expect(LOG_PARTITION_NAME_PREFIX).toBe("execution_log_lines_");
    });

    it("parseDayFromPartitionName：规范名回 UTC 零点，非规范名回 null", () => {
      const d = parseDayFromPartitionName("execution_log_lines_20260908");
      expect(d).not.toBeNull();
      expect(d!.toISOString()).toBe("2026-09-08T00:00:00.000Z");
      expect(
        parseDayFromPartitionName("execution_log_lines_legacy"),
      ).toBeNull();
      expect(parseDayFromPartitionName("other_table_20260908")).toBeNull();
      // 非法月日数字 → NaN → null
      expect(
        parseDayFromPartitionName("execution_log_lines_20269999"),
      ).toBeNull();
    });
  });

  describe("partitionRangeFor", () => {
    it("边界 = 当日 UTC 零点到次日 UTC 零点", () => {
      expect(partitionRangeFor(new Date("2026-09-08T05:00:00Z"))).toEqual({
        from: "2026-09-08",
        to: "2026-09-09",
      });
    });

    it("跨月/跨年边界正确", () => {
      expect(partitionRangeFor(new Date("2026-09-30T12:00:00Z"))).toEqual({
        from: "2026-09-30",
        to: "2026-10-01",
      });
      expect(partitionRangeFor(new Date("2026-12-31T12:00:00Z"))).toEqual({
        from: "2026-12-31",
        to: "2027-01-01",
      });
    });
  });

  describe("parsePartitionUpperBound（pg_get_expr relpartbound 解析）", () => {
    it("解析 PG 原生 FOR VALUES 输出的 TO 侧上界", () => {
      const d = parsePartitionUpperBound(
        "FOR VALUES FROM ('2026-09-08 00:00:00') TO ('2026-09-09 00:00:00')",
      );
      expect(d).not.toBeNull();
      expect(d!.toISOString()).toBe("2026-09-09T00:00:00.000Z");
    });

    it("纯日期字面量（YYYY-MM-DD）按 UTC 零点解释", () => {
      const d = parsePartitionUpperBound(
        "FOR VALUES FROM ('2026-09-08') TO ('2026-09-09')",
      );
      expect(d!.toISOString()).toBe("2026-09-09T00:00:00.000Z");
    });

    it("不可解析输入返回 null（调用方跳过该分区不误删）", () => {
      expect(parsePartitionUpperBound("")).toBeNull();
      expect(parsePartitionUpperBound("FOR VALUES IN ('a','b')")).toBeNull();
      expect(
        parsePartitionUpperBound(undefined as unknown as string),
      ).toBeNull();
      // 时间戳字段残缺 → Invalid Date → null
      expect(
        parsePartitionUpperBound("FOR VALUES FROM ('x') TO ('y')"),
      ).toBeNull();
    });
  });
});
