import { ConfigService } from "@nestjs/config";
import { TracingService } from "../tracing.service";
import { extractTraceId } from "../traceparent.util";

const KNOWN_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const KNOWN_TRACEPARENT = `00-${KNOWN_TRACE_ID}-00f067aa0ba902b7-01`;

function makeService(enabled: boolean): TracingService {
  return new TracingService({
    get: jest.fn((key: string) =>
      key === "tracing.enabled" ? enabled : undefined,
    ),
  } as unknown as ConfigService);
}

describe("TracingService（OBS-01）", () => {
  describe("OTEL_ENABLED=false 短路（默认关闭零副作用）", () => {
    const disabled = makeService(false);

    it("isEnabled=false", () => {
      expect(disabled.isEnabled).toBe(false);
    });

    it("startTrace 返回 null", () => {
      expect(disabled.startTrace()).toBeNull();
    });

    it("extractContext 即使有合法头也返回 null", () => {
      expect(disabled.extractContext(KNOWN_TRACEPARENT)).toBeNull();
    });

    it("injectContext 不添加任何头（返回原对象内容）", () => {
      const headers = { Authorization: "Bearer x" };
      const out = disabled.injectContext(headers, KNOWN_TRACEPARENT);
      expect(out).toEqual({ Authorization: "Bearer x" });
      expect(out.traceparent).toBeUndefined();
    });

    it("startSpan 返回 no-op endSpan，endSpan 调用零异常", () => {
      const endSpan = disabled.startSpan(KNOWN_TRACE_ID, "dispatch");
      expect(() => endSpan()).not.toThrow();
    });

    it("buildTraceparentFromTraceId 返回 null", () => {
      expect(disabled.buildTraceparentFromTraceId(KNOWN_TRACE_ID)).toBeNull();
    });
  });

  describe("OTEL_ENABLED=true", () => {
    const enabled = makeService(true);

    it("isEnabled=true 且 startTrace 产出可提取的合法 traceparent", () => {
      expect(enabled.isEnabled).toBe(true);
      const tp = enabled.startTrace();
      expect(tp).not.toBeNull();
      expect(extractTraceId(tp)).toMatch(/^[0-9a-f]{32}$/);
    });

    it("extractContext 解析合法头返回 traceId；畸形头 fail-open 返回 null", () => {
      expect(enabled.extractContext(KNOWN_TRACEPARENT)).toEqual(KNOWN_TRACE_ID);
      expect(enabled.extractContext("garbage")).toBeNull();
      expect(enabled.extractContext(undefined)).toBeNull();
    });

    it("injectContext 在合法 traceparent 时追加头且保留既有头", () => {
      const out = enabled.injectContext(
        { Authorization: "Bearer x" },
        KNOWN_TRACEPARENT,
      );
      expect(out.Authorization).toEqual("Bearer x");
      expect(out.traceparent).toEqual(KNOWN_TRACEPARENT);
    });

    it("injectContext 对畸形 traceparent 不注入（防脏头出站）", () => {
      const out = enabled.injectContext({}, "garbage");
      expect(out).toEqual({});
    });

    it("startSpan 合法 traceId 返回可调用的 endSpan；非法 traceId 返回 no-op", () => {
      const end = enabled.startSpan(KNOWN_TRACE_ID, "dispatch", {
        executionId: "e1",
      });
      expect(typeof end).toBe("function");
      expect(() => end("timeout")).not.toThrow();
      const noop = enabled.startSpan("not-a-trace-id", "dispatch");
      expect(() => noop()).not.toThrow();
    });

    it("startSpan null traceId（开关关闭期产生的历史执行）no-op", () => {
      const noop = enabled.startSpan(null, "dispatch");
      expect(() => noop()).not.toThrow();
    });

    it("buildTraceparentFromTraceId 构造可解析的回传头", () => {
      const tp = enabled.buildTraceparentFromTraceId(KNOWN_TRACE_ID);
      expect(enabled.extractContext(tp)).toEqual(KNOWN_TRACE_ID);
    });
  });

  describe("无 ConfigService 装配（既有单测兼容）", () => {
    it("@Optional 缺省降级为 disabled", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = new (TracingService as any)();
      expect(svc.isEnabled).toBe(false);
    });
  });

  describe("isValidTraceId 守卫", () => {
    it("合法 32 hex true；脏值 false（防落库）", () => {
      const enabled = makeService(true);
      expect(enabled.isValidTraceId(KNOWN_TRACE_ID)).toBe(true);
      expect(enabled.isValidTraceId("short")).toBe(false);
      expect(enabled.isValidTraceId(null)).toBe(false);
      expect(enabled.isValidTraceId(undefined)).toBe(false);
      expect(enabled.isValidTraceId(KNOWN_TRACE_ID.toUpperCase())).toBe(false);
    });
  });
});
