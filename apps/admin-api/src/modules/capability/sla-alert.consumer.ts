/**
 * N22 SLA 告警消费层：把 assessSlaDeadlines 的纯判定产物转成受策略约束的告警。
 *
 * 契约（与 ZCode hooks / dsh approval 的实证一致）：
 *   - 中台 managed 告警目标是唯一可信来源；consumer 只从 policy.managedChannels 取目标，
 *     不读项目侧 enabled / 删除字段——项目 enabled:false 或尝试删 managed channel
 *     都关不掉中台告警（一个来源关不掉另一个来源）。
 *   - projectReceivers 只做追加，绝不覆盖 / 删减 managed 目标。
 *   - 判定与发送分离：breachedIds / summary 逐字复用 sla-assessment，本层不重算业务钟。
 *   - 告警通道本身是受策略约束的 capability：无可用 managed channel = fail-closed，
 *     不发、不留“成功”假象，必须写失败审计 + 日志。
 *   - 出站载荷不落 webhook URL / 密钥明文：复用 notification 面的唯一脱敏实现，
 *     并补一条 notification-config 读面的 URL secret query 掩码。
 */

import { sanitizeNotificationText } from "../notification/sanitize-notification-text.util";

/** 审计 action 字面量（需主控同步 audit 文档清单）。 */
export const SLA_BREACH_AUDIT_ACTION = "capability.sla_breach";

/** 告警资源字面量（审计 resource / message.resource 同源）。 */
export const SLA_BREACH_RESOURCE = "capability_sla";

export interface SlaAlertPolicy {
  /** 中台固定目标（URL/密钥由中台持有），项目/个人不可删改。 */
  readonly managedChannels: readonly string[];
  /** 项目/个人追加接收人，只在 managed 之外追加。 */
  readonly projectReceivers?: readonly string[];
}

export interface SlaAlertPayload {
  title: string;
  content: string;
  level: "error";
  vars: Record<string, string>;
}

export interface SlaAlertMessage {
  action: typeof SLA_BREACH_AUDIT_ACTION;
  resource: typeof SLA_BREACH_RESOURCE;
  resourceId: string;
  /** 逐字复用 assessment.summary.breachedIds。 */
  breachedIds: readonly string[];
  /** 只含中台 managed 固定目标。 */
  channels: readonly string[];
  /** 只含项目/个人追加接收人（已脱敏）。 */
  receivers: readonly string[];
  payload: SlaAlertPayload;
}

export interface AlertSink {
  send(message: SlaAlertMessage): unknown | Promise<unknown>;
}

export interface SlaAlertAuditEntry {
  action: typeof SLA_BREACH_AUDIT_ACTION;
  resource: typeof SLA_BREACH_RESOURCE;
  resourceId?: string;
  detail: Record<string, unknown>;
  result: "success" | "failure";
}

/** 结构兼容 AuditService.log；不 import Nest/TypeORM，便于纯内存替身测试。 */
export interface SlaAlertAuditSink {
  log(entry: SlaAlertAuditEntry): unknown | Promise<unknown>;
}

/** 结构兼容 @nestjs/common Logger#warn。 */
export interface SlaAlertLogger {
  warn(message: string): void;
}

export interface SlaAlertDeps {
  audit?: SlaAlertAuditSink | null;
  logger?: SlaAlertLogger | null;
}

export type SlaAlertConsumptionStatus =
  "sent" | "skipped" | "fail_closed" | "delivery_failed";

export interface SlaAlertConsumptionResult {
  status: SlaAlertConsumptionStatus;
  breachedIds: readonly string[];
  channels: readonly string[];
  receivers: readonly string[];
  reason?: string;
}

interface AssessmentLike {
  readonly id: string;
  readonly breached: boolean;
}

interface CollectionLike extends ReadonlyArray<AssessmentLike> {
  readonly summary?: {
    readonly breachedIds?: readonly string[];
    readonly breachedCount?: number;
  };
}

/**
 * notification-config.service.ts 读面的 URL secret query 掩码（同一规则集）。
 * sanitizeSecrets 只覆盖凭据词表赋值，URL 里单独的 `key=...` 由这条补上。
 */
