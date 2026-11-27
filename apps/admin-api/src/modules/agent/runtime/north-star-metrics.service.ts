import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource, QueryRunner } from "typeorm";

import { AppError } from "../../../common/errors/app-error";
import { ErrorCode } from "../../../common/errors/error-codes";
import type { AgentNorthStarResponseDto } from "../dto/agent-north-star.dto";
import {
  buildTtfvPayload,
  computeTtfv,
  resolveTtfvDataStatus,
  TTFV_DATA_STATUS,
  TTFV_EVENTS_SQL,
  TTFV_GATE_SQL,
  TTFV_INSTALLS_SQL,
  TTFV_RUNNABLE_SQL,
  TTFV_SYSTEM_GATE_KEY,
  TTFV_TABLES_SQL,
  type TtfvComputed,
  type TtfvEventRow,
  type TtfvInstallRow,
  type TtfvPayload,
} from "./ttfv-metrics";

/**
 * TTFV 未启用/读失败时的中性载荷：三态为 gate_off，两个 nullable 指标为 null。
 * 绝不把「没数据」伪装成「真零」。
 */
const EMPTY_TTFV_COMPUTED: TtfvComputed = {
  ttfv_minutes: null,
  converted_installs: 0,
  eligible_installs: 0,
  activated_installs: 0,
  activation_24h: null,
  sample_size: 0,
};

/**
 * R327（北极星 §6 步骤 5 的后端一半）：双口径看板的数据源。
 *
 * ## 与侧车脚本的关系（真库对账由 R326 另一切片负责）
 * SQL **语义等价**于 `scripts/north-star-weekly.mjs` 的
 * `BUSINESS_CONFIRMED_SQL` / `BUSINESS_RESULTS_PROXY_SQL` / `UTC_PIN_SQL`，
 * 但不 import 字符串（脚本是 ESM `.mjs`，本后端 CJS 无法 require）。
 * 字段名、warnings 顺序与 `buildPayload()` 逐字对齐；两边输出由
 * `north-star-pg-reconcile.mjs` 真库对账保证一致。
 *
 * ## 两条口径绝不混算（R324 §8 PM 裁决）
 * 严格值读 `funnel_events`（已落库的 business_confirmed 事件，漏斗表无
 * synthetic 列）；代理值读 `task_executions`（SUCCESS + 有产物 + 非合成），
 * 两条独立查询、独立周桶、独立 totals。代理值**仅作参考**，warnings 里
 * 的强警告不可省略——这是「不混用」裁决的产品护栏。
 *
 * ## 时区方案（queryRunner 同一事务，R324 教训）
 * `DataSource.query()` 每次从池里取不同 session，`SET LOCAL` 不会跨查询存活，
 * 故用 `createQueryRunner()` 在**同一连接 / 同一事务**内先 `SET LOCAL TIME ZONE
 * 'UTC'`，再跑两条 SQL：
 *   · 严格值 `ts` 是 timestamptz —— `date_trunc('week', ts)` 由 session TZ 决定
 *     周界；事务钉 UTC 后稳定落在 UTC 周一。**严禁**对 timestamptz 加
 *     `AT TIME ZONE 'UTC'`（那会把它转成 naive，反引入本地 TZ 依赖，R324 已踩）。
 *   · 代理值 `endTime` 是 timestamp WITHOUT time zone —— 方向相反，靠 SQL 主体
 *     的 `AT TIME ZONE 'UTC'` 把 naive 显式解释为 UTC timestamptz 后再 date_trunc，
 *     与 strict 的 UTC 周界对齐；它不依赖 session TZ。
 * 事务结束 `commit` / 异常 `rollback` / 无论成败 `release` 归还连接。
 */

/** 与脚本 `BUSINESS_CONFIRMED_SQL` 同口径（占位符改为 PG 的 $1）。 */
export const BUSINESS_CONFIRMED_SQL = `SELECT
  date_trunc('week', ts) AS week_start,
  COUNT(DISTINCT install_id) AS active_installs,
  COUNT(DISTINCT dedupe_key) AS confirmed_events
FROM funnel_events
WHERE event_name = 'business_confirmed'
  AND dedupe_key LIKE 'confirmed:%'
  AND ts <= $1
GROUP BY 1
ORDER BY 1`;

