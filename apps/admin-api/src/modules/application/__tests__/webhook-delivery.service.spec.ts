import { Logger } from "@nestjs/common";
import {
  DEFAULT_WEBHOOK_DELIVERY_TTL_DAYS,
  WebhookDeliveryService,
  normalizeDeliveryKey,
  resolveWebhookDeliveryTtlDays,
} from "../webhook-delivery.service";
import { WebhookDeliveryRetentionService } from "../webhook-delivery-retention.service";
import { WEBHOOK_DELIVERY_SCOPE_APP_RELEASE } from "../entities/webhook-delivery.entity";

/**
 * SEC-3：投递幂等账本的行为 spec。
 *
 * 假 repo 把 PG 的
 * `INSERT ... ON CONFLICT ("scope","deliveryKey") DO UPDATE ... WHERE "expiresAt" < now()`
 * 语义**逐条照搬**（冲突且未过期 ⇒ 返回 0 行；冲突且已过期 ⇒ 重占并返回 1 行），
 * 且分支体内没有 await——即「一次查询是原子的」，这正是数据库唯一约束提供的
 * 保证。并发用例（Promise.all 两次 claim）因此能真实复现「两个请求同时到达」，
 * 而不是被测试调度掩盖。
 */

interface Row {
  id: string;
  scope: string;
  deliveryKey: string;
  appId: string | null;
  receivedAt: Date;
  expiresAt: Date;
}

const keyOf = (scope: string, deliveryKey: string): string =>
  `${scope}\u0000${deliveryKey}`;

class FakeLight {
  rows = new Map<string, Row>();
  queryCalls = 0;
  lastParams: unknown[] | null = null;
  /** 下一次 query 抛出的错误（模拟 DB 抖动）。 */
  failNextQuery: Error | null = null;

  async query(_sql: string, params: unknown[]): Promise<unknown[]> {
    this.queryCalls += 1;
    if (this.failNextQuery) {
      const err = this.failNextQuery;
      this.failNextQuery = null;
      throw err;
    }
    this.lastParams = params;
    const [scope, deliveryKey, appId, expiresAt] = params as [
      string,
      string,
      string | null,
      Date,
    ];
    const k = keyOf(scope, deliveryKey);
    const existing = this.rows.get(k);
    const now = Date.now();
    if (existing) {
      // 有效占用 ⇒ ON CONFLICT 的 DO UPDATE 谓词不满足 ⇒ 0 行
      if (existing.expiresAt.getTime() >= now) return [];
      // 已过期 ⇒ 重占
      existing.appId = appId;
      existing.receivedAt = new Date(now);
      existing.expiresAt = expiresAt;
      return [{ id: existing.id, receivedAt: existing.receivedAt }];
    }
    const row: Row = {
      id: `wd-${this.rows.size + 1}`,
      scope,
      deliveryKey,
      appId,
      receivedAt: new Date(now),
      expiresAt,
    };
    this.rows.set(k, row);
    return [{ id: row.id, receivedAt: row.receivedAt }];
  }

  async findOne(options: {
    where: { scope: string; deliveryKey: string };
  }): Promise<Row | null> {
    const { scope, deliveryKey } = options.where;
    return this.rows.get(keyOf(scope, deliveryKey)) ?? null;
  }

  /** retention 用的 DELETE 链（按 expiresAt < now 分批，镜像 SQL 的 LIMIT 语义）。 */
  createQueryBuilder() {
    const rows = this.rows;
    let params: { now?: Date; batchSize?: number } = {};
    const qb = {
      delete: () => qb,
      where: (_sql: string, p: { now?: Date; batchSize?: number }) => {
        params = p;
        return qb;
      },
      execute: async () => {
        const nowMs = (params.now as Date).getTime();
        const victims = [...rows.values()]
          .filter((r) => r.expiresAt.getTime() < nowMs)
          .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())
          .slice(0, params.batchSize);
        for (const v of victims) rows.delete(keyOf(v.scope, v.deliveryKey));
        return { affected: victims.length };
      },
    };
    return qb;
  }
}

const asRepo = (fake: FakeLight) => fake as never;

