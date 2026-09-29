/**
 * P1-1a（nginx-sse 生产事故根治）：SSE 压缩豁免谓词的单元测试。
 *
 * 覆盖三层判定与 filter 接线：
 * 1. content-type 判定（根治项）：text/event-stream → 豁免；普通 json → 走
 *    compression.filter 链路（mock 断言透传）；大小写不敏感；header 未设置 →
 *    不判 SSE（交给路径兜底/默认 filter）。
 * 2. /logs/stream 路径判定（双保险）：content-type 缺失时仍豁免既有日志流。
 * 3. 接线：SSE 时短路 return false 且**不**调用 compression.filter；
 *    非 SSE 时把 (req, res) 原样透传给 compression.filter。
 *
 * 时序依据（为什么 content-type 在 filter 时机可读）：compression@1.8.2 在
 * onHeaders 钩子（writeHead 同步段）内调用 filter（index.js:174-179），而 SSE
 * 控制器在首帧 write 前已 setHeader —— 详见 sse-compression.util.ts 头注。
 * 不 import main.ts（顶层 dotenv 副作用），main.ts 只做接线。
 */
import compression from "compression";
import {
  hasSseContentType,
  isSsePath,
  isSseResponse,
  sseAwareCompressionFilter,
} from "./sse-compression.util";
import type { Request, Response } from "express";

function makeRes(headers: Record<string, string | string[]> = {}) {
  return {
    getHeader: (name: string) =>
      headers[name.toLowerCase()] as ReturnType<
        Response["getHeader"]
      >,
  };
}

function makeReq(path: string) {
  return { path } as Pick<Request, "path"> as Request;
}

describe("P1-1a sse-compression.util — SSE 压缩豁免谓词", () => {
  describe("hasSseContentType（content-type 判定 = 根治项）", () => {
    it("text/event-stream → true（含带 charset 的完整串）", () => {
      expect(hasSseContentType(makeRes({ "content-type": "text/event-stream" }))).toBe(true);
      expect(
        hasSseContentType(
          makeRes({ "content-type": "text/event-stream; charset=utf-8" }),
        ),
      ).toBe(true);
    });

    it("大小写不敏感（Text/Event-Stream 也命中）", () => {
      expect(
        hasSseContentType(makeRes({ "content-type": "Text/Event-Stream" })),
      ).toBe(true);
    });

    it("普通 json / 未设置 content-type → false", () => {
      expect(
        hasSseContentType(
          makeRes({ "content-type": "application/json; charset=utf-8" }),
        ),
      ).toBe(false);
      expect(hasSseContentType(makeRes())).toBe(false);
    });
  });

  describe("isSsePath（/logs/stream 路径判定 = 双保险）", () => {
    it("日志流路径 → true", () => {
      expect(
        isSsePath(makeReq("/api/tasks/t1/executions/e1/logs/stream")),
      ).toBe(true);
      // 无全局前缀的裸路径同样命中（setGlobalPrefix 对 req.path 透明）
      expect(isSsePath(makeReq("/tasks/t1/executions/e1/logs/stream"))).toBe(
        true,
      );
    });

    it("其他路径 → false（/metrics/stream 靠 content-type 命中）", () => {
      expect(isSsePath(makeReq("/api/metrics/stream"))).toBe(false);
      expect(isSsePath(makeReq("/api/executions/stream"))).toBe(false);
    });
  });

  describe("isSseResponse（合成谓词：content-type 为主，路径兜底）", () => {
    it("SSE content-type → true（任意路径，含未来的 SSE 路由）", () => {
      expect(
        isSseResponse(
          makeReq("/api/anything/future/stream"),
          makeRes({ "content-type": "text/event-stream" }),
        ),
      ).toBe(true);
    });

    it("logs/stream 路径 + content-type 尚未设置 → 仍 true（兜底生效）", () => {
      expect(isSseResponse(makeReq("/api/x/logs/stream"), makeRes())).toBe(true);
    });

    it("普通 json 响应 → false", () => {
      expect(
        isSseResponse(
          makeReq("/api/tasks"),
          makeRes({ "content-type": "application/json" }),
        ),
      ).toBe(false);
    });
  });

  describe("sseAwareCompressionFilter（main.ts 接线契约）", () => {
    let filterSpy: jest.SpyInstance;

    beforeEach(() => {
      filterSpy = jest.spyOn(compression, "filter");
    });

    afterEach(() => {
      filterSpy.mockRestore();
    });

    it("SSE content-type → 直接 false，且不调用 compression.filter（短路）", () => {
      const res = makeRes({
        "content-type": "text/event-stream",
      }) as unknown as Response;
      expect(sseAwareCompressionFilter(makeReq("/api/metrics/stream"), res)).toBe(
        false,
      );
      expect(filterSpy).not.toHaveBeenCalled();
    });

    it("普通 json → 透传 compression.filter 的判定结果（true 与 false 两种）", () => {
      const req = makeReq("/api/tasks");
      const res = makeRes({
        "content-type": "application/json; charset=utf-8",
      }) as unknown as Response;

      filterSpy.mockReturnValue(true);
      expect(sseAwareCompressionFilter(req, res)).toBe(true);

      filterSpy.mockReturnValue(false);
      expect(sseAwareCompressionFilter(req, res)).toBe(false);

      expect(filterSpy).toHaveBeenCalledWith(req, res);
      expect(filterSpy).toHaveBeenCalledTimes(2);
    });
  });
});
