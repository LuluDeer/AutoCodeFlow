import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  BUSINESS_CONFIRMED_SQL,
  BUSINESS_RESULTS_PROXY_SQL,
  NorthStarMetricsService,
  UTC_PIN_SQL,
} from "../north-star-metrics.service";
import {
  AUTHORITATIVE_SQL,
  buildTtfvPayload,
  buildTtfvWarnings,
  computeTtfv,
  OPTIN_CALIBER_WARNING,
  percentileCont50,
  resolveTtfvDataStatus,
  SMALL_SAMPLE_WARNING,
  TTFV_DATA_STATUS,
  TTFV_EVENTS_SQL,
  TTFV_GATE_SQL,
  TTFV_INSTALLS_SQL,
  TTFV_RUNNABLE_SQL,
  TTFV_TABLES_SQL,
  type TtfvComputed,
  type TtfvEventRow,
  type TtfvInstallRow,
} from "../ttfv-metrics";

/**
 * TTFV 真实口径纯函数 + 口径同源 + 同事务契约单测。
 *
 * 夹具来自 scripts/ttfv-real-metrics.mjs:326-445 的 FIXTURES（本文件按同语义复刻，
 * 不 import .mjs）：中位数、24h 激活率、R318 触发即算激活、opt-in、授权前不追溯、
 * 超 24h 排除、偶数插值、小样本警告；另含源文本逐字断言与变异反证。
 */

const T0 = Date.parse("2026-11-20T00:00:00Z");
const MIN = 60_000;
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const inst = (
  id: string,
  optIn = true,
  optedAtMs = T0 - MIN,
): TtfvInstallRow => ({
  install_id: id,
  opt_in: optIn,
  opted_at: new Date(optedAtMs).toISOString(),
});
const ev = (id: string, eventName: string, offsetMs: number): TtfvEventRow => ({
  install_id: id,
  event_name: eventName,
  ts: iso(offsetMs),
});

const SCRIPT_REL = resolve(
  __dirname,
  "../../../../../../../scripts/ttfv-real-metrics.mjs",
);
const extractAuthoritativeSql = (source: string): string => {
  const m = source.match(/export const AUTHORITATIVE_SQL = `([\s\S]*?)`;/);
  if (!m) throw new Error("脚本里找不到 AUTHORITATIVE_SQL 模板字面量");
  return m[1];
};

describe("TTFV 口径同源（scripts/ttfv-real-metrics.mjs ↔ 后端纯模块）", () => {
  const source = readFileSync(SCRIPT_REL, "utf8");
  const scriptSql = extractAuthoritativeSql(source);

  it("AUTHORITATIVE_SQL 与脚本 :61-125 逐字一致（含 :as_of 与全部注释）", () => {
    expect(AUTHORITATIVE_SQL).toBe(scriptSql);
    expect(AUTHORITATIVE_SQL).toContain(":as_of - INTERVAL '24 hours'");
    expect(TTFV_RUNNABLE_SQL).toContain("$1 - INTERVAL '24 hours'");
    expect(TTFV_RUNNABLE_SQL).not.toContain(":as_of");
  });

  it("变异反证：改脚本 SQL 一个字符 ⇒ 逐字断言必须转红", () => {
    const mutatedSource = source.replace(
      "PERCENTILE_CONT(0.5)",
      "PERCENTILE_CONT(0.6)",
    );
    expect(mutatedSource).not.toBe(source);
    expect(extractAuthoritativeSql(mutatedSource)).not.toBe(AUTHORITATIVE_SQL);
    // 再反转一次，证明比较器本身没坏。
    expect(
      extractAuthoritativeSql(
        mutatedSource.replace("PERCENTILE_CONT(0.6)", "PERCENTILE_CONT(0.5)"),
      ),
    ).toBe(AUTHORITATIVE_SQL);
  });
});

