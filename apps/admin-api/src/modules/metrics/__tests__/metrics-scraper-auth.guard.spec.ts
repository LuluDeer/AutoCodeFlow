import { Injectable, Inject, Logger, Optional } from "@nestjs/common";
import { ExecutionContext } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { MetricsScraperAuthGuard } from "../metrics-scraper-auth.guard";
import configuration from "../../../config/configuration";

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

const callsOf = (jwt: JwtAuthGuard) =>
  (jwt.canActivate as unknown as jest.Mock).mock;

const makeConfig = (token?: string) =>
  ({
    get: (key: string) => (key === "metricsScraperToken" ? token : undefined),
  }) as unknown as ConfigService;

// 生产配置形状：值嵌在 database 节下（configuration.ts database.metricsScraperToken）。
const makeNestedConfig = (token?: string) =>
  ({
    get: (key: string) =>
      key === "database.metricsScraperToken" ? token : undefined,
  }) as unknown as ConfigService;

describe("MetricsScraperAuthGuard", () => {
  it("未设置 METRICS_SCRAPER_TOKEN → 全部落 JWT(行为与改造前一致)", async () => {
    const jwt = makeJwt(true);
    const guard = new MetricsScraperAuthGuard(
      new Reflector(),
      makeConfig(undefined),
      jwt,
    );
    await expect(
      guard.canActivate(
        makeCtx("Bearer whatever") as never as ExecutionContext,
      ),
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

it("生产配置形状(database.metricsScraperToken 嵌套)→ 命中放行(2026-10-01 chaos 实跑回归)", async () => {
  const jwt = makeJwt(false);
  const guard = new MetricsScraperAuthGuard(
    new Reflector(),
    makeNestedConfig("scraper-secret"),
    jwt,
  );
  await expect(
    guard.canActivate(
      makeCtx("Bearer scraper-secret") as never as ExecutionContext,
    ),
  ).resolves.toBe(true);
  expect(callsOf(jwt).calls.length).toBe(0);
});

/**
 * DI 装配回归（2026-10-02 根因收口，2026-10-01 chaos 实跑"ConfigService 注入
 * 为 undefined"的谜底）：Nest reflectConstructorParams 合并 self-declared deps
 * 用原型链敏感的 Reflect.getMetadata —— 基类 JwtAuthGuard 构造器 index[1] 的
 * @Inject(API_KEY_AUTH_FACADE) 会覆写本守卫 index[1] 的 ConfigService 类型
 * 推断（容器无该 token → @Optional 吞成 undefined）。守卫侧已以显式
 * @Inject(ConfigService) 覆盖回正确 token；本组测试锁定两条线：真装配行为
 * 正常 + 上游覆写行为仍存在（Nest 升级行为变化时在此报警）。
 */
@Injectable()
class StrictCloneGuard extends JwtAuthGuard {
  // 故意不做 @Inject 显式声明 —— 复现原型链覆写。
  constructor(
    reflector: Reflector,
    public readonly cs: ConfigService,
  ) {
    super(reflector);
  }
}

@Injectable()
class CloneGuardWithFix extends JwtAuthGuard {
  constructor(
    reflector: Reflector,
    @Optional()
    @Inject(ConfigService)
    public readonly cs: ConfigService | undefined,
  ) {
    super(reflector);
  }
}

describe("MetricsScraperAuthGuard DI 装配回归（Nest 原型链 self-deps 覆写）", () => {
  afterEach(() => {
    delete process.env.METRICS_SCRAPER_TOKEN;
    jest.restoreAllMocks();
  });

  const compileModule = async () =>
    Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [configuration],
          envFilePath: "no-such-env-file.nonexistent",
        }),
      ],
      providers: [CloneGuardWithFix, MetricsScraperAuthGuard],
    }).compile();

  it("真实 ConfigModule.forRoot(isGlobal) 装配：ConfigService 注入成功、无 unavailable warn、取到 database.metricsScraperToken 并命中放行", async () => {
    const warnSpy = jest.spyOn(Logger.prototype, "warn");
    process.env.METRICS_SCRAPER_TOKEN = "di-regression-token";

    const moduleRef = await compileModule();
    const guard = moduleRef.get(CloneGuardWithFix);

    const unavailableWarns = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes("ConfigService unavailable"));
    expect(unavailableWarns).toEqual([]);
    expect(guard.cs).toBeDefined();
    expect(guard.cs.get<string>("database.metricsScraperToken")).toBe(
      "di-regression-token",
    );

    const guardProd = moduleRef.get(MetricsScraperAuthGuard);
    await expect(
      guardProd.canActivate(makeCtx("Bearer di-regression-token")),
    ).resolves.toBe(true);
  });

  it("上游行为锁定：无显式 @Inject 的同构克隆 index[1] 仍按基类 API_KEY_AUTH_FACADE 解析失败（Nest 覆写坑未修复，升级变化在此报警）", async () => {
    const compile = () =>
      Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
            load: [configuration],
            envFilePath: "no-such-env-file.nonexistent",
          }),
        ],
        providers: [StrictCloneGuard],
      }).compile();
    await expect(compile()).rejects.toThrow(
      /API_KEY_AUTH_FACADE" at index \[1\]/,
    );
  });
});
