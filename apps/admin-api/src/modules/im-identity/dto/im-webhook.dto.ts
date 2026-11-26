import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

import { IM_PLATFORMS } from "../entities/im-identity.entity";

/**
 * N6 · IM webhook 入站请求体的 OpenAPI 投影（仅文档用途）。
 *
 * 平台 payload 字段面由企微 / 飞书决定且随版本变化，controller 的 `@Body()`
 * 使用 `unknown` 以跳过全局 ValidationPipe 的 whitelist/forbidNonWhitelisted
 * （否则未知字段会在门槛上把平台消息吞成 400）。真正的形状判定与提取在
 * `im-webhook.adapter.ts` 的 `extractImMessage`：平台严格隔离、字段缺失/类型错/
 * 超长一律 fail-closed。本类只描述 adapter 实际消费的字段，不参与运行时校验。
 *
 * **platform 不取自 body**：它由 URL 路径参数 `:platform` 提供，body 里任何
 * 自称平台的字段都忽略——避免把飞书 payload 当企微读（或反过来）。
 */
export class ImWebhookBodyDto {
  @ApiPropertyOptional({
    description:
      "企微发送方账号（FromUserName）；仅在 platform=wecom 时由 adapter 读取",
    example: "zhangsan",
  })
  FromUserName?: string;

  @ApiPropertyOptional({
    description: "企微消息正文（content），作为方案卡 goal；最长 500 字符",
    example: "每月5号导出销售报表",
  })
  content?: string;

  @ApiPropertyOptional({ description: "企微会话 id（ChatId），不参与身份绑定" })
  ChatId?: string;

  @ApiPropertyOptional({ description: "企微消息 id（MsgId），不参与身份绑定" })
  MsgId?: string;

  @ApiPropertyOptional({
    description:
      "飞书事件信封（event）；仅在 platform=feishu 时由 adapter 读取，内部取 event.message.content 与 event.sender.sender_id",
    type: "object",
    additionalProperties: true,
  })
  event?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: "飞书事件 schema 版本（2.0 = v2，content 可能是 JSON 串）",
    example: "2.0",
  })
  schema?: string;
}

/**
 * challenge 查询串的文档化投影。
 *
 * 企微首轮校验用 `echostr`、飞书用 `challenge`，二选一；controller 的
 * `@Query()` 用 adapter 的 `ImWebhookQuery` 类型接普通对象（不套 DTO 类，
 * 否则全局 whitelist 会把键剥掉），此处的 `@ApiProperty` 只为 OpenAPI 描述。
 */
export class ImWebhookChallengeQueryDto {
  @ApiProperty({
    description:
      "企微首轮校验回显串；验签通过后逐字节回显，空串/纯空白/超长一律拒绝",
    required: false,
  })
  echostr?: string;

  @ApiProperty({
    description:
      "飞书首轮校验回显串；验签通过后逐字节回显，空串/纯空白/超长一律拒绝",
    required: false,
  })
  challenge?: string;
}

/**
 * webhook 路径参数的文档化投影：平台来源唯一可信处。
 * 复用 IM_PLATFORMS 常量，不手抄字面量数组（枚举消费者守卫）。
 */
export class ImWebhookPlatformParamDto {
  @ApiProperty({
    description:
      "IM 平台；由平台调用方在 URL 路径上声明，body 自报平台一律忽略",
    enum: IM_PLATFORMS,
    example: IM_PLATFORMS[0],
  })
  platform: string;
}