const URL_SECRET_QUERY_RE =
  /([?&][^=&#]*(?:pass|secret|token|key|sign)[^=&#]*=)[^&#]+/gi;

function redactTarget(value: string): string {
  return sanitizeNotificationText(value).replace(URL_SECRET_QUERY_RE, "$1***");
}

/** trim + 原始值去重后才脱敏，避免两个不同密钥掩码后合并成一个目标。 */
function normalizeTargets(values: readonly string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(redactTarget(trimmed));
  }
  return out;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function buildMessage(
  breachedIds: readonly string[],
  channels: readonly string[],
  receivers: readonly string[],
): SlaAlertMessage {
  const count = String(breachedIds.length);
  const payload: SlaAlertPayload = {
    title: "SLA 违约告警",
    content: `检测到 ${count} 条 SLA 违约记录，请查看 capability.sla_breach 审计。`,
    level: "error",
    vars: {
      breachedIds: breachedIds.join(","),
      breachedCount: count,
      channels: channels.join(","),
      receivers: receivers.join(","),
    },
  };
  return {
    action: "capability.sla_breach",
    resource: SLA_BREACH_RESOURCE,
    resourceId: breachedIds[0] ?? "",
    breachedIds,
    channels,
    receivers,
    payload,
  };
}

/**
 * 消费一批 SLA 判定，发送受策略约束的告警。
 *
 * @param collection assessSlaDeadlines(records, nowMs) 的产物（纯判定，逐字复用）
 * @param sink 注入式发送口；生产接 NotificationService 适配器，单测接假 sink，不真发包
 * @param policy 中台 managed 固定目标 + 项目追加接收人
 * @param deps 审计 / 日志出口；缺省时只返回结果对象
 */
export async function consumeSlaAssessment(
  collection: CollectionLike,
  sink: AlertSink,
  policy: SlaAlertPolicy,
  deps: SlaAlertDeps = {},
): Promise<SlaAlertConsumptionResult> {
  const fromItems = Array.isArray(collection)
    ? collection
        .filter((item) => item && item.breached === true)
        .map((item) => item.id)
    : [];
  const summaryIds = Array.isArray(collection?.summary?.breachedIds)
    ? collection.summary.breachedIds.filter(
        (id): id is string => typeof id === "string",
      )
    : [];

  // 无违约 = 无需告警：不发包，也不制造审计噪声。
  if (fromItems.length === 0 && summaryIds.length === 0) {
    return { status: "skipped", breachedIds: [], channels: [], receivers: [] };
  }

  const channels = normalizeTargets(policy?.managedChannels);
  const receivers = normalizeTargets(policy?.projectReceivers);
  const ids = fromItems;
  const baseResult = { breachedIds: ids, channels, receivers };

  const failClosed = async (
    reason: string,
    detailExtra: Record<string, unknown> = {},
  ): Promise<SlaAlertConsumptionResult> => {
    const detail = {
      ...detailExtra,
      breachedIds: ids,
      breachedCount: ids.length,
      channels,
      receivers,
    };
    try {
      await deps.audit?.log({
        // 字面量：audit guard 只认 action: "<域>.<动作>"（常量引用会失明）
        action: "capability.sla_breach",
        resource: SLA_BREACH_RESOURCE,
        resourceId: ids[0],
        result: "failure",
        detail: { ...detail, reason },
      });
    } catch (err: unknown) {
      deps.logger?.warn(
        `[sla-alert] audit write failed while failing closed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    deps.logger?.warn(`[sla-alert] fail-closed (${reason}) — no alert sent`);
    return { ...baseResult, status: "fail_closed", reason };
  };

  // 项目侧任何“禁用 / 删除 managed channel”的输入都不进入这里：
  // 只有中台喂入的 managedChannels 能决定能否发送。空即 fail-closed。
  if (channels.length === 0) {
    return failClosed("no_managed_channel");
  }

  // 判定产物自身不一致时不猜：summary 只用来核对，不重算时钟。
  if (summaryIds.length === 0 || !sameIds(summaryIds, ids)) {
    return failClosed("assessment_summary_mismatch", {
      summaryBreachedIds: summaryIds,
    });
  }

  const message = buildMessage(ids, channels, receivers);
  try {
    await sink.send(message);
  } catch (err: unknown) {
    const reason = "delivery_failed";
    try {
      await deps.audit?.log({
        // 字面量：audit guard 只认 action: "<域>.<动作>"（常量引用会失明）
        action: "capability.sla_breach",
        resource: SLA_BREACH_RESOURCE,
        resourceId: ids[0],
        result: "failure",
        detail: {
          breachedIds: ids,
          breachedCount: ids.length,
          channels,
          receivers,
          reason,
          error: sanitizeNotificationText(
            err instanceof Error ? err.message : String(err),
          ),
        },
      });
    } catch (auditErr: unknown) {
      deps.logger?.warn(
        `[sla-alert] audit write failed after ${reason}: ${
          auditErr instanceof Error ? auditErr.message : String(auditErr)
        }`,
      );
    }
    deps.logger?.warn(
      `[sla-alert] ${reason} — see capability.sla_breach audit`,
    );
    return { ...baseResult, status: "delivery_failed", reason };
  }

  try {
    await deps.audit?.log({
      action: "capability.sla_breach",
      resource: SLA_BREACH_RESOURCE,
      resourceId: ids[0],
      result: "success",
      detail: {
        breachedIds: ids,
        breachedCount: ids.length,
        breachedCountFromSummary: collection.summary?.breachedCount,
        channels,
        receivers,
      },
    });
  } catch (err: unknown) {
    deps.logger?.warn(
      `[sla-alert] audit write failed after send: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return { ...baseResult, status: "sent" };
}

/**
 * 主控集成入口：注册为 provider 后调用 `consume(collection, sink, policy)`。
 * 构造签名：`new SlaAlertConsumer(audit?, logger?)`；两者均可选，
 * 生产传 AuditService（结构兼容 SlaAlertAuditSink）与 Nest Logger。
 */
export class SlaAlertConsumer {
  constructor(
    private readonly audit?: SlaAlertAuditSink | null,
    private readonly logger?: SlaAlertLogger | null,
  ) {}

  consume(
    collection: CollectionLike,
    sink: AlertSink,
    policy: SlaAlertPolicy,
  ): Promise<SlaAlertConsumptionResult> {
    return consumeSlaAssessment(collection, sink, policy, {
      audit: this.audit,
      logger: this.logger,
    });
  }
}