/** 与脚本 `BUSINESS_RESULTS_PROXY_SQL` 同口径（占位符改为 PG 的 $1）。 */
export const BUSINESS_RESULTS_PROXY_SQL = `SELECT
  date_trunc('week', e."endTime" AT TIME ZONE 'UTC') AS week_start,
  COUNT(*) AS executions
FROM task_executions e
WHERE e."status" = 'success'
  AND e."synthetic" = false
  AND CASE
        WHEN jsonb_typeof(e."artifacts") = 'array'
        THEN jsonb_array_length(e."artifacts") > 0
        ELSE false
      END
  AND e."endTime" IS NOT NULL
  AND e."endTime" <= $1
GROUP BY 1
ORDER BY 1`;

/** 与脚本 `UTC_PIN_SQL` 逐字一致。 */
export const UTC_PIN_SQL = "SET LOCAL TIME ZONE 'UTC'";

/** 与脚本 `STRICT_CALIBER_WARNING` / `PROXY_CALIBER_WARNING` 逐字一致。 */
export const STRICT_CALIBER_WARNING =
  "严格口径：business_confirmed = 每次执行被显式确认一次；写入端已收口双闸，查询端只统计已落库事件（漏斗表无 synthetic 列）";
export const PROXY_CALIBER_WARNING =
  "⚠️ 有产物/有证据 ≠ 被业务确认，代理值勿当严格值";

type StrictRow = {
  week_start: Date | string;
  active_installs: number | string;
  confirmed_events: number | string;
};

type ProxyRow = {
  week_start: Date | string;
  executions: number | string;
};

/**
 * R448/R449 升主判据：阈值与判据逻辑与 `scripts/north-star-weekly.mjs` 的
 * `PROMOTION_THRESHOLDS` / `computePromotionEligibility` 逐字同口径（脚本是 ESM
 * .mjs，本后端 CJS 无法 import，故复刻并由真库对账保证一致）。
 * 两数值阈值 AND；opt-in 覆盖率无全量分母、脚本不判，仅作运营前置提示。
 */
export const PROMOTION_THRESHOLDS = { minWeeks: 4, minActiveInstallWeeks: 20 };
const PROMOTION_OPS_PREREQ =
  "运营前置（脚本不验证）：telemetry/status 的 coverage 须为 full 且 count>0";

/**
 * R448 升主判据原因类别码（结构化标记）。
 *
 * 前端着色 / 本地化必须按 `code` 判定，不再在人话文案里匹配英文子串（UX-F1：
 * 旧实现靠 `reason.includes('coverage')` 高亮，后端改措辞即静默降级）。
 * 码值是稳定契约，人话 `text` 可随措辞调整；新增类别码时在此枚举追加。
 */
export const NORTH_STAR_PROMOTION_REASON_CODES = {
  /** 样本期周数不足阈值。 */
  SAMPLE_WEEKS_SHORT: "SAMPLE_WEEKS_SHORT",
  /** 活跃 install 周合计不足阈值。 */
  ACTIVE_INSTALL_WEEKS_SHORT: "ACTIVE_INSTALL_WEEKS_SHORT",
  /** 运营前置：telemetry 授权覆盖需 full 且 count>0（脚本不验证）。 */
  OPS_PREREQ_COVERAGE: "OPS_PREREQ_COVERAGE",
} as const;

export type NorthStarPromotionReasonCode =
  (typeof NORTH_STAR_PROMOTION_REASON_CODES)[keyof typeof NORTH_STAR_PROMOTION_REASON_CODES];

/** 单条升主原因：类别码 + 人话文本并存（向后兼容：旧消费方继续读 `reasons`）。 */
export interface NorthStarPromotionReason {
  code: NorthStarPromotionReasonCode;
  text: string;
}

