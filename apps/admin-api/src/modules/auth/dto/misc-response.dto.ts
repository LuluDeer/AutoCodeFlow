import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/**
 * ARCH-23 / N-12（2026-10-07 A2 批）：零散端点契约收尾——Oidc、Auth sessions
 * 删除、deprecated 批量面、任务 webhook 触发、Alertmanager 接收端、Projects
 * 删除双端点、模板/订阅删除。SSE 流（task logs）与既有 metrics 流同口径。
 */

/** GET /auth/oidc/status —— OIDC 可用性探针（登录页按钮显隐依据）。 */
export class OidcStatusResponseDto {
  @ApiProperty({ description: "false = OIDC 未配置，登录页隐藏 SSO 入口" })
  enabled: boolean;
}

/** DELETE /auth/sessions/:id —— 吊销自己的一条会话（非法 id 幂等软失败）。 */
export class SessionRevokeResponseDto {
  @ApiProperty({
    description:
      "false = 非法 id（非整数）；true = 已吊销或本就不属于该用户路径的幂等结果",
  })
  success: boolean;
}

/** POST /webhooks/tasks/:taskId —— 入站 webhook 触发回执（等待终态时含执行结果）。 */
export class TaskWebhookTriggerResponseDto {
  @ApiProperty({
    format: "uuid",
    description: "Execution row id created by the trigger",
  })
  executionId?: string;

  @ApiProperty({
    description:
      "执行行/终态载荷（wait=true 时为终态执行行，否则为已受理执行行）",
    additionalProperties: true,
  })
  execution?: Record<string, unknown>;

  /** 其余透传字段按 service 返回（index signature 不吃装饰器，swagger 按
   *  已声明的具名字段渲染——动态键如实以注释声明）。 */
  [key: string]: unknown;
}

/** POST /alerts/webhook —— Alertmanager v2 接收回执（0 通道送达=502）。 */
export class AlertsWebhookResponseDto {
  @ApiProperty({ enum: [true] })
  ok: true;

  @ApiProperty({ description: "送达的通道数" })
  delivered: number;

  @ApiProperty({
    description: "Per-channel delivery status",
    additionalProperties: {
      type: "string",
      enum: ["sent", "blocked", "failed", "skipped"],
    },
  })
  results: Record<string, string>;
}

/** POST /tasks-batch/*（deprecated 别名控制器）—— 与 canonical /tasks/batch/* 同
 *  形态：逐任务结果数组（成功项=实体/{deleted:true}，失败项={id,error}）。 */
export class DeprecatedBatchItemDto {
  @ApiPropertyOptional({
    description: "失败项携带的任务 id（成功项是完整实体，无独立 id 字段名）",
  })
  id?: string;

  @ApiPropertyOptional({ description: "失败原因（partial-failure 标记）" })
  error?: string;

  /** 成功项的任意实体字段（trigger=execution 行 / pause/resume=task 行 /
   *  delete={deleted:true}）。 */
  [key: string]: unknown;
}

/** DELETE /projects/:id 与 DELETE /projects/:id/members/:userId 回执。 */
export class ProjectDeleteResponseDto {
  @ApiProperty({ description: "true = 删除/移除生效" })
  deleted: boolean;
}

/** DELETE /task-templates/:id 与 DELETE /event-subscriptions/:id 回执。 */
export class SimpleOkResponseDto {
  @ApiProperty({ enum: [true] })
  ok: true;
}
