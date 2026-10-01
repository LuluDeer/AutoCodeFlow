import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { MetricsScraperAuthGuard } from "../metrics-scraper-auth.guard";

/**
 * MetricsScraperAuthGuard 三态单测:未设置令牌=纯 JWT 回落、令牌命中=放行、
 * 令牌不匹配=回落 JWT(不比改造前更宽松)。JWT 侧以 stub canActivate 替身,
 * 只断言本守卫自身的分流逻辑(真 JWT 流程有 auth 域既有测试背书)。
 */

const makeCtx = (authorization?: string): ExecutionContext => {
  const req: Record<string, unknown> = { headers: {} };
  if (authorization !== undefined) req.headers = { authorization };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
};

const makeJwt = (result: boolean): JwtAuthGuard =>
  ({
    canActivate: jest.fn(() => Promise.resolve(result)),
  }) as unknown as JwtAuthGuard;

const callsOf = (jwt: JwtAuthGuard) => (jwt.canActivate as unknown as jest.Mock).mock;

const makeConfig = (token?: string) =>
  ({ get: (key: string) => (key === "metricsScraperToken" ? token : undefined) }) as unknown as ConfigService;

describe("MetricsScraperAuthGuard", () => {
  it("未设置 METRICS_SCRAPER_TOKEN → 全部落 JWT(行为与改造前一致)", async () => {
    const jwt = makeJwt(true);
    const guard = new MetricsScraperAuthGuard(
      new Reflector(),
      makeConfig(undefined),
      jwt,
    );
    await expect(
      guard.canActivate(makeCtx("Bearer whatever") as never as ExecutionContext),
    ).resolves.toBe(true);
    expect(callsOf(jwt).calls.length).toBeGreaterThan(0);
  });

  it("令牌命中(Bearer 精确匹配)→ 放行且不触发 JWT", async () => {
    const jwt = makeJwt(false);
    const guard = new MetricsScraperAuthGuard(
      new Reflector(),
      makeConfig("scraper-secret"),
      jwt,
    );
    await expect(
      guard.canActivate(makeCtx("Bearer scraper-secret")),
    ).resolves.toBe(true);
    expect(callsOf(jwt).calls.length).toBe(0);
  });

  it("令牌不匹配 → 回落 JWT(不比改造前更宽松)", async () => {
    const jwt = makeJwt(true);
    const guard = new MetricsScraperAuthGuard(
      new Reflector(),
      makeConfig("scraper-secret"),
      jwt,
    );
    await expect(
      guard.canActivate(makeCtx("Bearer wrong-token")),
    ).resolves.toBe(true);
    expect(callsOf(jwt).calls.length).toBeGreaterThan(0);
  });

  it("无 Authorization 头 + 令牌已设 → 回落 JWT", async () => {
    const jwt = makeJwt(true);
    const guard = new MetricsScraperAuthGuard(
      new Reflector(),
      makeConfig("scraper-secret"),
      jwt,
    );
    await expect(guard.canActivate(makeCtx(undefined))).resolves.toBe(true);
    expect(callsOf(jwt).calls.length).toBeGreaterThan(0);
  });

  it("恒时比较:长度不同的令牌不抛异常并判不匹配", async () => {
    const jwt = makeJwt(true);
    const guard = new MetricsScraperAuthGuard(
      new Reflector(),
      makeConfig("short"),
      jwt,
    );
    await expect(
      guard.canActivate(makeCtx("Bearer a-much-longer-token-value")),
    ).resolves.toBe(true);
    expect(callsOf(jwt).calls.length).toBeGreaterThan(0);
  });
});