export function computePromotionEligibility(
  strictWeeks: { active_installs: number }[],
) {
  const weeks = strictWeeks.length;
  const activeInstallWeeks = strictWeeks.reduce(
    (a, w) => a + w.active_installs,
    0,
  );
  const { minWeeks, minActiveInstallWeeks } = PROMOTION_THRESHOLDS;
  const reasonDetails: NorthStarPromotionReason[] = [];
  if (weeks < minWeeks) {
    reasonDetails.push({
      code: NORTH_STAR_PROMOTION_REASON_CODES.SAMPLE_WEEKS_SHORT,
      text: `样本期 ${weeks} 周 < ${minWeeks} 周`,
    });
  }
  if (activeInstallWeeks < minActiveInstallWeeks) {
    reasonDetails.push({
      code: NORTH_STAR_PROMOTION_REASON_CODES.ACTIVE_INSTALL_WEEKS_SHORT,
      text: `活跃 install 周合计 ${activeInstallWeeks} < ${minActiveInstallWeeks}`,
    });
  }
  reasonDetails.push({
    code: NORTH_STAR_PROMOTION_REASON_CODES.OPS_PREREQ_COVERAGE,
    text: PROMOTION_OPS_PREREQ,
  });
  // 向后兼容：`reasons` 仍是人话字符串数组，既有消费方（侧车对账、旧前端）不受影响。
  const reasons = reasonDetails.map((r) => r.text);
  return {
    eligible: weeks >= minWeeks && activeInstallWeeks >= minActiveInstallWeeks,
    reasons,
    reasonDetails,
    weeks,
    activeInstallWeeks,
    thresholds: { ...PROMOTION_THRESHOLDS },
  };
}

