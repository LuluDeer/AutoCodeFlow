import "reflect-metadata";
import { CallHandler, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Observable, firstValueFrom, timer } from "rxjs";
import { mapTo } from "rxjs/operators";
import {
  SKIP_TIMEOUT_KEY,
  SkipTimeout,
} from "../decorators/skip-timeout.decorator";

/**
 * N8: the SKIP_TIMEOUT escape hatch was defined but never wired to any
 * route — the SSE log stream was cut by the global 30 s timeout(). These
 * tests pin the interceptor's metadata-driven bypass so the exemption on
 * TaskController.streamLogs actually works.
 */

// REQUEST_TIMEOUT_MS is read once at module load — set a short budget and
// load the interceptor fresh through isolateModules so it picks it up.
process.env.REQUEST_TIMEOUT_MS = "50";

function loadInterceptor(): new (reflector: Reflector) => {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown>;
} {
  let ctor: any;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ctor = require("../interceptors/timeout.interceptor").TimeoutInterceptor;
  });
  return ctor;
}

class FixtureController {
  @SkipTimeout()
  exempted() {}

  normal() {}
}

const makeCtx = (handler: Function): ExecutionContext =>
  ({
    getHandler: () => handler,
    getClass: () => FixtureController,
  }) as unknown as ExecutionContext;

const slowSource = (ms: number, value: unknown) =>
  timer(ms).pipe(mapTo(value));

describe("TimeoutInterceptor — SKIP_TIMEOUT bypass", () => {
  const reflector = new Reflector();

  it("@SkipTimeout() writes the SKIP_TIMEOUT_KEY metadata on the handler", () => {
    expect(
      Reflect.getMetadata(SKIP_TIMEOUT_KEY, FixtureController.prototype.exempted),
    ).toBe(true);
    expect(
      Reflect.getMetadata(SKIP_TIMEOUT_KEY, FixtureController.prototype.normal),
    ).toBeUndefined();
  });

  it("returns next.handle() untouched (no timeout pipe) for exempted handlers", () => {
    const Interceptor = loadInterceptor();
    const interceptor = new Interceptor(reflector);
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
    const Interceptor = loadInterceptor();
    const interceptor = new Interceptor(reflector);
    const source$ = slowSource(10, "ok");
    const next: CallHandler = { handle: () => source$ };

    const result = interceptor.intercept(
      makeCtx(FixtureController.prototype.normal),
      next,
    );

    expect(result).not.toBe(source$);
  });

  it("aborts a slow non-exempt handler with RequestTimeoutException", async () => {
    const Interceptor = loadInterceptor();
    const interceptor = new Interceptor(reflector);
    const result$ = interceptor.intercept(
      makeCtx(FixtureController.prototype.normal),
      { handle: () => slowSource(200, "late") },
    );

    // isolateModules gives the interceptor its own copy of @nestjs/common,
    // so instanceof against the outer import would fail despite the class
    // being identical — assert the observable contract (name + 408) instead.
    await expect(
      firstValueFrom(result$).catch((e: any) => ({
        name: e?.constructor?.name,
        status: typeof e?.getStatus === "function" ? e.getStatus() : undefined,
      })),
    ).resolves.toEqual({ name: "RequestTimeoutException", status: 408 });
  });

  it("lets a slow exempted handler (SSE-style stream) run past the timeout", async () => {
    const Interceptor = loadInterceptor();
    const interceptor = new Interceptor(reflector);
    const result$ = interceptor.intercept(
      makeCtx(FixtureController.prototype.exempted),
      { handle: () => slowSource(120, "late") },
    );

    await expect(firstValueFrom(result$)).resolves.toBe("late");
  });
});
