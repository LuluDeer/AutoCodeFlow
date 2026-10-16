import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/**
 * B-3（契约空壳修复）：事件订阅域（tag "Event Subscriptions"）**响应体 DTO**。
 *
 * ## 为什么不能直接标 `type: EventSubscription` / `type: EventSubscriptionDeadLetter`（实体）
 *
 * 实体没有 @ApiProperty，@nestjs/swagger 只会 emit
 * `{type:'object', properties:{}}` —— **空壳 schema**（先例与机理见
 * `config-response.dto.ts` 头注）：前端 `gen:api-types` 生成
 * `Record<string, never>`，比没有类型更坏。baseline 里 5 条存量空壳中 2 条
 * 在本域（GET /event-subscriptions、PATCH /event-subscriptions/{id}），本 DTO
 * 逐条替换；create/dead-letters/replay 顺带补上此前完全缺失的响应 schema。
 *
 * ## 字段与「实际运行时返回」逐一对齐（含脱敏语义）
 *
 * 控制器直接返回 service 的 `EventSubscription` 实体，但 service 读面统一经
 * `mask()`：`secret` 恒为固定占位 `'******'`（明文只在 create 响应的
 * `generatedSecret` 一次性回显）。契约按**真实返回**声明。
 */
export class EventSubscriptionResponseDto {
  @ApiProperty({
    format: "uuid",
    description: "订阅 UUID",
  })
  id: string;

  @ApiPropertyOptional({
    nullable: true,
    type: "number",
    description:
      "属主用户 ID（整数）。null = 系统级订阅（由 ADMIN 管理，对所有管理员可见，并为排查问题向所有用户开放读权限）。",
  })
  userId: number | null;

  @ApiProperty({
    type: "array",
    items: { type: "string" },
    example: ["execution.failed"],
    description:
      "订阅的事件名（稳定目录，只增不改）：execution.completed / execution.failed / executor.offline / deployment.completed",
  })
  eventTypes: string[];

  @ApiProperty({
    maxLength: 2048,
    description:
      "回调 URL（公网 http(s)；写入时做 SSRF 深度校验，并在每次外发投递前重新检查）",
  })
  url: string;

  @ApiProperty({
    example: "******",
    description:
      "HMAC 签名 secret —— 在所有读面恒为掩码占位符 '******'（明文仅在创建时以 generatedSecret 返回一次）",
  })
  secret: string;

  @ApiProperty({ description: "是否启用投递" })
  enabled: boolean;

  @ApiProperty({ description: "连续投递失败次数（任一次成功即重置为 0）" })
  consecutiveFailures: number;

  @ApiPropertyOptional({
    nullable: true,
    type: "string",
    format: "date-time",
    description: "最近一次投递失败的时间戳；null = 从未失败",
  })
  lastFailureAt: Date | null;

  @ApiPropertyOptional({
    nullable: true,
    type: "string",
    maxLength: 512,
    description: "最近一次失败摘要（截断至 512 字符；绝不含 secret/payload）",
  })
  lastFailureError: string | null;

  @ApiProperty({ description: "创建时间（ISO-8601）" })
  createdAt: Date;

  @ApiProperty({ description: "最后更新时间（ISO-8601）" })
  updatedAt: Date;
}

/**
 * `POST /event-subscriptions` 的 201 响应：新订阅行（已脱敏）+ 服务端代生成
 * secret 的一次性回显字段。`generatedSecret` 仅在调用方省略 secret 时存在。
 */
export class EventSubscriptionCreateResponseDto {
  @ApiProperty({ description: "新建的订阅（secret 已掩码）" })
  subscription: EventSubscriptionResponseDto;

  @ApiPropertyOptional({
    pattern: "^[0-9a-f]{64}$",
    description:
      "服务端生成的 32 字节十六进制 secret —— 仅在本响应中返回一次。调用方自带 secret 时不出现。",
  })
  generatedSecret?: string;
}

/**
 * `GET /event-subscriptions/{id}/dead-letters` 的单行：一次事件派发对一个
 * 订阅终败的完整存档（死信列表 + 手动重放的数据源）。
 */
export class EventSubscriptionDeadLetterResponseDto {
  @ApiProperty({
    format: "uuid",
    description: "死信 UUID",
  })
  id: string;

  @ApiProperty({
    format: "uuid",
    description: "所属订阅 UUID",
  })
  subscriptionId: string;

  @ApiProperty({
    maxLength: 64,
    description: "投递失败的事件名（例如 execution.failed）",
  })
  eventType: string;

  @ApiProperty({
    type: "object",
    additionalProperties: true,
    description: "发送时刻的完整外发信封（event/occurredAt/data）",
  })
  payload: Record<string, unknown>;

  @ApiProperty({
    maxLength: 1024,
    description: "最近一次失败摘要（截断至 1024 字符）",
  })
  error: string;

  @ApiProperty({
    description:
      "实际投递尝试次数（首次尝试 + outbox 扫描器重试，受 MAX_OUTBOX_ATTEMPTS 限制）",
  })
  attempts: number;

  @ApiProperty({ description: "该死信的记录时间（ISO-8601）" })
  createdAt: Date;
}

/** `GET /event-subscriptions/{id}/dead-letters` 的分页包装。 */
export class EventSubscriptionDeadLetterPageDto {
  @ApiProperty({
    type: [EventSubscriptionDeadLetterResponseDto],
    description: "死信分页，按最新在前",
  })
  data: EventSubscriptionDeadLetterResponseDto[];

  @ApiProperty({ description: "分页前的匹配总行数" })
  total: number;
}

/**
 * `POST /event-subscriptions/{id}/dead-letters/{dlId}/replay` 的响应。
 * 成功 `{ok:true}` 且死信行已删；失败 `{ok:false, error}` 且死信保留。
 */
export class ReplayDeadLetterResponseDto {
  @ApiProperty({ description: "本次单次重放投递是否成功" })
  ok: boolean;

  @ApiPropertyOptional({
    type: "string",
    maxLength: 1024,
    description: "ok=false 时的失败摘要（该行会保留以便再次尝试）",
  })
  error?: string;
}
