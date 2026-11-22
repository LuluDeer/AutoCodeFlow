import { BadRequestException } from "@nestjs/common";
import { AppError } from "../../../../common/errors/app-error";
import { ErrorCode } from "../../../../common/errors/error-codes";
import {
  BUSINESS_CONFIRMED_SQL,
  BUSINESS_RESULTS_PROXY_SQL,
  NorthStarMetricsService,
  PROXY_CALIBER_WARNING,
  STRICT_CALIBER_WARNING,
  UTC_PIN_SQL,
} from "../north-star-metrics.service";

/**
 * R327 · NorthStarMetricsService 内存替身单测。
 *
 * 这里只验证 service 的分支逻辑（SQL 调用次序/参数、周聚合、totals、warnings、
 * as_of 校验、空数据），**不连真库**——真库口径一致性由 R326 的
 * `north-star-pg-reconcile.mjs` 对账负责。QueryRunner 替身记录每次 query 的
 * (sql, params)，据此断言两条口径分查询且 UTC_PIN 在同事务内先于二者执行。
 */

type QueryCall = { sql: string; params?: unknown[] };

type StrictRow = {
  week_start: Date | string;
  active_installs: number;
  confirmed_events: number;
};
type ProxyRow = { week_start: Date | string; executions: number };

function harness(
  strictRows: StrictRow[] = [],
  proxyRows: ProxyRow[] = [],
  opts: { queryError?: Error } = {},
) {
  const events: string[] = [];
  const calls: QueryCall[] = [];

  const runner = {
    connect: jest.fn(async () => {
      events.push("connect");
    }),
    startTransaction: jest.fn(async () => {
      events.push("start");
    }),
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (opts.queryError) throw opts.queryError;
      if (sql === UTC_PIN_SQL) return [];
      if (sql === BUSINESS_CONFIRMED_SQL) return strictRows;
      if (sql === BUSINESS_RESULTS_PROXY_SQL) return proxyRows;
      throw new Error(`unexpected SQL: ${sql}`);
    }),
    commitTransaction: jest.fn(async () => {
      events.push("commit");
    }),
    rollbackTransaction: jest.fn(async () => {
      events.push("rollback");
    }),
    release: jest.fn(async () => {
      events.push("release");
    }),
  };

  const dataSource = {
    createQueryRunner: jest.fn(() => runner),
  };

  return {
    service: new NorthStarMetricsService(dataSource as never),
    runner,
    dataSource,
    events,
    calls,
  };
}

const W1 = "2026-11-16T00:00:00.000Z"; // UTC 周一
const W2 = "2026-11-23T00:00:00.000Z"; // 下周一
const AS_OF = "2026-11-24T12:00:00.000Z";

