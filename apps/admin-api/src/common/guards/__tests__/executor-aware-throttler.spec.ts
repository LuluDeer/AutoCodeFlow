import { Test, TestingModule } from "@nestjs/testing";
import { ThrottlerGuard, ThrottlerStorage, ThrottlerStorageService } from "@nestjs/throttler";
import {
  EXECUTOR_MACHINE_PATH_PATTERNS,
  ExecutorAwareThrottlerGuard,
  isExecutorMachinePath,
  normalizeThrottlePath,
} from "../executor-aware-throttler.guard";

/**
 * SEC-THROTTLE-BUCKET（审计 P1-1，2026-10-17）：限流桶绕过。
 *
 * 缺陷：ExecutorAwareThrottlerGuard 是**全局** APP_GUARD，而它的 getTracker
 * 无条件读 `x-executor-address` 头并据此分桶。攻击者只要在每个登录请求上换
 * 一个不同的地址值，就能拿到无限个独立计桶——`/auth/login` 的 20/min 与账号
 * 锁定形同虚设（可无限速率暴力破解）。
 *
 * 修复：分桶键只在**执行器机器面路由**上才认这个头；人操作面一律回退到
 * super 的 IP 键。本 spec 钉住三件事：
 *   1. 人操作面伪造任意多地址值 → 始终同一个 IP 键（绕过面已关闭）；
 *   2. 机器面仍然按执行器地址分桶（B-2 的收益不丢）；
 *   3. 路径归一化不因 query / 尾斜杠 / 全局 api 前缀漂移。
 *
 * 装配方式与 throttle-domains.spec 一致：真实 ThrottlerGuard + 真实内存存储，
 * 因此 `super.getTracker` 走的是 @nestjs/throttler 的**真实** IP 回退实现
 * （req.ips?.[0] ?? req.ip），而非桩——绕过面是否真的关闭由生产代码决定。
 */
describe("ExecutorAwareThrottlerGuard — SEC-THROTTLE-BUCKET", () => {
  /** 测试缝：把 protected getTracker 提升为 public 供断言直接驱动。 */
  class ProbeGuard extends ExecutorAwareThrottlerGuard {
    public async tracker(req: Record<string, any>): Promise<string> {
      return super.getTracker(req);
    }
  }

  let guard: ProbeGuard;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProbeGuard,
        {
          provide: "THROTTLER:MODULE_OPTIONS",
          useValue: { throttlers: [{ name: "default", ttl: 60_000, limit: 60 }] },
        },
        {
          provide: ThrottlerStorage as unknown as string,
          useFactory: () => new ThrottlerStorageService(),
        },
      ],
    }).compile();
    guard = module.get<ProbeGuard>(ProbeGuard);
    await (guard as unknown as { onModuleInit: () => Promise<void> })
      .onModuleInit();
  });

  const callTracker = (
    req: Record<string, any>,
  ): Promise<string> => guard.tracker(req);

  // ─── 人操作面：头必须被完全忽略 ──────────────────────────────────────────
  it("P1-1 回归：/api/auth/login 上伪造 100 个不同的 x-executor-address 仍得到同一个桶", async () => {
    const buckets = new Set<string>();
    for (let i = 0; i < 100; i++) {
      buckets.add(
        await callTracker({
          ip: "203.0.113.9",
          path: "/api/auth/login",
          headers: { "x-executor-address": `forged-${i}` },
        }),
      );
    }
    expect(buckets.size).toBe(1);
    expect([...buckets][0]).toBe("203.0.113.9");
  });

  it("P1-1 回归：其余人操作面（tasks/users/config/metrics）同样不认该头", async () => {
    for (const path of [
      "/api/tasks",
      "/api/users/1",
      "/api/config",
      "/api/metrics",
      "/api/applications",
      "/api/audit",
      "/api/auth/refresh",
      "/api/auth/totp/verify",
    ]) {
      const tracker = await callTracker({
        ip: "198.51.100.7",
        path,
        headers: { "x-executor-address": "evil:1" },
      });
      expect({ path, tracker }).toEqual({ path, tracker: "198.51.100.7" });
    }
  });

  // ─── 机器面：B-2 的收益必须保留 ──────────────────────────────────────────
  it("机器面仍按执行器地址分桶（B-2 收益不丢）", async () => {
    const a = await callTracker({
      ip: "10.0.0.1",
      path: "/api/executions/callback",
      headers: { "x-executor-address": "exec-a:8002" },
    });
    const b = await callTracker({
      ip: "10.0.0.1",
      path: "/api/executions/callback",
      headers: { "x-executor-address": "exec-b:8002" },
    });
    expect(a).toBe("executor:exec-a:8002");
    expect(b).toBe("executor:exec-b:8002");
    expect(a).not.toBe(b);
  });

  it("机器面不带头 / 头为空 → 回退 IP 键（旧执行器行为不变）", async () => {
    expect(
      await callTracker({
        ip: "10.0.0.1",
        path: "/api/executors/heartbeat",
        headers: {},
      }),
    ).toBe("10.0.0.1");
    expect(
      await callTracker({
        ip: "10.0.0.1",
        path: "/api/executors/heartbeat",
        headers: { "x-executor-address": "   " },
      }),
    ).toBe("10.0.0.1");
  });

  it("RT-LOG 日志上报（/executions/:id/logs）属于机器面，路径参数不破坏匹配", async () => {
    expect(
      isExecutorMachinePath("/api/executions/exec-abc-123/logs"),
    ).toBe(true);
    // 不能被前缀误吞到别的端点
    expect(isExecutorMachinePath("/api/executions/exec-1/logs/stream")).toBe(
      false,
    );
  });

  // ─── 路径归一化 ──────────────────────────────────────────────────────────
  it("归一化剥离 query / 尾斜杠 / 缺失前导斜杠", () => {
    expect(normalizeThrottlePath({ path: "/api/auth/login" })).toBe(
      "/api/auth/login",
    );
    expect(
      normalizeThrottlePath({ originalUrl: "/api/executions/callback?x=1" }),
    ).toBe("/api/executions/callback");
    expect(normalizeThrottlePath({ path: "/api/executors/pull/" })).toBe(
      "/api/executors/pull",
    );
    expect(normalizeThrottlePath({ url: "api/executors/heartbeat" })).toBe(
      "/api/executors/heartbeat",
    );
    expect(normalizeThrottlePath({})).toBe("");
    expect(normalizeThrottlePath({ path: 42 })).toBe("");
  });

  it("模式表覆盖全部执行器入站机器面（新增端点时必须同步登记）", () => {
    const expected = [
      "/api/executions/callback",
      "/api/executions/exec-1/logs",
      "/api/executors/register",
      "/api/executors/heartbeat",
      "/api/executors/pull",
      "/api/executors/command-result",
      "/api/executors/offline",
      "/api/executors/token",
    ];
    for (const path of expected) {
      expect({ path, ok: isExecutorMachinePath(path) }).toEqual({
        path,
        ok: true,
      });
    }
    expect(EXECUTOR_MACHINE_PATH_PATTERNS.length).toBe(expected.length);
  });
});