describe("computeTtfv（与脚本 computeMetrics 逐字等价）", () => {
  it("零样本 → 中位数/激活率均为 null，sample_size=0（绝不伪造 0 指标）", () => {
    const r = computeTtfv([], [], iso(60 * MIN));
    expect(r).toEqual({
      ttfv_minutes: null,
      converted_installs: 0,
      eligible_installs: 0,
      activated_installs: 0,
      activation_24h: null,
      sample_size: 0,
    });
  });

  it("单样本中位数 = 该样本分钟数", () => {
    const r = computeTtfv(
      [inst("a")],
      [
        ev("a", "install_completed", 0),
        ev("a", "task_first_attempted", 5 * MIN),
        ev("a", "task_first_success", 5 * MIN),
      ],
      iso(60 * MIN),
    );
    expect(r.ttfv_minutes).toBe(5);
    expect(r.sample_size).toBe(1);
    expect(r.activation_24h).toBeNull(); // 未满 24h，不进分母
  });

  it("三样本中位数 5/10/15 → 10；偶数样本 PERCENTILE_CONT 线性插值", () => {
    const three = computeTtfv(
      [inst("a"), inst("b"), inst("c")],
      [5, 10, 15].flatMap((m, i) => [
        ev("abc"[i], "install_completed", 0),
        ev("abc"[i], "task_first_attempted", m * MIN),
        ev("abc"[i], "task_first_success", m * MIN),
      ]),
      iso(60 * MIN),
    );
    expect(three.ttfv_minutes).toBe(10);
    expect(three.converted_installs).toBe(3);

    expect(percentileCont50([2, 4, 6, 8])).toBe(5);
    expect(percentileCont50([])).toBeNull();
  });

  it("24h 激活率：3 install 中 2 个 24h 内首次触发 → 2/3", () => {
    const r = computeTtfv(
      [inst("a"), inst("b"), inst("c")],
      [
        ev("a", "install_completed", 0),
        ev("a", "task_first_attempted", 10 * MIN),
        ev("a", "task_first_success", 10 * MIN),
        ev("b", "install_completed", 0),
        ev("b", "task_first_attempted", 30 * MIN),
        ev("b", "task_first_success", 30 * MIN),
        ev("c", "install_completed", 0),
      ],
      iso(48 * 60 * MIN),
    );
    expect(r.eligible_installs).toBe(3);
    expect(r.activated_installs).toBe(2);
    expect(r.activation_24h).toBeCloseTo(2 / 3, 12);
    expect(r.ttfv_minutes).toBe(20);
    expect(r.sample_size).toBe(5);
  });

  it("R318：触发后失败（仅 task_first_attempted）也算 24h 激活", () => {
    const r = computeTtfv(
      [inst("failed"), inst("never")],
      [
        ev("failed", "install_completed", 0),
        ev("failed", "task_first_attempted", 12 * MIN),
        ev("never", "install_completed", 0),
      ],
      iso(48 * 60 * MIN),
    );
    expect(r.ttfv_minutes).toBeNull();
    expect(r.activation_24h).toBe(0.5);
  });

  it("opt_in=false 与授权前事件一律排除（不追溯）", () => {
    const off = computeTtfv(
      [inst("off", false), inst("on")],
      [
        ev("off", "install_completed", 0),
        ev("off", "task_first_attempted", MIN),
        ev("off", "task_first_success", MIN),
        ev("on", "install_completed", 0),
        ev("on", "task_first_attempted", 20 * MIN),
        ev("on", "task_first_success", 20 * MIN),
      ],
      iso(60 * MIN),
    );
    expect(off.ttfv_minutes).toBe(20);
    expect(off.converted_installs).toBe(1);

    const early = computeTtfv(
      [inst("early", true, T0 + 30 * MIN), inst("late", true, T0)],
      [
        ev("early", "install_completed", 0),
        ev("early", "task_first_attempted", 10 * MIN),
        ev("early", "task_first_success", 10 * MIN),
        ev("late", "install_completed", 5 * MIN),
        ev("late", "task_first_attempted", 10 * MIN),
        ev("late", "task_first_success", 10 * MIN),
      ],
      iso(60 * MIN),
    );
    expect(early.ttfv_minutes).toBe(5);
    expect(early.converted_installs).toBe(1);
  });

  it("超 24h 的成功/触发不进 TTFV 也不算 24h 激活；未满 24h 不进分母", () => {
    const slow = computeTtfv(
      [inst("slow")],
      [
        ev("slow", "install_completed", 0),
        ev("slow", "task_first_attempted", 25 * 60 * MIN),
        ev("slow", "task_first_success", 25 * 60 * MIN),
      ],
      iso(72 * 60 * MIN),
    );
    expect(slow.ttfv_minutes).toBeNull();
    expect(slow.eligible_installs).toBe(1);
    expect(slow.activation_24h).toBe(0);

    const mixed = computeTtfv(
      [inst("old"), inst("fresh")],
      [
        ev("old", "install_completed", 20 * 60 * MIN),
        ev("old", "task_first_attempted", 20 * 60 * MIN + 10 * MIN),
        ev("old", "task_first_success", 20 * 60 * MIN + 10 * MIN),
        ev("fresh", "install_completed", 47 * 60 * MIN),
        ev("fresh", "task_first_attempted", 47 * 60 * MIN + 5 * MIN),
        ev("fresh", "task_first_success", 47 * 60 * MIN + 5 * MIN),
      ],
      iso(48 * 60 * MIN),
    );
    expect(mixed.eligible_installs).toBe(1);
    expect(mixed.ttfv_minutes).toBe(7.5);
  });

  it("口径警告：仅 opt-in + 小样本，无「近似」标注", () => {
    expect(buildTtfvWarnings(3)).toEqual([
      OPTIN_CALIBER_WARNING,
      SMALL_SAMPLE_WARNING,
    ]);
    expect(buildTtfvWarnings(5)).toEqual([OPTIN_CALIBER_WARNING]);
    expect(buildTtfvWarnings(3).some((w) => /近似|低估/.test(w))).toBe(false);
  });
});

