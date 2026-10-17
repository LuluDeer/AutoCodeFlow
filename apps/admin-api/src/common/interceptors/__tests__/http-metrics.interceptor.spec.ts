import { CallHandler, ExecutionContext } from "@nestjs/common";
import { of, throwError } from "rxjs";
import {
  HttpMetricsInterceptor,
  normalizeMethod,
  resolveRoutePattern,
} from "../http-metrics.interceptor";

/**
 * HTTP RED 拦截器单测。
 *
 * 断言面刻意只覆盖「拦截器自己的判定」——快照 → exposition 的映射在
 * prometheus-metrics.service.spec.ts 里测（那里有独立 Registry）。这里用
 * 一个只记录调用的假 PrometheusMetricsService，从而把三件事钉死：
 *   ① route label 必须是**路由模板**（具体 id 被折叠）；
 *   ② 未匹配路由 → "unmatched"（绝不回退原始 URL）；
 *   ③ SSE / text-event-stream 一律不入账。
 */
describe("HttpMetricsInterceptor (HTTP RED)", () => {
  /** 只实现拦截器用到的那一个方法 */
  const makeMetrics = () => ({ recordHttpRequest: jest.fn() });

  const makeContext = (req: unknown, res: unknown): ExecutionContext =>
    ({
      getType: () => "http",
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => res,
      }),
    }) as unknown as ExecutionContext;

  const makeReq = (over: Record<string, unknown> = {}) => ({
    method: "GET",
    path: "/api/tasks/8f3a1c2e-0000-4000-8000-000000000000",
    baseUrl: "/api/tasks",
    route: { path: "/:id" },
    ...over,
  });

  const makeRes = (over: Record<string, unknown> = {}) => ({
    statusCode: 200,
    getHeader: () => undefined,
    ...over,
  });

  const run = async (
    interceptor: HttpMetricsInterceptor,
    req: unknown,
    res: unknown,
    handler: CallHandler = { handle: () => of({ ok: true }) },
  ): Promise<void> => {
    await new Promise<void>((resolve) => {
      interceptor.intercept(makeContext(req, res), handler).subscribe({
        complete: () => resolve(),
        error: () => resolve(),
      });
    });
  };

  // ── 路由模板提取 ────────────────────────────────────────────────────
  describe("route pattern extraction", () => {
    it("folds a concrete id into the Express route template", async () => {
      const metrics = makeMetrics();
      const req = makeReq();
      await run(new HttpMetricsInterceptor(metrics as never), req, makeRes());

      expect(metrics.recordHttpRequest).toHaveBeenCalledTimes(1);
      const [method, route] = metrics.recordHttpRequest.mock.calls[0];
      expect(method).toBe("GET");
      // 关键断言：模板，不是 /api/tasks/8f3a1c2e-…
      expect(route).toBe("/api/tasks/:id");
      expect(route).not.toContain("8f3a1c2e");
    });

    it("joins baseUrl with a nested route template and collapses duplicate slashes", () => {
      expect(
        resolveRoutePattern({
          baseUrl: "/api/tasks/",
          route: { path: "/:taskId/executions" },
        } as never),
      ).toBe("/api/tasks/:taskId/executions");

      // 根级路由（baseUrl 为空、模板以 / 开头）
      expect(
        resolveRoutePattern({
          baseUrl: "",
          route: { path: "/health" },
        } as never),
      ).toBe("/health");
    });

    it("takes the first template when Express registers an array of paths", () => {
      expect(
        resolveRoutePattern({
          baseUrl: "/api",
          route: { path: ["/a/:id", "/b/:id"] },
        } as never),
      ).toBe("/api/a/:id");
    });

    it("normalizes a trailing slash and tolerates a missing baseUrl", () => {
      // 模板以 / 结尾（根路由 "/"）→ 去尾斜杠，避免 /api/ 与 /api 两条 series
      expect(
        resolveRoutePattern({ baseUrl: "/api", route: { path: "/" } } as never),
      ).toBe("/api");
      // baseUrl 缺失/非字符串时按空前缀处理（不能拼出 "undefined/..."）
      expect(
        resolveRoutePattern({
          baseUrl: undefined,
          route: { path: "/health" },
        } as never),
      ).toBe("/health");
      // 根路由 + 空 baseUrl：保持 "/"（不能退化成空串——空标签值自成 series）
      expect(
        resolveRoutePattern({ baseUrl: "", route: { path: "/" } } as never),
      ).toBe("/");
    });

    it("falls back to the fixed 'unmatched' label when no route matched (never the raw URL)", () => {
      const rawUrl = "/.env";
      const req = makeReq({
        route: undefined,
        baseUrl: "",
        path: rawUrl,
        originalUrl: rawUrl,
        url: rawUrl,
      });
      const route = resolveRoutePattern(req as never);
      expect(route).toBe("unmatched");
      expect(route).not.toContain(rawUrl);

      // 空模板同样归 unmatched（不是 ""，空标签值会自成一条 series）
      expect(
        resolveRoutePattern({ baseUrl: "/api", route: { path: "" } } as never),
      ).toBe("unmatched");
      expect(
        resolveRoutePattern({
          baseUrl: "/api",
          route: { path: 42 },
        } as never),
      ).toBe("unmatched");
    });

    it("uses the fixed unmatched label end-to-end for an unrouteable request", async () => {
      const metrics = makeMetrics();
      await run(
        new HttpMetricsInterceptor(metrics as never),
        makeReq({ route: undefined, baseUrl: "", path: "/wp-admin" }),
        makeRes({ statusCode: 404 }),
      );
      expect(metrics.recordHttpRequest.mock.calls[0][1]).toBe("unmatched");
      expect(metrics.recordHttpRequest.mock.calls[0][2]).toBe(404);
    });
  });

  // ── 状态码 / 方法 ──────────────────────────────────────────────────
  describe("status code and method capture", () => {
    it("reads the final statusCode at teardown (not at intercept time)", async () => {
      const metrics = makeMetrics();
      const res = makeRes({ statusCode: 200 });
      // 模拟处理器/异常过滤器在请求过程中改写状态码
      const handler: CallHandler = {
        handle: () => {
          res.statusCode = 503;
          return of(null);
        },
      };
      await run(
        new HttpMetricsInterceptor(metrics as never),
        makeReq(),
        res,
        handler,
      );
      expect(metrics.recordHttpRequest.mock.calls[0][2]).toBe(503);
    });

    it("records on the error path too (thrown handler still counts)", async () => {
      const metrics = makeMetrics();
      const res = makeRes({ statusCode: 500 });
      const handler: CallHandler = {
        handle: () => throwError(() => new Error("boom")),
      };
      await run(
        new HttpMetricsInterceptor(metrics as never),
        makeReq(),
        res,
        handler,
      );
      expect(metrics.recordHttpRequest).toHaveBeenCalledTimes(1);
      expect(metrics.recordHttpRequest.mock.calls[0][2]).toBe(500);
    });

    it("uppercases the method and falls back to UNKNOWN when absent", async () => {
      const metrics = makeMetrics();
      await run(
        new HttpMetricsInterceptor(metrics as never),
        makeReq({ method: "post" }),
        makeRes(),
      );
      expect(metrics.recordHttpRequest.mock.calls[0][0]).toBe("POST");
      expect(normalizeMethod(undefined)).toBe("UNKNOWN");
      expect(normalizeMethod("")).toBe("UNKNOWN");
      expect(normalizeMethod("Delete")).toBe("DELETE");
    });

    it("reports a non-negative finite duration in milliseconds", async () => {
      const metrics = makeMetrics();
      await run(
        new HttpMetricsInterceptor(metrics as never),
        makeReq(),
        makeRes(),
      );
      const duration = metrics.recordHttpRequest.mock.calls[0][3];
      expect(typeof duration).toBe("number");
      expect(Number.isFinite(duration)).toBe(true);
      expect(duration).toBeGreaterThanOrEqual(0);
    });
  });

  // ── SSE 排除 ───────────────────────────────────────────────────────
  describe("SSE / streaming exclusion", () => {
    it("skips requests whose response content-type is text/event-stream", async () => {
      const metrics = makeMetrics();
      await run(
        new HttpMetricsInterceptor(metrics as never),
        makeReq({ route: { path: "/metrics/stream" }, baseUrl: "/api" }),
        makeRes({
          statusCode: 200,
          getHeader: (name: string) =>
            name.toLowerCase() === "content-type"
              ? "text/event-stream; charset=utf-8"
              : undefined,
        }),
      );
      expect(metrics.recordHttpRequest).not.toHaveBeenCalled();
    });

    it("skips the historical /logs/stream path even without a content-type header", async () => {
      const metrics = makeMetrics();
      await run(
        new HttpMetricsInterceptor(metrics as never),
        makeReq({
          baseUrl: "/api/tasks",
          route: { path: "/:taskId/executions/:execId/logs/stream" },
          path: "/api/tasks/1/executions/2/logs/stream",
        }),
        makeRes({ getHeader: () => undefined }),
      );
      expect(metrics.recordHttpRequest).not.toHaveBeenCalled();
    });

    it("still records ordinary JSON responses (no over-exclusion)", async () => {
      const metrics = makeMetrics();
      await run(
        new HttpMetricsInterceptor(metrics as never),
        makeReq(),
        makeRes({
          getHeader: () => "application/json; charset=utf-8",
        }),
      );
      expect(metrics.recordHttpRequest).toHaveBeenCalledTimes(1);
    });
  });

  // ── 旁路安全 ───────────────────────────────────────────────────────
  it("never propagates a metrics failure into the response path", async () => {
    const metrics = {
      recordHttpRequest: jest.fn(() => {
        throw new Error("metrics exploded");
      }),
    };
    // 不抛错、正常 complete
    await expect(
      run(new HttpMetricsInterceptor(metrics as never), makeReq(), makeRes()),
    ).resolves.toBeUndefined();
  });

  it("passes non-HTTP contexts straight through without recording", async () => {
    const metrics = makeMetrics();
    const ctx = {
      getType: () => "rpc",
      switchToHttp: () => {
        throw new Error("must not be called for non-HTTP contexts");
      },
    } as unknown as ExecutionContext;
    await new Promise<void>((resolve) => {
      new HttpMetricsInterceptor(metrics as never)
        .intercept(ctx, { handle: () => of(null) })
        .subscribe({ complete: () => resolve() });
    });
    expect(metrics.recordHttpRequest).not.toHaveBeenCalled();
  });
});
