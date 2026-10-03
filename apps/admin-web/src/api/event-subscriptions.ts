import type { components } from '../types/generated/api-types';
import { client } from './client';

/**
 * FEAT-15：webhook 事件订阅前端契约（FEAT-07 后端 /event-subscriptions CRUD
 * + 死信列表 + replay）。与后端 modules/event-subscriptions 契约逐字段对齐：
 *  - secret 读面恒脱敏为 '******'；
 *  - 创建时省略 secret → 服务端生成 64 字符 hex，并在**本次响应**
 *    generatedSecret 字段一次性回显（此后任何读端点不可见）；
 *  - 事件目录（稳定契约，只增不改）：execution.completed / execution.failed /
 *    executor.offline / deployment.completed。
 *
 * B-3（契约空壳修复）：响应类型此前手写——后端 openapi 对实体只 emit 空壳
 * schema，生成类型 Record<string, never> 不可用，手写与后端的漂移无检测。
 * 响应 DTO（EventSubscriptionResponseDto 等）落地后直接取生成类型；字段名
 * 逐一相同、无需映射。生成类型与手写版的唯一差异：lastFailureAt/lastFailureError/
 * userId 为可选（`?:` + null）——后端 nullable 列的真实形态，消费方读法不变。
 */
export type EventSubscription =
  components['schemas']['EventSubscriptionResponseDto'];

/** 创建响应：subscription（已脱敏）+ 服务端代生成 secret 的一次性回显字段。 */
export type EventSubscriptionCreateResult =
  components['schemas']['EventSubscriptionCreateResponseDto'];

/** 一次事件派发对一个订阅终败的完整存档（死信列表行）。 */
export type EventSubscriptionDeadLetter =
  components['schemas']['EventSubscriptionDeadLetterResponseDto'];

/** 死信分页包装（GET /event-subscriptions/{id}/dead-letters）。 */
export type EventSubscriptionDeadLetterPage =
  components['schemas']['EventSubscriptionDeadLetterPageDto'];

/** 手动重放响应：成功 ok=true 且死信删除；失败 ok=false + error 且死信保留。 */
export type ReplayDeadLetterResult =
  components['schemas']['ReplayDeadLetterResponseDto'];

/**
 * 创建/更新请求体：保持手写（`eventTypes: string[]`）。后端生成层把
 * eventTypes 收窄为事件目录的字面量联合（CreateEventSubscriptionDto），但
 * 本页表单状态是 string[]（Ant Design Form 泛型），值域最终由后端
 * @IsIn(SUBSCRIBABLE_EVENTS) 在 400 层把关——请求体不是空壳漂移的重灾区，
 * 不强行切生成类型。
 */
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

// N-04：本常量原本是 `{value, label}` 形式且 label 为中文，但**没有任何消费方读过
// label**——实测 `EventSubscriptionsSettings.tsx` 的两条渲染路径都按 value 走 i18n：
//   · Select 选项：`t(eventTypeLabelKey(o.value))`（:397）
//   · 列表/死信 Tag：`eventTypeLabel(v)` 在命中时返回 `found.value`（:81，返回的是
//     **英文事件名**而非中文 label）
// 即那 4 条中文 label 是死数据：既误导读者以为改这里能改文案，又让 i18n 守卫把
// 4 个永不渲染的串记进基线、虚增待迁移量（与 `executor-mode.ts` 的 labels 同型，
// 是 N-04 引入「基线陈旧」反向检查后暴露出的第二例）。
// 改为纯 value 清单：语义与用法一致，且文案唯一来源收敛到 locales。
export const EVENT_TYPE_OPTIONS = [
  { value: 'execution.completed' },
  { value: 'execution.failed' },
  { value: 'executor.offline' },
  { value: 'deployment.completed' },
] as const;

export type EventSubscriptionEventType = (typeof EVENT_TYPE_OPTIONS)[number]['value'];

export const eventSubscriptionsApi = {
  list: (signal?: AbortSignal) =>
    signal
      ? client.get<EventSubscription[]>('/event-subscriptions', { signal })
      : client.get<EventSubscription[]>('/event-subscriptions'),
  create: (data: CreateEventSubscriptionDto) =>
    client.post<EventSubscriptionCreateResult>('/event-subscriptions', data),
  update: (id: string, data: UpdateEventSubscriptionDto) =>
    client.patch<EventSubscription>(`/event-subscriptions/${id}`, data),
  remove: (id: string) => client.delete<{ ok: true }>(`/event-subscriptions/${id}`),
  /** 死信分页列表（page 默认 1，limit 默认 20、最大 100） */
  listDeadLetters: (id: string, page = 1, limit = 20, signal?: AbortSignal) =>
    signal
      ? client.get<EventSubscriptionDeadLetterPage>(
          `/event-subscriptions/${id}/dead-letters`,
          { params: { page, limit }, signal },
        )
      : client.get<EventSubscriptionDeadLetterPage>(
          `/event-subscriptions/${id}/dead-letters`,
          { params: { page, limit } },
        ),
  /**
   * 手动重放：以订阅当前 url/secret 重新签名派发一次（不自动重试）。
   * 成功 { ok: true } 且死信删除；失败 { ok: false, error } 且死信保留。
   */
  replayDeadLetter: (id: string, deadLetterId: string) =>
    client.post<ReplayDeadLetterResult>(
      `/event-subscriptions/${id}/dead-letters/${deadLetterId}/replay`,
    ),
};