describe("三态判定与 DTO 载荷", () => {
  const metrics: TtfvComputed = {
    ttfv_minutes: 0,
    converted_installs: 1,
    eligible_installs: 0,
    activated_installs: 0,
    activation_24h: null,
    sample_size: 1,
  };

  it("gate_off：总闸关或无授权行；nullable 字段恒 null，绝不落 0", () => {
    for (const input of [
      { systemEnabled: false, hasOptedInRow: true, sampleSize: 5 },
      { systemEnabled: true, hasOptedInRow: false, sampleSize: 5 },
    ]) {
      const status = resolveTtfvDataStatus(input);
      expect(status).toBe(TTFV_DATA_STATUS.GATE_OFF);
      const payload = buildTtfvPayload(status, metrics, iso(60 * MIN));
      expect(payload.medianMinutes).toBeNull();
      expect(payload.activation24h).toBeNull();
      expect(payload.note).toContain("未启用");
    }
  });

  it("no_data：双闸已开但样本为 0；ok：有样本时原值透传", () => {
    expect(
      resolveTtfvDataStatus({
        systemEnabled: true,
        hasOptedInRow: true,
        sampleSize: 0,
      }),
    ).toBe(TTFV_DATA_STATUS.NO_DATA);
    const noData = buildTtfvPayload(
      TTFV_DATA_STATUS.NO_DATA,
      { ...metrics, ttfv_minutes: null, sample_size: 0 },
      iso(60 * MIN),
    );
    expect(noData.medianMinutes).toBeNull();
    expect(noData.note).toContain("无符合口径的样本");

    const ok = buildTtfvPayload(TTFV_DATA_STATUS.OK, metrics, iso(60 * MIN));
    expect(ok.medianMinutes).toBe(0); // 真零必须如实为 0
    expect(ok.sampleSize).toBe(1);
    expect(ok.asOf).toBe(iso(60 * MIN));
    expect(ok.note).toContain(OPTIN_CALIBER_WARNING);
  });
});

