/**
 * N22 续：审核流水线的 SLA 判定层（纯函数）。
 *
 * 本层只把调用方喂入的审核记录翻译成 evaluateSla 的输入，复用 sla-meter 的
 * SLA_LIMITS 与 evaluateSla，不重写任何判定逻辑；nowMs 一律由调用方传入，
 * 本层不读宿主时钟。
 *
 * 判定与告警发送分离：本层只回答「哪些违约 / 哪些待办」，产出结果供审计、
 * 看板与告警消费；是否接 notification 渠道由主控裁决，本层不发包。
 */

import {
  SLA_LIMITS,
  evaluateSla,
  type SlaClock,
  type SlaStatus,
  type SlaVerdict,
} from "./sla-meter";

/** 四类 SLA 键直接派生自 SLA_LIMITS，不另抄一份枚举。 */
export type SlaKind = keyof typeof SLA_LIMITS;

/** 记录形态由调用方喂入；startedAt 缺失交给 evaluateSla 判 no_data。 */
export interface SlaReviewRecord {
  id: string;
  kind: SlaKind;
  startedAt: number | null | undefined;
  completedAt?: number | null;
}

/** 判定与告警发送分离的固定标记。 */
export type AlertChannelDecision = "requires_main_control_decision";

/** 单条判定：SlaVerdict 原样透传 + 记录身份 + 告警裁决标记。 */
export interface SlaAssessment {
  id: string;
  kind: SlaKind;
  status: SlaStatus;
  elapsedMs: number;
  limitMs: number;
  remainingMs: number;
  breached: boolean;
  /** 本层只判定、不发包；告警渠道是否接入由主控裁决。 */
  alertChannelDecision: AlertChannelDecision;
}

/** 批次汇总：违约清单可直接喂给审计 / 看板 / 告警消费方。 */
export interface SlaAssessmentSummary {
  total: number;
  breachedCount: number;
  pendingCount: number;
  metCount: number;
  noDataCount: number;
  /** 违约记录 id 列表，供主控裁决是否转告警渠道。 */
  breachedIds: string[];
  alertChannelDecision: AlertChannelDecision;
}

/** 返回体既是 SlaAssessment[]，又挂 summary 汇总。 */
export interface SlaAssessmentCollection extends Array<SlaAssessment> {
  summary: SlaAssessmentSummary;
}

/** capability_review 走业务钟，其余三类走墙钟（对齐 sla-meter 头注）。 */
const clockFor = (kind: SlaKind): SlaClock =>
  kind === "capability_review" ? "business" : "wall";

/**
 * 批量判定审核记录的 SLA 截止时间。
 *
 * @param records 调用方喂入的审核记录；kind 由类型约束为 SLA_LIMITS 四类之一。
 * @param nowMs 观察时刻（epoch ms），由调用方传入；本函数不调用 Date.now。
 * @returns SlaAssessment[] + summary；只产出判定，不触发任何通知发送。
 */
export function assessSlaDeadlines(
  records: readonly SlaReviewRecord[],
  nowMs: number,
): SlaAssessmentCollection {
  const summary: SlaAssessmentSummary = {
    total: records.length,
    breachedCount: 0,
    pendingCount: 0,
    metCount: 0,
    noDataCount: 0,
    breachedIds: [],
    alertChannelDecision: "requires_main_control_decision",
  };

  const assessments = records.map((record): SlaAssessment => {
    const verdict: SlaVerdict = evaluateSla({
      startedAt: record.startedAt,
      completedAt: record.completedAt ?? null,
      limitMs: SLA_LIMITS[record.kind],
      nowMs,
      clock: clockFor(record.kind),
    });

    const breached = verdict.status === "breached";
    if (breached) summary.breachedIds.push(record.id);
    switch (verdict.status) {
      case "breached":
        summary.breachedCount += 1;
        break;
      case "pending":
        summary.pendingCount += 1;
        break;
      case "met":
        summary.metCount += 1;
        break;
      case "no_data":
        summary.noDataCount += 1;
        break;
    }

    return {
      id: record.id,
      kind: record.kind,
      status: verdict.status,
      elapsedMs: verdict.elapsedMs,
      limitMs: verdict.limitMs,
      remainingMs: verdict.remainingMs,
      breached,
      alertChannelDecision: "requires_main_control_decision",
    };
  });

  const collection = assessments as SlaAssessmentCollection;
  collection.summary = summary;
  return collection;
}
