/**
 * TTFV「真实口径」纯模块（零 Nest / 零 TypeORM 依赖）。
 *
 * 来源与同源约定（务必保持逐字一致，改动会触发口径漂移单测）：
 *  - `AUTHORITATIVE_SQL` 逐字复制自 `scripts/ttfv-real-metrics.mjs:61-125`
 *    （含命名占位符 `:as_of`）。脚本是 ESM `.mjs`，后端 CJS 无法 import，
 *    故复刻并由 `__tests__/ttfv-metrics.spec.ts` 的源文本逐字断言防守。
 *  - `computeTtfv` 与脚本 `computeMetrics`（:238-301）逐字等价：R318 的
 *    `task_first_attempted` 激活分子、24h 窗、授权前不追溯、PERCENTILE_CONT 插值。
 *  - `buildTtfvWarnings` 与脚本 `buildWarnings`（:304-308）逐字等价。
 *
 * 三态语义对齐 `agent-telemetry.dto.ts:155-158` 的 `coverage`：
 * gate_off=系统总闸未开 / 授权表无 opt_in=true 行 / 缺表；
 * no_data=双闸已开但无符合口径的样本；ok=有样本。
 */

/** source: scripts/ttfv-real-metrics.mjs:54-56 —— 与脚本常量逐字一致。 */
export const OPTIN_CALIBER_WARNING =
  "⚠️ 真实口径仅覆盖 opt-in install：授权前事件不追溯（i.ts/o.opted_at），样本稀疏不代表全量用户";
export const SMALL_SAMPLE_WARNING = "样本量小，中位数无统计意义";

/** source: scripts/ttfv-real-metrics.mjs:61-125 —— 逐字复制，勿改一个字符。 */
export const AUTHORITATIVE_SQL = `WITH installs AS (
  SELECT i."install_id" AS "install_id", MIN(i."ts") AS "ts"
  FROM telemetry_optin o
  JOIN funnel_events i
    ON i."install_id" = o."install_id" AND i."event_name" = 'install_completed'
  WHERE o."opt_in" = true
    AND i."ts" >= o."opted_at"
  GROUP BY i."install_id"
),
first_success AS (
  SELECT s."install_id" AS "install_id", MIN(s."ts") AS "ts"
  FROM telemetry_optin o
  JOIN funnel_events s
    ON s."install_id" = o."install_id" AND s."event_name" = 'task_first_success'
  JOIN installs i ON i."install_id" = s."install_id"
  WHERE o."opt_in" = true
    AND s."ts" >= o."opted_at"
    AND s."ts" > i."ts"
    AND EXTRACT(EPOCH FROM (s."ts" - i."ts")) <= 86400
  GROUP BY s."install_id"
),
first_attempt AS (
  -- R318：首次触发执行（成功+失败+killed 三终态、排除 synthetic），供 24h 激活率分子。
  SELECT s."install_id" AS "install_id", MIN(s."ts") AS "ts"
  FROM telemetry_optin o
  JOIN funnel_events s
    ON s."install_id" = o."install_id" AND s."event_name" = 'task_first_attempted'
  JOIN installs i ON i."install_id" = s."install_id"
  WHERE o."opt_in" = true
    AND s."ts" >= o."opted_at"
    AND s."ts" > i."ts"
    AND EXTRACT(EPOCH FROM (s."ts" - i."ts")) <= 86400
  GROUP BY s."install_id"
),
ttfv AS (
  SELECT
    PERCENTILE_CONT(0.5) WITHIN GROUP (
      ORDER BY EXTRACT(EPOCH FROM (s."ts" - i."ts")) / 60.0
    ) AS "ttfv_minutes",
    COUNT(*) AS "converted_installs"
  FROM installs i
  JOIN first_success s ON s."install_id" = i."install_id"
),
eligible AS (
  SELECT i."install_id" AS "install_id", i."ts" AS "ts"
  FROM installs i
  WHERE i."ts" <= :as_of - INTERVAL '24 hours'
),
activated AS (
  -- 精确口径（R318）：task_first_attempted = 首次触发执行，覆盖成功与失败
  -- 终态、写入时排除 synthetic；触发即失败者计入激活，近似已消除。
  SELECT COUNT(DISTINCT e."install_id") AS "activated_installs"
  FROM eligible e
  JOIN first_attempt s ON s."install_id" = e."install_id"
  WHERE EXTRACT(EPOCH FROM (s."ts" - e."ts")) <= 86400
)
SELECT
  t."ttfv_minutes" AS "ttfv_minutes",
  t."converted_installs" AS "converted_installs",
  (SELECT COUNT(*) FROM eligible) AS "eligible_installs",
  a."activated_installs" AS "activated_installs",
  a."activated_installs"::numeric / NULLIF((SELECT COUNT(*) FROM eligible), 0) AS "activation_24h",
  (t."converted_installs" + (SELECT COUNT(*) FROM eligible)) AS "sample_size"
FROM ttfv t
CROSS JOIN activated a;`;