describe("WebhookDeliveryService.claim（SEC-3 投递幂等）", () => {
  const NOW = 1_800_000_000_000;
  let repo: FakeLight;
  let svc: WebhookDeliveryService;

  beforeEach(() => {
    jest.spyOn(Date, "now").mockReturnValue(NOW);
    delete process.env.WEBHOOK_DELIVERY_TTL_DAYS;
    repo = new FakeLight();
    svc = new WebhookDeliveryService(asRepo(repo));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.WEBHOOK_DELIVERY_TTL_DAYS;
  });

  it("无 key（header 缺席）⇒ claimed:true / reason=no_key，且**不碰数据库**", async () => {
    const claim = await svc.claim({
      scope: WEBHOOK_DELIVERY_SCOPE_APP_RELEASE,
      key: undefined,
      appId: "app-1",
    });

    expect(claim).toEqual({
      claimed: true,
      reason: "no_key",
      receivedAt: null,
    });
    // 回归护栏：不带 header 的旧集成不能被去重逻辑误伤（零查询 = 零新失败面）
    expect(repo.queryCalls).toBe(0);
    expect(repo.rows.size).toBe(0);
  });

  it("空白/纯空格 key 等同于无 key", async () => {
    for (const key of ["", "   ", "\t\n"]) {
      const claim = await svc.claim({ key, appId: "app-1" });
      expect(claim.claimed).toBe(true);
      expect(claim.reason).toBe("no_key");
    }
    expect(repo.queryCalls).toBe(0);
  });

  it("首次投递 ⇒ claimed:true，落一行账本（key 已 trim，expiresAt = now + 7d）", async () => {
    const claim = await svc.claim({ key: "  deliver-1  ", appId: "app-1" });

    expect(claim.claimed).toBe(true);
    expect(claim.reason).toBe("first");
    expect(claim.receivedAt).toEqual(new Date(NOW));

    const row = repo.rows.get(
      keyOf(WEBHOOK_DELIVERY_SCOPE_APP_RELEASE, "deliver-1"),
    );
    expect(row).toBeDefined();
    expect(row?.deliveryKey).toBe("deliver-1");
    expect(row?.appId).toBe("app-1");
    expect(row?.expiresAt.getTime()).toBe(
      NOW + DEFAULT_WEBHOOK_DELIVERY_TTL_DAYS * 86_400_000,
    );
  });

  it("同一 deliveryKey 连续两次 ⇒ 第二次 claimed:false，并带回首次接收时间", async () => {
    const first = await svc.claim({ key: "deliver-1", appId: "app-1" });
    expect(first.claimed).toBe(true);

    // 时间推进 1 小时后重试（同一 delivery id）
    jest.spyOn(Date, "now").mockReturnValue(NOW + 3_600_000);
    const second = await svc.claim({ key: "deliver-1", appId: "app-1" });

    expect(second.claimed).toBe(false);
    expect(second.reason).toBe("duplicate");
    // 「首次接收时间」必须是第一次的时刻，不是这次
    expect(second.receivedAt).toEqual(new Date(NOW));
    expect(repo.rows.size).toBe(1);
  });

  it("不同 key ⇒ 两次都 claimed", async () => {
    const a = await svc.claim({ key: "deliver-a", appId: "app-1" });
    const b = await svc.claim({ key: "deliver-b", appId: "app-1" });

    expect(a.claimed).toBe(true);
    expect(b.claimed).toBe(true);
    expect(repo.rows.size).toBe(2);
  });

  it("并发（Promise.all 两次 claim）⇒ 恰有一次 claimed（唯一约束仲裁）", async () => {
    const [a, b] = await Promise.all([
      svc.claim({ key: "deliver-race", appId: "app-1" }),
      svc.claim({ key: "deliver-race", appId: "app-1" }),
    ]);

    expect([a.claimed, b.claimed].filter(Boolean)).toHaveLength(1);
    expect([a.reason, b.reason].sort()).toEqual(["duplicate", "first"]);
    expect(repo.rows.size).toBe(1);
  });

  it("过期后（expiresAt 早于 now）同键可再次 claim，并刷新接收时间", async () => {
    await svc.claim({ key: "deliver-1", appId: "app-1" });
    const row = repo.rows.get(
      keyOf(WEBHOOK_DELIVERY_SCOPE_APP_RELEASE, "deliver-1"),
    );
    expect(row?.expiresAt.getTime()).toBe(
      NOW + DEFAULT_WEBHOOK_DELIVERY_TTL_DAYS * 86_400_000,
    );

    // 越过保留期（无需等 retention 清理：claim 自身认可过期行可重占）
    const later = NOW + (DEFAULT_WEBHOOK_DELIVERY_TTL_DAYS + 1) * 86_400_000;
    jest.spyOn(Date, "now").mockReturnValue(later);
    const again = await svc.claim({ key: "deliver-1", appId: "app-1" });

    expect(again.claimed).toBe(true);
    expect(again.reason).toBe("first");
    expect(again.receivedAt).toEqual(new Date(later));
    expect(repo.rows.size).toBe(1);
  });

  it("保留期可由 WEBHOOK_DELIVERY_TTL_DAYS 配置（默认 7 天，非法值回落默认）", async () => {
    process.env.WEBHOOK_DELIVERY_TTL_DAYS = "2";
    expect(resolveWebhookDeliveryTtlDays()).toBe(2);
    await svc.claim({ key: "deliver-ttl", appId: "app-1" });
    expect(
      repo.rows
        .get(keyOf(WEBHOOK_DELIVERY_SCOPE_APP_RELEASE, "deliver-ttl"))
        ?.expiresAt.getTime(),
    ).toBe(NOW + 2 * 86_400_000);

    for (const bad of ["", "0", "-3", "abc", "NaN"]) {
      process.env.WEBHOOK_DELIVERY_TTL_DAYS = bad;
      expect(resolveWebhookDeliveryTtlDays()).toBe(
        DEFAULT_WEBHOOK_DELIVERY_TTL_DAYS,
      );
    }
  });

  it("账本不可用（非 23505）⇒ 异常外抛，由 controller fail-open 决定", async () => {
    repo.failNextQuery = new Error("connection terminated");
    await expect(svc.claim({ key: "deliver-1" })).rejects.toThrow(
      "connection terminated",
    );
  });

  it("23505（并发兜底路径）⇒ 按重复投递处理", async () => {
    const conflict = Object.assign(new Error("duplicate key"), {
      code: "23505",
    });
    repo.failNextQuery = conflict;
    const claim = await svc.claim({ key: "deliver-1" });
    expect(claim.claimed).toBe(false);
    expect(claim.reason).toBe("duplicate");
  });
});

