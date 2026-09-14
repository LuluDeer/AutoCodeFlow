import { ApiPropertyOptional } from "@nestjs/swagger";

/**
 * PK-19（DEEP_REVIEW 0ef3bbe）: Alertmanager v2 单条告警（仅文档化本平台消费字段）。
 */
export class AlertmanagerAlertDto {
  @ApiPropertyOptional({
    description: "告警状态 firing/resolved",
    example: "firing",
  })
  status?: string;

  @ApiPropertyOptional({
    description: "告警标签（含 alertname/labels.taskId 等）",
    example: { alertname: "HighCPU", taskId: "uuid" },
  })
  labels?: Record<string, string>;

  @ApiPropertyOptional({
    description: "告警注解（含 runbook_url 惯例）",
    example: { summary: "CPU > 90%" },
  })
  annotations?: Record<string, string>;

  @ApiPropertyOptional({
    description: "开始时间（ISO 字符串原样透出）",
    example: "2026-09-14T06:00:00Z",
  })
  startsAt?: string;

  @ApiPropertyOptional({
    description: "结束时间（resolved 时）",
    example: "2026-09-14T06:05:00Z",
  })
  endsAt?: string;

  @ApiPropertyOptional({
    description: "告警生成器 URL",
    example: "http://grafana/alert/1",
  })
  generatorURL?: string;

  @ApiPropertyOptional({ description: "告警指纹（去重用）" })
  fingerprint?: string;
}

/**
 * PK-19（DEEP_REVIEW 0ef3bbe）: POST /alerts/webhook 的 Alertmanager v2 请求体
 * Swagger 文档 DTO。
 *
 * 本类**仅用于 openapi schema 生成**——控制器 @Body() 仍收
 * AlertmanagerWebhookPayload（interface，metatype = Object，ValidationPipe 不
 * whitelist）。不挂 class-validator；HMAC 校验在控制器层完成。
 */
export class AlertmanagerWebhookDto {
  @ApiPropertyOptional({
    description: "Alertmanager webhook 协议版本",
    example: "4",
  })
  version?: string;

  @ApiPropertyOptional({ description: "告警分组键" })
  groupKey?: string;

  @ApiPropertyOptional({ description: "截断的告警条数" })
  truncatedAlerts?: number;

  @ApiPropertyOptional({ description: "组级状态 firing/resolved" })
  status?: string;

  @ApiPropertyOptional({ description: "接收方名称" })
  receiver?: string;

  @ApiPropertyOptional({ description: "组公共标签" })
  groupLabels?: Record<string, string>;

  @ApiPropertyOptional({ description: "公共标签" })
  commonLabels?: Record<string, string>;

  @ApiPropertyOptional({ description: "公共注解" })
  commonAnnotations?: Record<string, string>;

  @ApiPropertyOptional({ description: "Alertmanager 外部 URL" })
  externalURL?: string;

  @ApiPropertyOptional({
    type: [AlertmanagerAlertDto],
    description: "告警列表（空数组被控制器 400 拒绝）",
  })
  alerts?: AlertmanagerAlertDto[];
}