/**
 * source: scripts/ttfv-real-metrics.mjs:629 —— 命名占位符换 PG 位置参数，
 * SQL 主体（权威口径 + 增强口径）逐字不变。
 */
export const TTFV_RUNNABLE_SQL = AUTHORITATIVE_SQL.replace(":as_of", "$1")
  .trim()
  .replace(/;$/, "");

/** 三态判定所需的最小库读面；全部在 report() 的同一 queryRunner 内执行。 */
export const TTFV_TABLES_SQL =
  "SELECT to_regclass('funnel_events') AS \"funnel_events\", to_regclass('telemetry_optin') AS \"telemetry_optin\"";
export const TTFV_GATE_SQL =
  'SELECT "value" FROM "system_configs" WHERE "key" = $1';
export const TTFV_INSTALLS_SQL =
  'SELECT "install_id", "opt_in", "opted_at" FROM "telemetry_optin"';
export const TTFV_EVENTS_SQL =
  'SELECT "install_id", "event_name", "ts" FROM "funnel_events" WHERE "event_name" IN (\'install_completed\', \'task_first_success\', \'task_first_attempted\')';

/**
 * source: telemetry-optin.service.ts:13 —— 这里不 import 那个模块（零 Nest 依赖），
 * 字面值与双闸服务保持同源；系统闸缺 key / 非法值一律关。
 */
export const TTFV_SYSTEM_GATE_KEY = "telemetry.ttfv.enabled";

export const TTFV_DATA_STATUS = {
  GATE_OFF: "gate_off",
  NO_DATA: "no_data",
  OK: "ok",
} as const;

export type TtfvDataStatus =
  (typeof TTFV_DATA_STATUS)[keyof typeof TTFV_DATA_STATUS];

/** telemetry_optin 行（PG Date 与 ISO 字符串均可，见 computeTtfv 的 ms()）。 */
export type TtfvInstallRow = {
  install_id: string;
  opt_in: boolean | string;
  opted_at: string | Date;
};

/** funnel_events 行。 */
export type TtfvEventRow = {
  install_id: string;
  event_name: string;
  ts: string | Date;
};

/** source: scripts/ttfv-real-metrics.mjs:293-300 —— 与 computeMetrics 返回值逐字同形。 */
export type TtfvComputed = {
  ttfv_minutes: number | null;
  converted_installs: number;
  eligible_installs: number;
  activated_installs: number;
  activation_24h: number | null;
  sample_size: number;
};

/** DTO 形状（映射到 AgentNorthStarTtfvDto，禁止 nullable 字段落 0）。 */
export type TtfvPayload = {
  dataStatus: TtfvDataStatus;
  medianMinutes: number | null;
  activation24h: number | null;
  sampleSize: number;
  asOf: string;
  note: string;
};

/** source: scripts/ttfv-real-metrics.mjs:207-209 —— Date 兼容 PG 驱动的 timestamptz 行。 */
const ms = (value: string | Date | null | undefined): number => {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== "string") return NaN;
  return Date.parse(value);
};
const MIN = 60_000;
const DAY = 86_400_000;

