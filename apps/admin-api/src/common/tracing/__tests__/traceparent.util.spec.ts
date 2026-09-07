import {
  generateTraceparent,
  extractTraceId,
  buildTraceparent,
} from "../traceparent.util";

/** RFC 参考向量：规范示例形态（00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01）。 */
const KNOWN_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const KNOWN_PARENT_ID = "00f067aa0ba902b7";

describe("traceparent.util（OBS-01 W3C Trace Context 纯函数）", () => {
  describe("generateTraceparent", () => {
    it("生成合法的 00-<32hex>-<16hex>-01 形态", () => {
      const tp = generateTraceparent();
      expect(tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    });

    it("多次生成互不相同（随机性）", () => {
      const a = generateTraceparent();
      const b = generateTraceparent();
      expect(a).not.toEqual(b);
    });
  });

  describe("extractTraceId", () => {
    it("从规范参考向量提取 trace-id", () => {
      expect(
        extractTraceId(`00-${KNOWN_TRACE_ID}-${KNOWN_PARENT_ID}-01`),
      ).toEqual(KNOWN_TRACE_ID);
    });

    it("容忍首尾空白", () => {
      expect(
        extractTraceId(`  00-${KNOWN_TRACE_ID}-${KNOWN_PARENT_ID}-01  `),
      ).toEqual(KNOWN_TRACE_ID);
    });

    it.each([
      [undefined, "undefined 头"],
      [null, "null 头"],
      ["", "空串"],
      ["not-a-traceparent", "无分隔结构"],
      ["00-abc-def-01", "段长度不足"],
      [
        `01-${KNOWN_TRACE_ID}-${KNOWN_PARENT_ID}-01`,
        "version 非 00",
      ],
      [
        `${"g".repeat(32)}-${KNOWN_PARENT_ID}-01`.replace(/^/, "00-"),
        "trace-id 含非 hex",
      ],
      [
        `00-${"0".repeat(32)}-${KNOWN_PARENT_ID}-01`,
        "trace-id 全零（规范非法）",
      ],
      [
        `00-${KNOWN_TRACE_ID}-${"0".repeat(16)}-01`,
        "parent-id 全零（规范非法）",
      ],
      [
        `00-${KNOWN_TRACE_ID}-${KNOWN_PARENT_ID}-zz`,
        "flags 非 hex",
      ],
      [
        `00-${KNOWN_TRACE_ID.toUpperCase()}-${KNOWN_PARENT_ID}-01`,
        "大写 hex（规范要求小写）",
      ],
      [
        `00-${KNOWN_TRACE_ID}-${KNOWN_PARENT_ID}-01-extra`,
        "多余段",
      ],
    ])("非法输入 %s（%s）返回 null", (input) => {
      expect(extractTraceId(input as string)).toBeNull();
    });
  });

  describe("buildTraceparent", () => {
    it("由合法 traceId（大写输入归一小写）构造合法头值且 trace-id 一致", () => {
      const tp = buildTraceparent(KNOWN_TRACE_ID.toUpperCase());
      expect(tp).not.toBeNull();
      expect(extractTraceId(tp)).toEqual(KNOWN_TRACE_ID);
    });

    it.each([
      [null, "null"],
      [undefined, "undefined"],
      ["", "空串"],
      ["short", "非 32 hex"],
      [`z${"1".repeat(31)}`, "含非 hex 字符"],
    ])("非法 traceId %s（%s）返回 null", (input) => {
      expect(buildTraceparent(input as string)).toBeNull();
    });
  });

  describe("round-trip（双向钉死）", () => {
    it("generate → extract 还原同一 traceId；build → extract 还原同一 traceId", () => {
      const gen = generateTraceparent();
      const traceId = extractTraceId(gen);
      expect(traceId).not.toBeNull();
      const rebuilt = buildTraceparent(traceId);
      expect(extractTraceId(rebuilt)).toEqual(traceId);
    });
  });
});
