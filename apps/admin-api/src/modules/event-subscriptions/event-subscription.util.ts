/**
 * FEAT-07: 出站事件订阅的共享常量与纯函数。
 *
 * 只放「无依赖可单测」的逻辑：可订阅事件目录、事件名归一化、订阅匹配判定、
 * 生成 payload 的形状、重试退避计算。派发器与 service 均消费此处常量，
 * 保证 CRUD 校验与派发过滤用同一份目录。
 */
import { randomBytes } from "node:crypto";

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

/** 重试参数：最多 3 次尝试（首次 + 2 重试），指数退避基座 1s。 */
export const MAX_DELIVERY_ATTEMPTS = 3;
export const RETRY_BASE_DELAY_MS = 1_000;

/**
 * 第 n 次失败后的重试延迟：base * 2^(n-1)，封顶 30s。
 * attempt=1（首次失败后）→ 1s；attempt=2 → 2s；attempt>=3 → 4s（封顶内）。
 * 纯函数（随机源注入可选留扩展；本轮确定性退避即可测）。
 */
export function retryDelayMs(failedAttempt: number): number {
  const base =
    RETRY_BASE_DELAY_MS * Math.pow(2, Math.max(0, failedAttempt - 1));
  return Math.min(base, 30_000);
}

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
 * 纯函数，与进程内 retryDelayMs 分立（outbox 是跨进程慢路径，节奏放宽）。
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
): OutboundEventEnvelope {
  return { event: eventName, occurredAt, data: raw };
}