/** source: scripts/ttfv-real-metrics.mjs:212-221 —— PERCENTILE_CONT(0.5) 连续中位数。 */
export function percentileCont50(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  if (n === 1) return s[0];
  const pos = (n - 1) * 0.5;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/**
 * source: scripts/ttfv-real-metrics.mjs:238-301 —— 逐字等价复刻（仅加 TS 类型与 Date 兼容）。
 *
 * installs: telemetry_optin 行；events: funnel_events 行；nowIso: 对应 SQL 的 :as_of。
 * 严格 opt-in：只取 opt_in === true；三类事件均须 >= opted_at（授权前不追溯）。
 * R318：激活分子读 task_first_attempted（成功 + 失败 + killed，排除 synthetic），
 * 不再用 task_first_success 代理；TTFV 中位数仍以 task_first_success 为转化口径。
 */
export function computeTtfv(
  installs: TtfvInstallRow[],
  events: TtfvEventRow[],
  nowIso: string,
): TtfvComputed {
  const asOf = ms(nowIso);
  if (!Number.isFinite(asOf)) throw new Error(`nowIso 非法：${nowIso}`);

  const optedAt = new Map<string, number>();
  for (const row of installs) {
    const granted =
      row?.opt_in === true || row?.opt_in === ("t" as unknown as boolean);
    if (!granted) continue;
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
    if (!Number.isFinite(t) || t < granted) continue; // 授权前事件不追溯
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
    minutes.push((t - (installAt.get(id) ?? 0)) / MIN);
  const convertedInstalls = minutes.length;

  const cutoff = asOf - DAY;
  let eligibleInstalls = 0;
  let activatedInstalls = 0;
  for (const [id, installed] of installAt) {
    if (installed > cutoff) continue; // reaches24h
    eligibleInstalls += 1;
    const attempt = attemptAt.get(id);
    if (attempt != null && attempt - installed <= DAY) activatedInstalls += 1;
  }

  return {
    ttfv_minutes: percentileCont50(minutes),
    converted_installs: convertedInstalls,
    eligible_installs: eligibleInstalls,
    activated_installs: activatedInstalls,
    activation_24h:
      eligibleInstalls === 0 ? null : activatedInstalls / eligibleInstalls,
    sample_size: convertedInstalls + eligibleInstalls,
  };
}

/** source: scripts/ttfv-real-metrics.mjs:304-308 —— 口径警告：无近似标注，常驻 opt-in + 小样本。 */
export function buildTtfvWarnings(sampleSize: number): string[] {
  const warnings = [OPTIN_CALIBER_WARNING];
  if (sampleSize < 5) warnings.push(SMALL_SAMPLE_WARNING);
  return warnings;
}

/**
 * 三态判定：双闸任一未开 ⇒ gate_off；双闸开但无可算样本 ⇒ no_data；否则 ok。
 * 纯函数入参注入，便于不连库覆盖 gate_off / no_data。
 */
export function resolveTtfvDataStatus(input: {
  systemEnabled: boolean;
  hasOptedInRow: boolean;
  sampleSize: number;
}): TtfvDataStatus {
  if (!input.systemEnabled || !input.hasOptedInRow)
    return TTFV_DATA_STATUS.GATE_OFF;
  return input.sampleSize > 0 ? TTFV_DATA_STATUS.OK : TTFV_DATA_STATUS.NO_DATA;
}

/** 把纯函数结果映射为 DTO 载荷；gate_off/no_data 的中位数与激活率一律为 null，绝不 0。 */
export function buildTtfvPayload(
  status: TtfvDataStatus,
  metrics: TtfvComputed,
  asOf: string,
): TtfvPayload {
  if (status === TTFV_DATA_STATUS.OK) {
    return {
      dataStatus: status,
      medianMinutes: metrics.ttfv_minutes,
      activation24h: metrics.activation_24h,
      sampleSize: metrics.sample_size,
      asOf,
      note: buildTtfvWarnings(metrics.sample_size).join("；"),
    };
  }
  return {
    dataStatus: status,
    medianMinutes: null,
    activation24h: null,
    sampleSize: metrics.sample_size,
    asOf,
    note:
      status === TTFV_DATA_STATUS.GATE_OFF
        ? `未启用：telemetry 总闸未开或 telemetry_optin 无 opt_in=true 授权行（或表不存在）；${OPTIN_CALIBER_WARNING}`
        : `有授权但无符合口径的样本（sample_size=0）；${OPTIN_CALIBER_WARNING}；${SMALL_SAMPLE_WARNING}`,
  };
}
