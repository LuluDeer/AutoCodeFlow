/**
 * FEAT-07: 出站事件订阅的共享常量与纯函数。
 *
 * 只放「无依赖可单测」的逻辑：可订阅事件目录、事件名归一化、订阅匹配判定、
 * 生成 payload 的形状、重试退避计算。派发器与 service 均消费此处常量，
 * 保证 CRUD 校验与派发过滤用同一份目录。
 */
import { randomBytes } from "node:crypto";
import { EVENT_SCHEMA_VERSION } from "../../common/events/domain-events";

/**
 * 可订阅事件目录（稳定契约，只增不改）。
 * - execution.completed / execution.failed：ARCH-21 总线既有发布点（task.service
 *   handleCallback winner 分支）。
 * - executor.offline / deployment.completed：本任务补的发布点（executor.service
 *   三处 OFFLINE 翻转 / app-deployment.service 部署终态落库后，均 fail-open）。
 */
export const SUBSCRIBABLE_EVENTS = [
  "execution.completed",
  "execution.failed",
  "executor.offline",
  "deployment.completed",
] as const;

export type SubscribableEvent = (typeof SUBSCRIBABLE_EVENTS)[number];

export function isSubscribableEvent(name: string): boolean {
  return (SUBSCRIBABLE_EVENTS as readonly string[]).includes(name);
}

/** 订阅上限（防滥用，先例 NotificationSilenceService.MAX_SILENCES）。 */
export const MAX_EVENT_SUBSCRIPTIONS = 200;

/** 出站请求超时（毫秒），与 notification WebhookChannel 的 10s 对齐。 */
export const OUTBOUND_TIMEOUT_MS = 10_000;

// ─── FEAT-19: outbox（跨进程 at-least-once）参数 ────────────────────────────

/** outbox 补投退避基座（毫秒）：第 n 次失败后延迟 base * 2^(n-1)。 */
export const OUTBOX_RETRY_BASE_DELAY_MS = 5_000;
/** outbox 补投退避封顶（毫秒）。 */
export const OUTBOX_RETRY_MAX_DELAY_MS = 5 * 60_000;
/** outbox 补投次数阈值：超过即落 event_outbox_dead_letters（迁移 1790000000013）+ 行终态。 */
export const MAX_OUTBOX_ATTEMPTS = 20;

/**
 * outbox 第 n 次失败后的补投延迟：5s * 2^(n-1)，封顶 5min。
 * attempt=1 → 5s；2 → 10s；3 → 20s；4 → 40s；5 → 80s；… ≥7 封顶 5min。
 * 纯函数（ARCH-31 #8 收口后重试节奏的唯一事实源——快速路径不再有进程内退避）。
 */
export function outboxRetryDelayMs(failedAttempt: number): number {
  const base =
    OUTBOX_RETRY_BASE_DELAY_MS * Math.pow(2, Math.max(0, failedAttempt - 1));
  return Math.min(base, OUTBOX_RETRY_MAX_DELAY_MS);
}

/** 生成订阅 secret（32 字节 hex = 64 字符）。 */
export function generateSubscriptionSecret(): string {
  return randomBytes(32).toString("hex");
}

/** API 读面上 secret 的脱敏占位（永不回显真值）。 */
export const SECRET_MASK = "******";

/**
 * 订阅是否命中事件：订阅 eventTypes 含该事件名即命中。
 * 边界：eventTypes 空（理论上 CRUD 拒绝空数组，防御兜底视为不匹配）。
 */
export function subscriptionMatches(
  eventTypes: string[] | null | undefined,
  eventName: string,
): boolean {
  if (!Array.isArray(eventTypes) || eventTypes.length === 0) return false;
  return eventTypes.includes(eventName);
}

/** 出站 payload 通用信封字段。 */
export interface OutboundEventEnvelope {
  /** 事件名（同 X-AutoCodeFlow-Event 头）。 */
  event: string;
  /** 事件发生时刻（ISO）。 */
  occurredAt: string;
  /**
   * PK-14: 载荷 schema 主版本（见 domain-events.ts EVENT_SCHEMA_VERSION）。
   * 订阅方据此区分载荷形状演进；增量字段新增不升 major，breaking 变更必须 bump。
   * 新增为可选字段——旧订阅方忽略即可，向后兼容。
   */
  schemaVersion?: number;
  /**
   * R183：**事件级幂等键**（同一事件的**所有投递**共用同一个值）。
   *
   * ## 为什么必须加（这不是「锦上添花」，是 at-least-once 的必要配套）
   * 出站是 **at-least-once** 语义（本仓多处注释明写「订阅方仍需幂等」）：
   * 快速路径 + outbox 补投、租约超时重投、部分失败留给扫描重试 ——
   * **同一个事件会被投递多次**。但此前信封里**没有任何可用于去重的稳定字段**：
   * `occurredAt` 是**每次投递重新生成**的（`new Date().toISOString()`）⇒
   * **两次投递的 `occurredAt` 不同** ⇒ 订阅方**无法区分「重复投递」与「新事件」**。
   * 后果是实打实的：计费类订阅按事件条数计费会**翻倍**、执行类订阅会**重复执行**。
   *
   * ## 值从哪来
   * 取 outbox 行的 `eventId`（`${eventType}:${uuid}`，**落库时生成一次**）⇒
   * 同一事件的快速路径与**每一次补投**都携带**同一个** `deliveryId`。
   * ⚠️ outbox 不可用时（极简装配/降级）没有稳定行 id ⇒ 本字段**缺省**
   * （可选字段，旧订阅方忽略即可，向后兼容）。此时订阅方只能靠业务字段去重。
   *
   * ## 订阅方该怎么用
   * 本地按 `deliveryId` 去重（如一张 `seen(deliveryId)` 表），**至少保留一个重投窗口**
   * （建议 ≥ 24h，覆盖 outbox 的最大退避）；重复投递返回 2xx 即可（让投递方收口）。
   */
  deliveryId?: string;
  /** 事件载荷（事件名到形状的映射见 buildEventPayload）。 */
  data: Record<string, unknown>;
}

/**
 * 构造出站载荷。execution.* 来自 ExecutionTerminalEventPayload（ARCH-21
 * 契约原样透传）；executor.offline / deployment.completed 为本任务定义的
 * 形状（字段全为原始类型，与 domain-events.ts 设计约束一致）。
 */
export function buildEventPayload(
  eventName: string,
  raw: Record<string, unknown>,
  occurredAt = new Date().toISOString(),
  deliveryId?: string,
): OutboundEventEnvelope {
  // PK-14: 信封顶层附 schemaVersion（向后兼容——旧订阅方忽略未知字段）。
  // R183: 附 `deliveryId`（事件级幂等键；同一事件的所有投递共用同一个值）。
  //   ⚠️ 只在**拿到稳定 id** 时才写（outbox 不可用的降级路径没有）——
  //   写一个每次新生成的值比不写更糟：订阅方会以为它是幂等键而**永远无法去重**。
  return {
    event: eventName,
    occurredAt,
    schemaVersion: EVENT_SCHEMA_VERSION,
    ...(deliveryId ? { deliveryId } : {}),
    data: raw,
  };
}
