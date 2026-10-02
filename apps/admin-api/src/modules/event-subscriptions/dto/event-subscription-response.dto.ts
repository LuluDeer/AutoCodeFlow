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
  @ApiProperty({ description: "Subscription UUID", format: "uuid" })
  id: string;

  @ApiPropertyOptional({
    description:
      "Owner user id (integer). null = system-level subscription (ADMIN-managed, " +
      "visible to every admin and to all users for troubleshooting reads).",
    nullable: true,
    type: "number",
  })
  userId: number | null;

  @ApiProperty({
    description:
      "Subscribed event names (stable catalog, append-only): execution.completed / " +
      "execution.failed / executor.offline / deployment.completed",
    type: "array",
    items: { type: "string" },
    example: ["execution.failed"],
  })
  eventTypes: string[];

  @ApiProperty({
    description:
      "Callback URL (public http(s); SSRF deep-validated on write and re-checked " +
      "before every outbound delivery)",
    maxLength: 2048,
  })
  url: string;

  @ApiProperty({
    description:
      "HMAC signing secret — always the mask placeholder '******' on every read " +
      "surface (plaintext returned once as generatedSecret on create only)",
    example: "******",
  })
  secret: string;

  @ApiProperty({ description: "Whether delivery is enabled" })
  enabled: boolean;

  @ApiProperty({
    description: "Consecutive delivery failures (reset to 0 on any success)",
  })
  consecutiveFailures: number;

  @ApiPropertyOptional({
    description:
      "Timestamp of the most recent delivery failure; null = never failed",
    nullable: true,
    type: "string",
    format: "date-time",
  })
  lastFailureAt: Date | null;

  @ApiPropertyOptional({
    description:
      "Most recent failure summary (truncated to 512; never contains secret/payload)",
    nullable: true,
    type: "string",
    maxLength: 512,
  })
  lastFailureError: string | null;

  @ApiProperty({ description: "Creation time (ISO-8601)" })
  createdAt: Date;

  @ApiProperty({ description: "Last update time (ISO-8601)" })
  updatedAt: Date;
}

/**
 * `POST /event-subscriptions` 的 201 响应：新订阅行（已脱敏）+ 服务端代生成
 * secret 的一次性回显字段。`generatedSecret` 仅在调用方省略 secret 时存在。
 */
export class EventSubscriptionCreateResponseDto {
  @ApiProperty({ description: "Created subscription (secret masked)" })
  subscription: EventSubscriptionResponseDto;

  @ApiPropertyOptional({
    description:
      "Server-generated 32-byte hex secret — returned exactly once, on this " +
      "response only. Absent when the caller supplied their own secret.",
    pattern: "^[0-9a-f]{64}$",
  })
  generatedSecret?: string;
}

/**
 * `GET /event-subscriptions/{id}/dead-letters` 的单行：一次事件派发对一个
 * 订阅终败的完整存档（死信列表 + 手动重放的数据源）。
 */
export class EventSubscriptionDeadLetterResponseDto {
  @ApiProperty({ description: "Dead letter UUID", format: "uuid" })
  id: string;

  @ApiProperty({ description: "Owning subscription UUID", format: "uuid" })
  subscriptionId: string;

  @ApiProperty({
    description: "Event name that failed delivery (e.g. execution.failed)",
    maxLength: 64,
  })
  eventType: string;

  @ApiProperty({
    description:
      "Complete outbound envelope at send time (event/occurredAt/data)",
    type: "object",
    additionalProperties: true,
  })
  payload: Record<string, unknown>;

  @ApiProperty({
    description: "Last failure summary (truncated to 1024)",
    maxLength: 1024,
  })
  error: string;

  @ApiProperty({
    description:
      "Actual delivery attempts (first attempt + outbox scanner retries, " +
      "bounded by MAX_OUTBOX_ATTEMPTS)",
  })
  attempts: number;

  @ApiProperty({ description: "When this dead letter was recorded (ISO-8601)" })
  createdAt: Date;
}

/** `GET /event-subscriptions/{id}/dead-letters` 的分页包装。 */
export class EventSubscriptionDeadLetterPageDto {
  @ApiProperty({
    description: "Page of dead letters, newest first",
    type: [EventSubscriptionDeadLetterResponseDto],
  })
  data: EventSubscriptionDeadLetterResponseDto[];

  @ApiProperty({ description: "Total matching rows before paging" })
  total: number;
}

/**
 * `POST /event-subscriptions/{id}/dead-letters/{dlId}/replay` 的响应。
 * 成功 `{ok:true}` 且死信行已删；失败 `{ok:false, error}` 且死信保留。
 */
export class ReplayDeadLetterResponseDto {
  @ApiProperty({ description: "Whether the single replay delivery succeeded" })
  ok: boolean;

  @ApiPropertyOptional({
    description: "Failure summary when ok=false (row is kept for another try)",
    type: "string",
    maxLength: 1024,
  })
  error?: string;
}