describe("normalizeDeliveryKey（SEC-3 键归一）", () => {
  it("trim 空白；空串/非字符串 ⇒ null（按无 key 处理）", () => {
    expect(normalizeDeliveryKey(" abc ")).toBe("abc");
    expect(normalizeDeliveryKey("ABC")).toBe("ABC");
    expect(normalizeDeliveryKey("   ")).toBe(null);
    expect(normalizeDeliveryKey("")).toBe(null);
    expect(normalizeDeliveryKey(undefined)).toBe(null);
    expect(normalizeDeliveryKey(null)).toBe(null);
  });
});

describe("WebhookDeliveryRetentionService（SEC-3 保留期清理）", () => {
  const NOW = 1_800_000_000_000;
  let repo: FakeLight;
  let svc: WebhookDeliveryRetentionService;

  const seed = (deliveryKey: string, expiresAt: number): void => {
    repo.rows.set(keyOf(WEBHOOK_DELIVERY_SCOPE_APP_RELEASE, deliveryKey), {
      id: `wd-${deliveryKey}`,
      scope: WEBHOOK_DELIVERY_SCOPE_APP_RELEASE,
      deliveryKey,
      appId: "app-1",
      receivedAt: new Date(NOW - 10 * 86_400_000),
      expiresAt: new Date(expiresAt),
    });
  };

  beforeEach(() => {
    jest.spyOn(Date, "now").mockReturnValue(NOW);
    repo = new FakeLight();
    svc = new WebhookDeliveryRetentionService(asRepo(repo), null);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("只删 expiresAt < now 的行，未过期行原样保留", async () => {
    seed("expired-1", NOW - 1_000);
    seed("expired-2", NOW - 86_400_000);
    seed("live", NOW + 86_400_000);

    const deleted = await svc.cleanupExpired(new Date(NOW));

    expect(deleted).toBe(2);
    expect(repo.rows.size).toBe(1);
    expect(
      repo.rows.get(keyOf(WEBHOOK_DELIVERY_SCOPE_APP_RELEASE, "live")),
    ).toBeDefined();
  });

  it("多批循环删完（1001 行 > 批大小 1000）", async () => {
    for (let i = 0; i < 1001; i += 1) seed(`expired-${i}`, NOW - 1_000 - i);

    const deleted = await svc.cleanupExpired(new Date(NOW));

    expect(deleted).toBe(1001);
    expect(repo.rows.size).toBe(0);
  });

  it("cron：非 leader 实例不执行清理（ARCH-31 §5）", async () => {
    seed("expired-1", NOW - 1_000);
    const gated = new WebhookDeliveryRetentionService(asRepo(repo), {
      isLeader: false,
    } as never);

    await gated.handleDailyCleanup();

    expect(repo.rows.size).toBe(1);
  });

  it("cron：清理失败只 warn，不抛错（不让未处理 rejection 打穿进程）", async () => {
    const broken = new WebhookDeliveryRetentionService(
      {
        createQueryBuilder: () => {
          throw new Error("db down");
        },
      } as never,
      { isLeader: true } as never,
    );
    const warn = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);

    await expect(broken.handleDailyCleanup()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("下一轮重试"));
  });
});
