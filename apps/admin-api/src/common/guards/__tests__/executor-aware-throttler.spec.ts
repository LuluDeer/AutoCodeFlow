import { Test, TestingModule } from "@nestjs/testing";
import { ThrottlerStorage, ThrottlerStorageService } from "@nestjs/throttler";
import {
  EXECUTOR_MACHINE_PATH_PATTERNS,
  ExecutorAwareThrottlerGuard,
  MAX_MACHINE_ADDRESSES_PER_IP,
  MAX_TRACKED_THROTTLE_IPS,
  isExecutorMachinePath,
  normalizeMachineAddress,
  normalizeThrottlePath,
  suggestWhitelistTemplate,
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
          useValue: {
            throttlers: [{ name: "default", ttl: 60_000, limit: 60 }],
          },
        },
        {
          provide: ThrottlerStorage as unknown as string,
          useFactory: () => new ThrottlerStorageService(),
        },
      ],
    }).compile();
    guard = module.get<ProbeGuard>(ProbeGuard);
    await (
      guard as unknown as { onModuleInit: () => Promise<void> }
    ).onModuleInit();
  });

  const callTracker = (req: Record<string, any>): Promise<string> =>
    guard.tracker(req);

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

  // ─── SEC-THROTTLE-BUCKET-P3：机器面桶键的值域必须有界 ────────────────────
  //
  // 缺陷形态：机器面路由的桶键是 `executor:{原始头值}`。值域由客户端决定 ⇒
  // 每个请求换一个值就得到一个新的 60/min 桶，限流对**未认证**洪泛形同不存在
  // （回调面另有 F1 的 per-IP 硬顶，其余机器面路由一条硬顶都没有）。
  // 修法 ②：形态归一化（字符集 + 长度）+ 每个来源 IP 的独立桶名额上限。
  // 下面这些用例钉住「伪造换桶」的天花板；把 getTracker 还原成
  // `executor:{req.headers[...]}` 时第 1、2、4 条会直接变红。

  it("P3 修法 ②-1：归一化只放行执行器地址的真实形态，其余一律拒绝", () => {
    for (const ok of [
      "exec-a:8002",
      "10.0.0.7:9000",
      "rpa5.local",
      "[::1]:8002",
      "RPA5:8002",
    ]) {
      expect({ value: ok, normalized: normalizeMachineAddress(ok) }).toEqual({
        value: ok,
        normalized: ok,
      });
    }
    // 首尾空白是历史遗留形态（旧实现 trim 过），归一化后仍同一桶。
    expect(normalizeMachineAddress("  exec-a:8002 ")).toBe("exec-a:8002");
    for (const bad of [
      "",
      "   ",
      "a".repeat(65),
      "exec a:8002",
      "exec-a:8002/../../etc",
      "<script>alert(1)</script>",
      "exec-a:8002\n伪造日志行",
      null,
      undefined,
      42,
      {},
    ]) {
      expect({ bad, normalized: normalizeMachineAddress(bad) }).toEqual({
        bad,
        normalized: null,
      });
    }
  });

  it("P3 修法 ②-2：同一 IP 伪造 1000 个地址，独立桶数被钳在名额上限（不再无限）", async () => {
    const buckets = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      buckets.add(
        await callTracker({
          ip: "192.0.2.10",
          path: "/api/executors/heartbeat",
          headers: { "x-executor-address": `forged-${i}:8002` },
        }),
      );
    }
    // 名额内的地址各得一个桶，超出的全部落回该 IP 的桶 ⇒ 上限 + 1。
    expect({
      buckets: buckets.size,
      cap: MAX_MACHINE_ADDRESSES_PER_IP,
    }).toEqual({ buckets: MAX_MACHINE_ADDRESSES_PER_IP + 1, cap: 200 });
    // 第 201 个值拿到的就是 IP 桶本身（不是新桶）。
    expect(
      await callTracker({
        ip: "192.0.2.10",
        path: "/api/executors/heartbeat",
        headers: {
          "x-executor-address": `forged-${MAX_MACHINE_ADDRESSES_PER_IP}:8002`,
        },
      }),
    ).toBe("192.0.2.10");
  });

  it("P3 修法 ②-3：名额按来源 IP 隔离——一个 IP 打满名额挤不掉别的 IP 的桶", async () => {
    for (let i = 0; i < MAX_MACHINE_ADDRESSES_PER_IP + 5; i++) {
      await callTracker({
        ip: "192.0.2.20",
        path: "/api/executors/pull",
        headers: { "x-executor-address": `flood-${i}:8002` },
      });
    }
    // 同一地址在新 IP 上仍然拿自己的桶（名额是 per-IP 的，不是全局共享）。
    expect(
      await callTracker({
        ip: "192.0.2.21",
        path: "/api/executors/pull",
        headers: { "x-executor-address": "flood-0:8002" },
      }),
    ).toBe("executor:flood-0:8002");
    // 而原 IP 上自己的名额用尽后，新值只能落回 IP 桶。
    expect(
      await callTracker({
        ip: "192.0.2.20",
        path: "/api/executors/pull",
        headers: { "x-executor-address": "late-comer:8002" },
      }),
    ).toBe("192.0.2.20");
  });

  it("P3 修法 ②-4：非法/超长地址既不产生新桶，也不消耗名额", async () => {
    const buckets = new Set<string>();
    for (let i = 0; i < 300; i++) {
      buckets.add(
        await callTracker({
          ip: "192.0.2.30",
          path: "/api/executions/exec-1/logs",
          headers: { "x-executor-address": `evil ${i}/../${"x".repeat(80)}` },
        }),
      );
    }
    expect([...buckets]).toEqual(["192.0.2.30"]);
    // 名额表里没有为这个 IP 建过任何条目（非法值连表都不该碰）。
    const slots = (
      guard as unknown as { machineAddressSlots: Map<string, Set<string>> }
    ).machineAddressSlots;
    expect(slots.has("192.0.2.30")).toBe(false);
    // 反证侧：紧随其后的**合法**地址仍能拿到自己的桶（名额没被垃圾值吃掉）。
    expect(
      await callTracker({
        ip: "192.0.2.30",
        path: "/api/executions/exec-1/logs",
        headers: { "x-executor-address": "exec-after-junk:8002" },
      }),
    ).toBe("executor:exec-after-junk:8002");
  });

  it("P3 修法 ②-5：名额表自身有上界（随机源 IP 轮换撑不爆内存）", async () => {
    for (let i = 0; i < MAX_TRACKED_THROTTLE_IPS + 500; i++) {
      await callTracker({
        ip: `198.18.${Math.floor(i / 256)}.${i % 256}`,
        path: "/api/executors/heartbeat",
        headers: { "x-executor-address": `rot-${i}:8002` },
      });
    }
    const slots = (
      guard as unknown as { machineAddressSlots: Map<string, Set<string>> }
    ).machineAddressSlots;
    expect(slots.size).toBeLessThanOrEqual(MAX_TRACKED_THROTTLE_IPS);
    // 非空断言：防止这条用例在「名额表根本没被写」的实现下变成永真
    // （把 getTracker 还原成原始头值时，名额表恒为空 ⇒ 上一行必然绿）。
    expect(slots.size).toBeGreaterThan(0);
    // 清空后仍能继续服务（清空是最轻的有界策略，不影响正确性）。
    expect(
      await callTracker({
        ip: "203.0.113.200",
        path: "/api/executors/heartbeat",
        headers: { "x-executor-address": "exec-after-clear:8002" },
      }),
    ).toBe("executor:exec-after-clear:8002");
  });

  it("RT-LOG 日志上报（/executions/:id/logs）属于机器面，路径参数不破坏匹配", async () => {
    expect(isExecutorMachinePath("/api/executions/exec-abc-123/logs")).toBe(
      true,
    );
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
      // SEC-THROTTLE-WHITELIST-GAP：pull 配置热更新 + 死信对账此前漏登记。
      "/api/executors/config",
      "/api/executors/RPA5:8002/terminal-states",
    ];
    for (const path of expected) {
      expect({ path, ok: isExecutorMachinePath(path) }).toEqual({
        path,
        ok: true,
      });
    }
    expect(EXECUTOR_MACHINE_PATH_PATTERNS.length).toBe(expected.length);
  });

  // ─── SEC-THROTTLE-WHITELIST-GAP：漏登记的两条机器面路由 ──────────────────
  it("漏登记修复：pull 配置热更新与死信对账按执行器分桶（不再退回 IP 键）", async () => {
    for (const path of [
      "/api/executors/config",
      "/api/executors/RPA5:8002/terminal-states",
    ]) {
      const tracker = await callTracker({
        ip: "10.0.0.1",
        path,
        headers: { "x-executor-address": "exec-a:8002" },
      });
      // 退回 IP 键时这里会是 "10.0.0.1"——正是多执行器共享 NAT 下被误杀的形态。
      expect({ path, tracker }).toEqual({
        path,
        tracker: "executor:exec-a:8002",
      });
    }
  });

  it("新登记的模式不越权吞掉相邻的人操作面路由", () => {
    for (const path of [
      "/api/executors/config/extra",
      "/api/executors/terminal-states",
      "/api/executors/1/terminal-states/2",
      "/api/executors",
      "/api/executors/1",
    ]) {
      expect({ path, ok: isExecutorMachinePath(path) }).toEqual({
        path,
        ok: false,
      });
    }
  });

  // ─── 运行时漏登记告警（PLAN-SECURITY-HARDENING §1.2）─────────────────────
  it("模板收敛：具体路径 → 可登记的正则模板", () => {
    expect(
      suggestWhitelistTemplate("/api/executors/RPA5:8002/terminal-states"),
    ).toBe("/api/executors/:addr/terminal-states");
    expect(
      suggestWhitelistTemplate(
        "/api/executions/550e8400-e29b-41d4-a716-446655440000/logs",
      ),
    ).toBe("/api/executions/:addr/logs");
    // 字面量路由段不被抽象成参数
    expect(suggestWhitelistTemplate("/api/executors/config")).toBe(
      "/api/executors/config",
    );
  });

  it("带机器面头的非白名单路径 → 告警一次后节流，且**仍**降级为 IP 键", async () => {
    const warn = jest
      .spyOn(
        (guard as unknown as { logger: { warn: (m: string) => void } }).logger,
        "warn",
      )
      .mockImplementation(() => undefined);
    warn.mockClear();

    const req = {
      ip: "203.0.113.9",
      path: "/api/tasks/ghost-machine-surface",
      headers: { "x-executor-address": "exec-a:8002" },
    };

    // 安全不变量优先：即使告警，也绝不认头分桶（否则重新打开 P1-1 绕过面）。
    expect(await callTracker(req)).toBe("203.0.113.9");
    // 节流：同一（模板, 地址）连续 20 次只告警一条。
    for (let i = 0; i < 20; i++) {
      expect(await callTracker(req)).toBe("203.0.113.9");
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(
      "/api/tasks/ghost-machine-surface",
    );
    expect(String(warn.mock.calls[0][0])).toContain(
      "EXECUTOR_MACHINE_PATH_PATTERNS",
    );
    warn.mockRestore();
  });

  it("人操作面不带头时不产生任何告警（避免噪声）", async () => {
    const warn = jest
      .spyOn(
        (guard as unknown as { logger: { warn: (m: string) => void } }).logger,
        "warn",
      )
      .mockImplementation(() => undefined);
    warn.mockClear();
    for (const path of ["/api/auth/login", "/api/tasks", "/api/users/1"]) {
      await callTracker({ ip: "198.51.100.7", path, headers: {} });
    }
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
