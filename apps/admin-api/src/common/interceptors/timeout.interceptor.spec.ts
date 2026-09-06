import "reflect-metadata";
import { CallHandler, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { firstValueFrom, timer } from "rxjs";
import { mapTo } from "rxjs/operators";
import { TimeoutInterceptor } from "./timeout.interceptor";
import {
  SKIP_TIMEOUT_KEY,
  SkipTimeout,
} from "../decorators/skip-timeout.decorator";

/**
 * N8: the SKIP_TIMEOUT escape hatch was defined but never wired to any
 * route — the SSE log stream was cut by the global 30 s timeout(). These
 * tests pin the interceptor's metadata-driven bypass so the exemption on
 * TaskController.streamLogs actually works.
 *
 * ARCH-27: the timeout budget is no longer a module-load-time
 * process.env.REQUEST_TIMEOUT_MS read — it comes from ConfigService
 * (app.requestTimeoutMs, registered in configuration.ts). Tests inject a
 * stub ConfigService instead of mutating env before an isolateModules load.
 */

const makeConfig = (timeoutMs: number | undefined) =>
  ({
    get: jest.fn((key: string) =>
      key === "app.requestTimeoutMs" ? timeoutMs : undefined,
    ),
  }) as unknown as ConfigService;

class FixtureController {
  @SkipTimeout()
  exempted() {}

  normal() {}
}

const makeCtx = (handler: (...args: unknown[]) => unknown): ExecutionContext =>
  ({
    getHandler: () => handler,
    getClass: () => FixtureController,
  }) as unknown as ExecutionContext;

const slowSource = (ms: number, value: unknown) => timer(ms).pipe(mapTo(value));

describe("TimeoutInterceptor — SKIP_TIMEOUT bypass", () => {
  const reflector = new Reflector();

  it("@SkipTimeout() writes the SKIP_TIMEOUT_KEY metadata on the handler", () => {
    expect(
      Reflect.getMetadata(
        SKIP_TIMEOUT_KEY,
        FixtureController.prototype.exempted,
      ),
    ).toBe(true);
    expect(
      Reflect.getMetadata(SKIP_TIMEOUT_KEY, FixtureController.prototype.normal),
    ).toBeUndefined();
  });

  it("returns next.handle() untouched (no timeout pipe) for exempted handlers", () => {
    const interceptor = new TimeoutInterceptor(reflector, makeConfig(50));
    const source$ = slowSource(10, "ok");
    const next: CallHandler = { handle: () => source$ };

    const result = interceptor.intercept(
      makeCtx(FixtureController.prototype.exempted),
      next,
    );

    // Identity check: the bypass must return the very same observable.
    expect(result).toBe(source$);
  });

  it("wraps the observable (timeout applied) for handlers without metadata", () => {
    const interceptor = new TimeoutInterceptor(reflector, makeConfig(50));
    const source$ = slowSource(10, "ok");
    const next: CallHandler = { handle: () => source$ };

    const result = interceptor.intercept(
      makeCtx(FixtureController.prototype.normal),
      next,
    );

    expect(result).not.toBe(source$);
  });

  it("aborts a slow non-exempt handler with RequestTimeoutException", async () => {
    const interceptor = new TimeoutInterceptor(reflector, makeConfig(50));
    const result$ = interceptor.intercept(
      makeCtx(FixtureController.prototype.normal),
      { handle: () => slowSource(200, "late") },
    );

    await expect(
      firstValueFrom(result$).catch((e: any) => ({
        name: e?.constructor?.name,
        status: typeof e?.getStatus === "function" ? e.getStatus() : undefined,
      })),
    ).resolves.toEqual({ name: "RequestTimeoutException", status: 408 });
  });

  it("lets a slow exempted handler (SSE-style stream) run past the timeout", async () => {
    const interceptor = new TimeoutInterceptor(reflector, makeConfig(50));
    const result$ = interceptor.intercept(
      makeCtx(FixtureController.prototype.exempted),
      { handle: () => slowSource(120, "late") },
    );

    await expect(firstValueFrom(result$)).resolves.toBe("late");
  });
});

describe("TimeoutInterceptor — timeout budget source (ARCH-27)", () => {
  const reflector = new Reflector();

  it("reads the budget from ConfigService via app.requestTimeoutMs", async () => {
    const config = makeConfig(50);
    const interceptor = new TimeoutInterceptor(reflector, config);
    const result$ = interceptor.intercept(
      makeCtx(FixtureController.prototype.normal),
      {
        handle: () => slowSource(200, "late"),
      },
    );

    await expect(firstValueFrom(result$)).rejects.toMatchObject({
      status: 408,
    });
    expect(config.get).toHaveBeenCalledWith("app.requestTimeoutMs");
  });

  it("falls back to the 30 s default when ConfigService has no value", () => {
    // 无注入值时不能抛错（main.ts 兜底路径 / 裸构造场景）。
    const interceptor = new TimeoutInterceptor(
      reflector,
      makeConfig(undefined),
    );
    const source$ = slowSource(10, "ok");
    const next: CallHandler = { handle: () => source$ };
    expect(() =>
      interceptor.intercept(makeCtx(FixtureController.prototype.normal), next),
    ).not.toThrow();
  });

  it("stays constructible without ConfigService (compat with bare `new`)", () => {
    const interceptor = new TimeoutInterceptor(reflector);
    const source$ = slowSource(10, "ok");
    const next: CallHandler = { handle: () => source$ };
    const result = interceptor.intercept(
      makeCtx(FixtureController.prototype.normal),
      next,
    );
    expect(result).not.toBe(source$);
  });
});
