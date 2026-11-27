/**
 * TTFV 真实口径上屏 · 后端第 2 级验收（纯函数 + 契约 / 内存替身）。
 *
 * 边界声明：本套件不连真 PG、不启 Nest HTTP，只验证
 *   · SQL 与 scripts/ttfv-real-metrics.mjs:61 AUTHORITATIVE_SQL 逐字同源；
 *   · computeTtfv 与脚本 computeMetrics 等价（授权前事件排除 / 24h 窗口 /
 *     task_first_attempted 激活分子 / PERCENTILE_CONT 插值）；
 *   · 三态判定与 DTO 映射：gate_off / no_data 的 medianMinutes 必须是 null 而非 0；
 *   · service.report() 顶层确实下发 ttfv 六字段（无 manager 时 fail-soft 成 gate_off）。
 * 真库口径一致性不在本级证明范围内。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  AUTHORITATIVE_SQL,
  TTFV_RUNNABLE_SQL,
  TTFV_DATA_STATUS,
  TTFV_SYSTEM_GATE_KEY,
  computeTtfv,
  percentileCont50,
  resolveTtfvDataStatus,
  buildTtfvPayload,
  type TtfvComputed,
  type TtfvInstallRow,
  type TtfvEventRow,
} from "../ttfv-metrics";

import {
  NorthStarMetricsService,
  UTC_PIN_SQL,
  BUSINESS_CONFIRMED_SQL,
  BUSINESS_RESULTS_PROXY_SQL,
} from "../north-star-metrics.service";

/* ── 独立事实源：直接读脚本文本抽 SQL（不经 ts-jest 的 .mjs 解析）───────── */
// jest 可从仓库根或 apps/admin-api 启动，两种 CWD 都要能定位权威脚本。
const SCRIPT_CANDIDATES = [
  resolve(__dirname, "../../../../../../../scripts/ttfv-real-metrics.mjs"),
  resolve(process.cwd(), "scripts/ttfv-real-metrics.mjs"),
];
const SCRIPT_PATH = SCRIPT_CANDIDATES.find((p) => {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
});
if (!SCRIPT_PATH) {
  throw new Error(
    `判据瞎了：找不到权威脚本，候选=${SCRIPT_CANDIDATES.join(" | ")}`,
  );
}
const scriptSrc = readFileSync(SCRIPT_PATH, "utf8");
const scriptSqlMatch = scriptSrc.match(
  /export const AUTHORITATIVE_SQL = `([\s\S]*?)`;/,
);
if (!scriptSqlMatch) {
  throw new Error(
    "判据瞎了：无法从 scripts/ttfv-real-metrics.mjs 抽取 AUTHORITATIVE_SQL",
  );
}
const SCRIPT_SQL = scriptSqlMatch[1];

/* ── 独立 oracle：scripts/ttfv-real-metrics.mjs:207-301 的逐字复刻 ───────── */
const ms = (iso: string | Date) =>
  Date.parse(iso instanceof Date ? iso.toISOString() : iso);
const MIN = 60_000;
const DAY = 86_400_000;