describe("NorthStarMetricsService · report", () => {
  it("严格值与代理值分两条 SQL 查询，UTC_PIN 在同事务内先于二者执行", async () => {
    const h = harness();
    await h.service.report(AS_OF);

    expect(h.calls.map((c) => c.sql)).toEqual([
      UTC_PIN_SQL,
      BUSINESS_CONFIRMED_SQL,
      BUSINESS_RESULTS_PROXY_SQL,
    ]);
    // 两条口径的 as_of 参数逐字相同，且是 ISO 归一化后的值。
    expect(h.calls[1].params).toEqual([AS_OF]);
    expect(h.calls[2].params).toEqual([AS_OF]);
    expect(h.events).toEqual(["connect", "start", "commit", "release"]);
  });

  it("week_start 归一化为 UTC 周一 ISO；聚合行与 totals 正确", async () => {
    const h = harness(
      [
        { week_start: new Date(W1), active_installs: 3, confirmed_events: 5 },
        { week_start: W2, active_installs: 2, confirmed_events: 4 },
      ],
      [
        { week_start: W1, executions: 9 },
        { week_start: W2, executions: 7 },
      ],
    );
    const out = await h.service.report(AS_OF);

    expect(out.as_of).toBe(AS_OF);
    expect(out.business_confirmed.weeks).toEqual([
      { week_start: W1, active_installs: 3, confirmed_events: 5 },
      { week_start: W2, active_installs: 2, confirmed_events: 4 },
    ]);
    expect(out.business_confirmed.totals).toEqual({
      active_install_weeks: 5,
      confirmed_events: 9,
    });
    expect(out.business_results_proxy.weeks).toEqual([
      { week_start: W1, executions: 9 },
      { week_start: W2, executions: 7 },
    ]);
    expect(out.business_results_proxy.totals).toEqual({ executions: 16 });
  });

  it("按 week_start 排序（SQL ORDER BY 之外再兜一道），支持字符串周桶", async () => {
    const h = harness(
      [
        { week_start: W2, active_installs: 1, confirmed_events: 1 },
        { week_start: W1, active_installs: 1, confirmed_events: 1 },
      ],
      [],
    );
    const out = await h.service.report(AS_OF);
    expect(out.business_confirmed.weeks.map((w) => w.week_start)).toEqual([
      W1,
      W2,
    ]);
  });

  it("warnings 两条逐字复用脚本护栏，顺序固定且不可省略", async () => {
    const h = harness();
    const out = await h.service.report(AS_OF);
    expect(out.warnings).toEqual([
      STRICT_CALIBER_WARNING,
      PROXY_CALIBER_WARNING,
    ]);
    expect(out.warnings[1]).toBe(
      "⚠️ 有产物/有证据 ≠ 被业务确认，代理值勿当严格值",
    );
  });

  it("空数据 → weeks=[]、totals 全 0、warnings 仍在（不报错）", async () => {
    const h = harness();
    const out = await h.service.report(AS_OF);
    expect(out.business_confirmed.weeks).toEqual([]);
    expect(out.business_confirmed.totals).toEqual({
      active_install_weeks: 0,
      confirmed_events: 0,
    });
    expect(out.business_results_proxy.weeks).toEqual([]);
    expect(out.business_results_proxy.totals).toEqual({ executions: 0 });
    expect(out.warnings).toHaveLength(2);
  });

  it("缺省 as_of 取 now（合法 ISO），并透传给两条查询", async () => {
    const h = harness();
    const before = Date.now();
    const out = await h.service.report();
    const after = Date.now();
    const ms = Date.parse(out.as_of);
    expect(ms).toBeGreaterThanOrEqual(before - 1000);
    expect(ms).toBeLessThanOrEqual(after + 1000);
    expect(h.calls[1].params).toEqual([out.as_of]);
    expect(h.calls[2].params).toEqual([out.as_of]);
  });

  it("非法 as_of 抛 400 VALIDATION_FAILED，且完全不碰数据库", async () => {
    const h = harness();
    await expect(h.service.report("not-a-date")).rejects.toMatchObject({
      errorCode: ErrorCode.VALIDATION_FAILED,
    });
    expect(h.dataSource.createQueryRunner).not.toHaveBeenCalled();
  });

  it("查询失败时 rollback + release，异常原样上抛", async () => {
    const boom = new Error("db down");
    const h = harness([], [], { queryError: boom });
    await expect(h.service.report(AS_OF)).rejects.toBe(boom);
    expect(h.events).toEqual(["connect", "start", "rollback", "release"]);
  });

  it("AppError 类型守卫：非法 as_of 是 BadRequestException 原型（400）", async () => {
    const h = harness();
    let caught: unknown;
    try {
      await h.service.report("garbage");
    } catch (err) {
      caught = err;
    }
    // AppError 按状态码把原型挂到 Nest 内置异常类（见 app-error.ts），
    // 故 instanceof AppError 为 false，但 getStatus()/errorCode 仍正确。
    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as AppError).getStatus()).toBe(400);
    expect((caught as AppError).errorCode).toBe(ErrorCode.VALIDATION_FAILED);
  });

  // ── R448/R449 升主判据（与脚本 computePromotionEligibility 同口径）──
  const weeksOf = (count: number, installs: number): StrictRow[] =>
    Array.from({ length: count }, (_, i) => ({
      week_start: new Date(Date.parse(W1) + i * 7 * 86400_000).toISOString(),
      active_installs: installs,
      confirmed_events: installs,
    }));

  it("升主达标：4 周 × 5 install = 20 ⇒ eligible=true，reasons 含运营前置提示", async () => {
    const h = harness(weeksOf(4, 5));
    const r = await h.service.report(AS_OF);
    expect(r.promotionEligibility).toMatchObject({
      eligible: true,
      weeks: 4,
      activeInstallWeeks: 20,
      thresholds: { minWeeks: 4, minActiveInstallWeeks: 20 },
    });
    expect(
      r.promotionEligibility.reasons.some((s) => s.includes("脚本不验证")),
    ).toBe(true);
  });

  it("升主不达标（样本期）：3 周 × 5 install ⇒ eligible=false + 周不足说明", async () => {
    const h = harness(weeksOf(3, 5));
    const r = await h.service.report(AS_OF);
    expect(r.promotionEligibility.eligible).toBe(false);
    expect(
      r.promotionEligibility.reasons.some((s) =>
        s.includes("样本期 3 周 < 4 周"),
      ),
    ).toBe(true);
  });

  it("升主不达标（sample_size）：4 周 × 4 install = 16 ⇒ eligible=false + install 不足说明", async () => {
    const h = harness(weeksOf(4, 4));
    const r = await h.service.report(AS_OF);
    expect(r.promotionEligibility.eligible).toBe(false);
    expect(
      r.promotionEligibility.reasons.some((s) =>
        s.includes("活跃 install 周合计 16 < 20"),
      ),
    ).toBe(true);
  });
});