/** 带 manager 的 queryRunner 替身：记录 runner.query 与 manager.query 的先后顺序。 */
function harnessWithTtfv(
  opts: { managerError?: Error; canonicalSample?: number } = {},
) {
  const events: string[] = [];
  const runner = {
    manager: {
      query: jest.fn(async (sql: string) => {
        events.push(`manager:${sql}`);
        if (opts.managerError) throw opts.managerError;
        if (sql === TTFV_TABLES_SQL) {
          return [
            {
              funnel_events: "funnel_events",
              telemetry_optin: "telemetry_optin",
            },
          ];
        }
        if (sql === TTFV_GATE_SQL) return [{ value: "true" }];
        if (sql === TTFV_INSTALLS_SQL) return [inst("a")];
        if (sql === TTFV_EVENTS_SQL) {
          return [
            ev("a", "install_completed", 0),
            ev("a", "task_first_attempted", 5 * MIN),
            ev("a", "task_first_success", 5 * MIN),
          ];
        }
        if (sql === TTFV_RUNNABLE_SQL) {
          return [{ sample_size: opts.canonicalSample ?? 1 }];
        }
        throw new Error(`unexpected manager SQL: ${sql}`);
      }),
    },
    connect: jest.fn(async () => {
      events.push("connect");
    }),
    startTransaction: jest.fn(async () => {
      events.push("start");
    }),
    query: jest.fn(async (sql: string) => {
      events.push(`runner:${sql}`);
      if (sql === UTC_PIN_SQL) return [];
      if (sql === BUSINESS_CONFIRMED_SQL) return [];
      if (sql === BUSINESS_RESULTS_PROXY_SQL) return [];
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
  return {
    service: new NorthStarMetricsService({
      createQueryRunner: jest.fn(() => runner),
    } as never),
    events,
    runner,
  };
}

describe("NorthStarMetricsService · TTFV 同事务契约", () => {
  const AS_OF = iso(60 * MIN);

  it("TTFV SQL 在 UTC_PIN 之后、commit 之前，经同一 queryRunner 的 manager 执行", async () => {
    const h = harnessWithTtfv();
    const out = await h.service.report(AS_OF);

    expect(h.events).toEqual([
      "connect",
      "start",
      `runner:${UTC_PIN_SQL}`,
      `runner:${BUSINESS_CONFIRMED_SQL}`,
      `runner:${BUSINESS_RESULTS_PROXY_SQL}`,
      `manager:${TTFV_TABLES_SQL}`,
      `manager:${TTFV_GATE_SQL}`,
      `manager:${TTFV_INSTALLS_SQL}`,
      `manager:${TTFV_EVENTS_SQL}`,
      `manager:${TTFV_RUNNABLE_SQL}`,
      "commit",
      "release",
    ]);
    expect(out.ttfv).toMatchObject({
      dataStatus: "ok",
      medianMinutes: 5,
      activation24h: null,
      sampleSize: 1,
      asOf: AS_OF,
    });
    expect(out.as_of).toBe(AS_OF);
    // 既有四字段逐字不变
    expect(out.warnings).toHaveLength(2);
    expect(out.business_confirmed.weeks).toEqual([]);
    expect(out.business_results_proxy.weeks).toEqual([]);
  });

  it("manager 缺失或读失败 → fail-soft gate_off，事务照常 commit/release", async () => {
    const missing = harnessWithTtfv();
    (missing.runner as { manager?: unknown }).manager = undefined;
    const outMissing = await missing.service.report(AS_OF);
    expect(outMissing.ttfv.dataStatus).toBe("gate_off");
    expect(outMissing.ttfv.medianMinutes).toBeNull();
    expect(missing.events).not.toContain("rollback");
    expect(missing.events[missing.events.length - 2]).toBe("commit");

    const failing = harnessWithTtfv({
      managerError: new Error("relation missing"),
    });
    const outFailing = await failing.service.report(AS_OF);
    expect(outFailing.ttfv.dataStatus).toBe("gate_off");
    expect(failing.events[failing.events.length - 2]).toBe("commit");
    expect(failing.events[failing.events.length - 1]).toBe("release");
  });

  it("权威 SQL 口径哨与纯函数 sample_size 不一致时记入 note，不改 dataStatus", async () => {
    const h = harnessWithTtfv({ canonicalSample: 9 });
    const out = await h.service.report(AS_OF);
    expect(out.ttfv.dataStatus).toBe("ok");
    expect(out.ttfv.note).toContain("口径哨不一致");
    expect(out.ttfv.sampleSize).toBe(1);
  });
});