@Injectable()
export class NorthStarMetricsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * 生成双口径周报。`asOf` 为 ISO-8601 字符串，缺省取 now；非法值抛 400，
   * 绝不把坏参数透给 SQL（NaN 的 Date 会让整条查询语法错）。
   */
  async report(asOf?: string): Promise<AgentNorthStarResponseDto> {
    const resolved = this.resolveAsOf(asOf);
    const resolvedIso = new Date(Date.parse(resolved)).toISOString();

    const qr = this.dataSource.createQueryRunner();
    let strictRows: StrictRow[] = [];
    let proxyRows: ProxyRow[] = [];
    let ttfvPayload: TtfvPayload = buildTtfvPayload(
      TTFV_DATA_STATUS.GATE_OFF,
      EMPTY_TTFV_COMPUTED,
      resolvedIso,
    );
    try {
      await qr.connect();
      await qr.startTransaction();
      // SET LOCAL 只在本事务 / 本连接存活；两条查询必须走同一个 queryRunner。
      await qr.query(UTC_PIN_SQL);
      strictRows = (await qr.query(BUSINESS_CONFIRMED_SQL, [
        resolved,
      ])) as StrictRow[];
      proxyRows = (await qr.query(BUSINESS_RESULTS_PROXY_SQL, [
        resolved,
      ])) as ProxyRow[];
      // TTFV 与双口径周报共用同一连接 / 同一事务，且必须在 UTC_PIN 之后。
      // 走 queryRunner 绑定的 EntityManager（EntityManager.query 内部把
      // this.queryRunner 传给 dataSource.query），因此不会另开连接。
      try {
        ttfvPayload = await this.readTtfv(qr, resolvedIso);
      } catch {
        // fail-soft：缺表 / 读失败 / 总闸抖动一律降级 gate_off，不带崩整份报告。
      }
      await qr.commitTransaction();
    } catch (err) {
      // 只读查询失败也要 rollback（事务已开），绝不把半截连接留在事务里。
      await qr.rollbackTransaction().catch(() => undefined);
      throw err;
    } finally {
      await qr.release();
    }

    const strictWeeks = (strictRows ?? []).map((row) => ({
      week_start: this.isoWeek(row.week_start),
      active_installs: Number(row.active_installs ?? 0),
      confirmed_events: Number(row.confirmed_events ?? 0),
    }));
    const proxyWeeks = (proxyRows ?? []).map((row) => ({
      week_start: this.isoWeek(row.week_start),
      executions: Number(row.executions ?? 0),
    }));

    const byWeek = (
      a: { week_start: string },
      b: { week_start: string },
    ): number => a.week_start.localeCompare(b.week_start);
    const sum = <T extends Record<string, unknown>>(
      rows: T[],
      key: keyof T,
    ): number => rows.reduce((acc, r) => acc + Number(r[key] ?? 0), 0);

    const sw = [...strictWeeks].sort(byWeek);
    const pw = [...proxyWeeks].sort(byWeek);

    return {
      as_of: resolvedIso,
      business_confirmed: {
        weeks: sw,
        totals: {
          active_install_weeks: sum(sw, "active_installs"),
          confirmed_events: sum(sw, "confirmed_events"),
        },
      },
      business_results_proxy: {
        weeks: pw,
        totals: { executions: sum(pw, "executions") },
      },
      promotionEligibility: computePromotionEligibility(sw),
      warnings: [STRICT_CALIBER_WARNING, PROXY_CALIBER_WARNING],
      ttfv: ttfvPayload,
    };
  }

  /**
   * TTFV 只读块：系统总闸 → 表存在 → 实例授权行 → 原始行喂纯函数 → 权威 SQL 口径哨。
   * 任一步失败由 report() 的 fail-soft 包裹收敛为 gate_off；本方法不碰事务控制。
   */
  private async readTtfv(qr: QueryRunner, asOf: string): Promise<TtfvPayload> {
    const manager = qr.manager;
    const gateOff = () =>
      buildTtfvPayload(TTFV_DATA_STATUS.GATE_OFF, EMPTY_TTFV_COMPUTED, asOf);
    // 测试替身可能不带 manager（例如只关心双口径周报的老 harness）⇒ 视为未启用。
    if (!manager || typeof manager.query !== "function") return gateOff();

    const tables = (await manager.query(TTFV_TABLES_SQL)) as Array<{
      funnel_events?: unknown;
      telemetry_optin?: unknown;
    }>;
    if (!tables?.[0]?.funnel_events || !tables?.[0]?.telemetry_optin) {
      return gateOff();
    }

    const gateRows = (await manager.query(TTFV_GATE_SQL, [
      TTFV_SYSTEM_GATE_KEY,
    ])) as Array<{ value?: unknown }>;
    const gateValue = gateRows?.[0]?.value;
    const systemEnabled =
      gateValue === "true" || gateValue === "1" || gateValue === true;
    if (!systemEnabled) return gateOff();

    const installs = ((await manager.query(TTFV_INSTALLS_SQL)) ??
      []) as TtfvInstallRow[];
    const hasOptedInRow = installs.some(
      (r) => r?.opt_in === true || (r?.opt_in as unknown) === "t",
    );
    if (!hasOptedInRow) return gateOff();

    const events = ((await manager.query(TTFV_EVENTS_SQL)) ??
      []) as TtfvEventRow[];
    // 口径同源：installs/events 行喂给与脚本 computeMetrics 逐字等价的纯函数。
    const metrics = computeTtfv(installs, events, asOf);

    // 权威 SQL 口径哨：与侧车脚本同一条 SQL、同一事务执行；读失败不崩报告。
    let driftNote = "";
    try {
      const sqlRows = (await manager.query(TTFV_RUNNABLE_SQL, [
        asOf,
      ])) as Array<{
        sample_size?: unknown;
      }>;
      const canonical = Number(sqlRows?.[0]?.sample_size ?? 0);
      if (Number.isFinite(canonical) && canonical !== metrics.sample_size) {
        driftNote = `；⚠️ 口径哨不一致：权威 SQL sample_size=${canonical} / 纯函数 sample_size=${metrics.sample_size}`;
      }
    } catch {
      // fail-soft：权威 SQL 不可用时仍以纯函数结果为准。
    }

    const payload = buildTtfvPayload(
      resolveTtfvDataStatus({
        systemEnabled: true,
        hasOptedInRow: true,
        sampleSize: metrics.sample_size,
      }),
      metrics,
      asOf,
    );
    if (driftNote) payload.note += driftNote;
    return payload;
  }

  /** ISO 合法性校验：缺省 now，非法抛 VALIDATION_FAILED（400）。 */
  private resolveAsOf(raw?: string): string {
    if (raw === undefined || raw === null || raw === "") {
      return new Date().toISOString();
    }
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        detail: `as_of 不是合法 ISO-8601 时间：${raw}`,
      });
    }
    return parsed.toISOString();
  }

  /** 与脚本 `isoWeek` 同口径：非法 week_start 视为结构错误（fail loud）。 */
  private isoWeek(value: Date | string): string {
    const t = value instanceof Date ? value.getTime() : Date.parse(value);
    if (!Number.isFinite(t)) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, {
        detail: `SQL 返回非法 week_start：${String(value)}`,
      });
    }
    return new Date(t).toISOString();
  }
}
