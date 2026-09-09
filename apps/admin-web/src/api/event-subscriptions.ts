import { client } from './client';

/**
 * FEAT-15：webhook 事件订阅前端契约（FEAT-07 后端 /event-subscriptions CRUD
 * + 死信列表 + replay）。与后端 modules/event-subscriptions 契约逐字段对齐：
 *  - secret 读面恒脱敏为 '******'；
 *  - 创建时省略 secret → 服务端生成 64 字符 hex，并在**本次响应**
 *    generatedSecret 字段一次性回显（此后任何读端点不可见）；
 *  - 事件目录（稳定契约，只增不改）：execution.completed / execution.failed /
 *    executor.offline / deployment.completed。
 */
export const EVENT_TYPE_OPTIONS = [
  { value: 'execution.completed', label: '执行成功（execution.completed）' },
  { value: 'execution.failed', label: '执行失败（execution.failed）' },
  { value: 'executor.offline', label: '执行器离线（executor.offline）' },
  { value: 'deployment.completed', label: '部署完成（deployment.completed）' },
] as const;

export type EventSubscriptionEventType = (typeof EVENT_TYPE_OPTIONS)[number]['value'];

export interface EventSubscription {
  id: string;
  /** 订阅事件类型（1-10 个，取值=事件目录） */
  eventTypes: string[];
  /** 推送目标 URL（公网 http(s)，服务端 SSRF 深校验） */
  url: string;
  /** 恒为 '******'（读面脱敏；服务端代生成时一次性回显在 generatedSecret） */
  secret: string;
  enabled: boolean;
  /** 连续失败次数（成功派发即清零） */
  consecutiveFailures: number;
  /** 最近一次失败时刻；无失败 null */
  lastFailureAt: string | null;
  /** 最近一次失败摘要（截 512，不含 secret/payload 原文） */
  lastFailureError: string | null;
  /** 属主用户；系统级订阅 null */
  userId: number | null;
  createdAt: string;
  updatedAt: string;
}

/** 创建响应：subscription + 服务端代生成 secret 的一次性回显字段 */
export interface EventSubscriptionCreateResult {
  subscription: EventSubscription;
  generatedSecret?: string;
}

export interface EventSubscriptionDeadLetter {
  id: string;
  subscriptionId: string;
  /** 事件名 */
  eventType: string;
  /** 发送时完整 JSON 载荷（含签名字段原文） */
  payload: Record<string, unknown>;
  /** 末次失败摘要（截 1024） */
  error: string;
  /** 实际尝试次数（首次 + 2 重试） */
  attempts: number;
  createdAt: string;
}

export interface CreateEventSubscriptionDto {
  url: string;
  eventTypes: string[];
  /** ≥16 字符；省略则服务端生成并一次性回显 */
  secret?: string;
}

export interface UpdateEventSubscriptionDto {
  enabled?: boolean;
  url?: string;
  eventTypes?: string[];
  /** ≥16 字符（轮换）；缺省保持不变 */
  secret?: string;
}

export const eventSubscriptionsApi = {
  list: () => client.get<EventSubscription[]>('/event-subscriptions'),
  create: (data: CreateEventSubscriptionDto) =>
    client.post<EventSubscriptionCreateResult>('/event-subscriptions', data),
  update: (id: string, data: UpdateEventSubscriptionDto) =>
    client.patch<EventSubscription>(`/event-subscriptions/${id}`, data),
  remove: (id: string) => client.delete<{ ok: true }>(`/event-subscriptions/${id}`),
  /** 死信分页列表（page 默认 1，limit 默认 20、最大 100） */
  listDeadLetters: (id: string, page = 1, limit = 20) =>
    client.get<{ data: EventSubscriptionDeadLetter[]; total: number }>(
      `/event-subscriptions/${id}/dead-letters`,
      { params: { page, limit } },
    ),
  /**
   * 手动重放：以订阅当前 url/secret 重新签名派发一次（不自动重试）。
   * 成功 { ok: true } 且死信删除；失败 { ok: false, error } 且死信保留。
   */
  replayDeadLetter: (id: string, deadLetterId: string) =>
    client.post<{ ok: boolean; error?: string }>(
      `/event-subscriptions/${id}/dead-letters/${deadLetterId}/replay`,
    ),
};