function refPercentileCont50(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  if (n === 1) return s[0];
  const pos = (n - 1) * 0.5;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function refComputeMetrics(
  installs: TtfvInstallRow[],
  events: TtfvEventRow[],
  nowIso: string,
): TtfvComputed {
  const asOf = ms(nowIso);
  const optedAt = new Map<string, number>();
  for (const row of installs) {
    if (row?.opt_in !== true) continue;
    const t = ms(row.opted_at);
    if (!Number.isFinite(t)) continue;
    const prev = optedAt.get(row.install_id);
    if (prev == null || t < prev) optedAt.set(row.install_id, t);
  }
  const installAt = new Map<string, number>();
  const successAt = new Map<string, number>();
  const attemptAt = new Map<string, number>();
  for (const e of events) {
    const granted = optedAt.get(e?.install_id);
    if (granted == null) continue;
    const t = ms(e?.ts);
    if (!Number.isFinite(t) || t < granted) continue;
    if (e.event_name === "install_completed") {
      const prev = installAt.get(e.install_id);
      if (prev == null || t < prev) installAt.set(e.install_id, t);
    }
  }
  for (const e of events) {
    const granted = optedAt.get(e?.install_id);
    const installed = installAt.get(e?.install_id);
    if (granted == null || installed == null) continue;
    const isSuccess = e.event_name === "task_first_success";
    const isAttempt = e.event_name === "task_first_attempted";
    if (!isSuccess && !isAttempt) continue;
    const t = ms(e.ts);
    if (!Number.isFinite(t) || t < granted) continue;
    if (t <= installed || t - installed > DAY) continue;
    const target = isSuccess ? successAt : attemptAt;
    const prev = target.get(e.install_id);
    if (prev == null || t < prev) target.set(e.install_id, t);
  }
  const minutes: number[] = [];
  for (const [id, t] of successAt)
    minutes.push((t - (installAt.get(id) as number)) / MIN);
  const convertedInstalls = minutes.length;
  const cutoff = asOf - DAY;
  let eligibleInstalls = 0;
  let activatedInstalls = 0;
  for (const [id, installed] of installAt) {
    if (installed > cutoff) continue;
    eligibleInstalls += 1;
    const attempt = attemptAt.get(id);
    if (attempt != null && attempt - installed <= DAY) activatedInstalls += 1;
  }
  return {
    ttfv_minutes: refPercentileCont50(minutes),
    converted_installs: convertedInstalls,
    eligible_installs: eligibleInstalls,
    activated_installs: activatedInstalls,
    activation_24h:
      eligibleInstalls === 0 ? null : activatedInstalls / eligibleInstalls,
    sample_size: convertedInstalls + eligibleInstalls,
  };
}

const T0 = Date.parse("2026-11-01T00:00:00.000Z");
const AS_OF = new Date(T0 + 2 * DAY).toISOString();
const iso = (t: number) => new Date(t).toISOString();
const inst = (
  id: string,
  optIn = true,
  optedAtMs = T0 - MIN,
): TtfvInstallRow => ({
  install_id: id,
  opt_in: optIn,
  opted_at: iso(optedAtMs),
});
const ev = (
  id: string,
  event_name: string,
  offsetMs: number,
): TtfvEventRow => ({
  install_id: id,
  event_name,
  ts: iso(T0 + offsetMs),
});

const zeroMetrics = (): TtfvComputed => ({
  ttfv_minutes: null,
  converted_installs: 0,
  eligible_installs: 0,
  activated_installs: 0,
  activation_24h: null,
  sample_size: 0,
});

/* ── service 内存替身（仅证明 DTO 顶层带 ttfv，不证明真库口径）────────────── */
function serviceHarness() {
  const runner = {
    connect: jest.fn(async () => undefined),
    startTransaction: jest.fn(async () => undefined),
    query: jest.fn(async (sql: string) => {
      if (sql === UTC_PIN_SQL) return [];
      if (sql === BUSINESS_CONFIRMED_SQL) return [];
      if (sql === BUSINESS_RESULTS_PROXY_SQL) return [];
      return [];
    }),
    commitTransaction: jest.fn(async () => undefined),
    rollbackTransaction: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
    // TTFV 走 qr.manager.query；空结果 ⇒ fail-soft 成 gate_off。
    manager: { query: jest.fn(async () => []) },
  };
  const dataSource = { createQueryRunner: jest.fn(() => runner) };
  return { service: new NorthStarMetricsService(dataSource as never), runner };
}

describe("TTFV 后端契约 · 口径同源（第 2 级）", () => {
  it("1. 纯函数模块 AUTHORITATIVE_SQL 与权威脚本逐字一致（改一个字符即红）", () => {
    expect(AUTHORITATIVE_SQL).toBe(SCRIPT_SQL);
    // 反证：单字符漂移必须被上式捕获——证明这不是永真断言。
    const oneCharOff = SCRIPT_SQL.replace("PERCENTILE_CONT", "PERCENTILE_CONU");
    expect(oneCharOff).not.toBe(AUTHORITATIVE_SQL);
  });

  it("2. TTFV_RUNNABLE_SQL 只换 :as_of 占位符，SQL 主体逐字不动", () => {
    const expected = SCRIPT_SQL.replace(":as_of", "$1")
      .trim()
      .replace(/;$/, "");
    expect(TTFV_RUNNABLE_SQL).toBe(expected);
    expect(TTFV_RUNNABLE_SQL).not.toContain(":as_of");
    expect(TTFV_RUNNABLE_SQL).toContain("$1");
  });

  it("3. 口径关键 token 独立哨针（脚本自身漂移也拦）", () => {
    for (const token of [
      "telemetry_optin",
      "funnel_events",
      'o."opt_in" = true',
      'i."ts" >= o."opted_at"',
      "PERCENTILE_CONT(0.5)",
      'EXTRACT(EPOCH FROM (s."ts" - i."ts")) / 60.0',
      "task_first_success",
      "task_first_attempted",
      "86400",
      ":as_of",
    ]) {
      expect(AUTHORITATIVE_SQL).toContain(token);
    }
  });

  it("4. 稳定常量：系统开关 key 与三态枚举字面量", () => {
    expect(TTFV_SYSTEM_GATE_KEY).toBe("telemetry.ttfv.enabled");
    expect(TTFV_DATA_STATUS).toEqual({
      GATE_OFF: "gate_off",
      NO_DATA: "no_data",
      OK: "ok",
    });
  });
});

describe("TTFV 后端契约 · 算法等价（第 2 级）", () => {
  it("5. percentileCont50：空数组 null、单值、偶数线性插值", () => {
    expect(percentileCont50([])).toBeNull();
    expect(percentileCont50([7])).toBe(7);
    expect(percentileCont50([5, 10, 15])).toBe(10);
    expect(percentileCont50([5, 15])).toBe(10);
    expect(percentileCont50([5, 10, 15, 20])).toBe(12.5);
  });

  it("6. 中位数 5/10/15 分钟 ⇒ 10；零样本 ⇒ null（绝不 0）", () => {
    const installs = [inst("a"), inst("b"), inst("c")];
    const events = [
      ev("a", "install_completed", 0),
      ev("a", "task_first_success", 5 * MIN),
      ev("b", "install_completed", 0),
      ev("b", "task_first_success", 10 * MIN),
      ev("c", "install_completed", 0),
      ev("c", "task_first_success", 15 * MIN),
    ];
    const r = computeTtfv(installs, events, AS_OF);
    expect(r.ttfv_minutes).toBe(10);
    expect(r.converted_installs).toBe(3);
    expect(r.ttfv_minutes).not.toBe(0);

    const empty = computeTtfv(
      [inst("z")],
      [ev("z", "install_completed", 0)],
      AS_OF,
    );
    expect(empty.ttfv_minutes).toBeNull();
    expect(empty.ttfv_minutes).not.toBe(0);
  });

  it("7. 授权前事件不追溯：install/success 早于 opted_at 一律排除", () => {
    const installs = [inst("a", true, T0 + 10 * MIN)];
    const events = [
      ev("a", "install_completed", 0), // 授权前安装
      ev("a", "task_first_success", 5 * MIN), // 授权前成功
      ev("a", "task_first_success", 20 * MIN), // 授权后成功，但 install 未被识别
    ];
    const r = computeTtfv(installs, events, AS_OF);
    expect(r.converted_installs).toBe(0);
    expect(r.ttfv_minutes).toBeNull();
    expect(r.sample_size).toBe(0);

    // 对照：授权后安装 + 授权后成功才计入。
    const ok = computeTtfv(
      [inst("a", true, T0 - MIN)],
      [ev("a", "install_completed", 0), ev("a", "task_first_success", 8 * MIN)],
      AS_OF,
    );
    expect(ok.converted_installs).toBe(1);
    expect(ok.ttfv_minutes).toBe(8);
  });

  it("8. 24h 激活分子含失败终态（task_first_attempted），超窗与未满 24h 不计", () => {
    // a/b/c 均满 24h；a 触发成功、b 触发失败（attempted）、c 无触发；d 未满 24h。
    const recentInstall = T0 + 2 * DAY - 1 * 60_000;
    const installs = [
      inst("a"),
      inst("b"),
      inst("c"),
      inst("d", true, recentInstall - MIN),
    ];
    const events = [
      ev("a", "install_completed", 0),
      ev("a", "task_first_attempted", 5 * MIN),
      ev("b", "install_completed", 0),
      ev("b", "task_first_attempted", 9 * MIN),
      ev("c", "install_completed", 0),
      ev("d", "install_completed", recentInstall - T0),
      ev("d", "task_first_attempted", recentInstall - T0 + MIN),
    ];
    const r = computeTtfv(installs, events, AS_OF);
    expect(r.eligible_installs).toBe(3);
    expect(r.activated_installs).toBe(2);
    expect(r.activation_24h).toBeCloseTo(2 / 3, 10);

    // 超 24h 的 attempted 不计入激活。
    const late = computeTtfv(
      [inst("x")],
      [
        ev("x", "install_completed", 0),
        ev("x", "task_first_attempted", DAY + MIN),
      ],
      AS_OF,
    );
    expect(late.activated_installs).toBe(0);
  });

  it("9. computeTtfv 与脚本 computeMetrics 在 6 组夹具上逐字段相等", () => {
    const fixtures: Array<{
      name: string;
      installs: TtfvInstallRow[];
      events: TtfvEventRow[];
      now: string;
    }> = [
      { name: "空", installs: [], events: [], now: AS_OF },
      {
        name: "中位数 5/10/15",
        installs: [inst("a"), inst("b"), inst("c")],
        events: [
          ev("a", "install_completed", 0),
          ev("a", "task_first_success", 5 * MIN),
          ev("b", "install_completed", 0),
          ev("b", "task_first_success", 10 * MIN),
          ev("c", "install_completed", 0),
          ev("c", "task_first_success", 15 * MIN),
        ],
        now: AS_OF,
      },
      {
        name: "未 opt-in 与授权前事件",
        installs: [inst("a", false), inst("b", true, T0 + 10 * MIN)],
        events: [
          ev("a", "install_completed", 0),
          ev("a", "task_first_success", 5 * MIN),
          ev("b", "install_completed", 0),
          ev("b", "task_first_success", 20 * MIN),
        ],
        now: AS_OF,
      },
      {
        name: "激活含失败终态",
        installs: [inst("a"), inst("b")],
        events: [
          ev("a", "install_completed", 0),
          ev("a", "task_first_attempted", 5 * MIN),
          ev("b", "install_completed", 0),
          ev("b", "task_first_success", 7 * MIN),
        ],
        now: AS_OF,
      },
      {
        name: "未满 24h 分母",
        installs: [inst("a", true, T0 + 2 * DAY - MIN)],
        events: [ev("a", "install_completed", T0 + 2 * DAY - MIN - T0)],
        now: AS_OF,
      },
      {
        name: "超窗首成功被排除",
        installs: [inst("a")],
        events: [
          ev("a", "install_completed", 0),
          ev("a", "task_first_success", DAY + MIN),
        ],
        now: AS_OF,
      },
    ];
    expect(fixtures.length).toBeGreaterThanOrEqual(6);
    for (const f of fixtures) {
      const actual = computeTtfv(f.installs, f.events, f.now);
      const expected = refComputeMetrics(f.installs, f.events, f.now);
      expect({ name: f.name, ...actual }).toEqual({
        name: f.name,
        ...expected,
      });
    }
  });
});

describe("TTFV 后端契约 · 三态与 DTO 映射（第 2 级）", () => {
  it("10. gate_off：开关关闭或没有授权行，均不因样本量翻成 ok", () => {
    expect(
      resolveTtfvDataStatus({
        systemEnabled: false,
        hasOptedInRow: true,
        sampleSize: 5,
      }),
    ).toBe("gate_off");
    expect(
      resolveTtfvDataStatus({
        systemEnabled: true,
        hasOptedInRow: false,
        sampleSize: 5,
      }),
    ).toBe("gate_off");
  });

  it("11. no_data / ok：授权后零样本为 no_data，有样本为 ok", () => {
    expect(
      resolveTtfvDataStatus({
        systemEnabled: true,
        hasOptedInRow: true,
        sampleSize: 0,
      }),
    ).toBe("no_data");
    expect(
      resolveTtfvDataStatus({
        systemEnabled: true,
        hasOptedInRow: true,
        sampleSize: 1,
      }),
    ).toBe("ok");
  });

  it("12. gate_off / no_data 的 medianMinutes=null 而不是 0，activation24h 同样标缺", () => {
    for (const status of ["gate_off", "no_data"] as const) {
      const p = buildTtfvPayload(status, zeroMetrics(), AS_OF);
      expect(p.dataStatus).toBe(status);
      expect(p.medianMinutes).toBeNull();
      expect(p.medianMinutes).not.toBe(0);
      expect(p.activation24h).toBeNull();
      expect(p.sampleSize).toBe(0);
      expect(p.asOf).toBe(AS_OF);
      expect(typeof p.note).toBe("string");
      expect(p.note.length).toBeGreaterThan(0);
    }
  });

  it("13. ok：DTO 六个字段映射正确（median/activation/sample/asOf/note）", () => {
    const metrics: TtfvComputed = {
      ttfv_minutes: 8.5,
      converted_installs: 3,
      eligible_installs: 4,
      activated_installs: 2,
      activation_24h: 0.5,
      sample_size: 7,
    };
    const p = buildTtfvPayload("ok", metrics, AS_OF);
    expect(p).toMatchObject({
      dataStatus: "ok",
      medianMinutes: 8.5,
      activation24h: 0.5,
      sampleSize: 7,
      asOf: AS_OF,
    });
    expect(typeof p.note).toBe("string");
  });

  it("14. service.report() 顶层下发 ttfv 六字段；无 manager 时 fail-soft gate_off 且 median 非 0", async () => {
    const h = serviceHarness();
    const out = await h.service.report(AS_OF);
    const ttfv = (out as unknown as { ttfv: Record<string, unknown> }).ttfv;
    expect(ttfv).toBeDefined();
    expect(Object.keys(ttfv).sort()).toEqual(
      [
        "activation24h",
        "asOf",
        "dataStatus",
        "medianMinutes",
        "note",
        "sampleSize",
      ].sort(),
    );
    expect(ttfv.dataStatus).toBe("gate_off");
    expect(ttfv.medianMinutes).toBeNull();
    expect(ttfv.medianMinutes).not.toBe(0);
    expect(typeof ttfv.asOf).toBe("string");
    expect(typeof ttfv.note).toBe("string");
    // 既有三路 SQL 调用次序不能被 TTFV 接线破坏。
    expect(h.runner.query.mock.calls.map((c) => c[0])).toEqual([
      UTC_PIN_SQL,
      BUSINESS_CONFIRMED_SQL,
      BUSINESS_RESULTS_PROXY_SQL,
    ]);
  });
});
