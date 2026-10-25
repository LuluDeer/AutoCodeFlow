import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsArray,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

/**
 * PK-19（DEEP_REVIEW 0ef3bbe）: Alertmanager v2 单条告警（仅声明本平台消费字段）。
 *
 * F-53（UIAUDIT 后端轮 P3-4）：从「纯文档」升级为**运行时校验**的嵌套 DTO。
 * 面向的是外部告警系统（版本/字段面不可控），故全部字段 @IsOptional、只钉
 * 形状不钉取值：未知键由控制器参数管道的 whitelist **静默剥离**（不 forbid），
 * 已知字段的类型错（labels 传成字符串等）400。labels/annotations 内部值不
 * 校验——映射层（alert-webhook.mapping）本就对任意值自防御。
 */
export class AlertmanagerAlertDto {
  @ApiPropertyOptional({
    example: "firing",
    description: "告警状态 firing/resolved",
  })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({
    example: { alertname: "HighCPU", taskId: "uuid" },
    description: "告警标签（含 alertname/labels.taskId 等）",
  })
  @IsOptional()
  @IsObject()
  labels?: Record<string, string>;

  @ApiPropertyOptional({
    example: { summary: "CPU > 90%" },
    description: "告警注解（含 runbook_url 惯例）",
  })
  @IsOptional()
  @IsObject()
  annotations?: Record<string, string>;

  @ApiPropertyOptional({
    example: "2026-09-14T06:00:00Z",
    description: "开始时间（ISO 字符串原样透出）",
  })
  @IsOptional()
  @IsString()
  startsAt?: string;

  @ApiPropertyOptional({
    example: "2026-09-14T06:05:00Z",
    description: "结束时间（resolved 时）",
  })
  @IsOptional()
  @IsString()
  endsAt?: string;

  @ApiPropertyOptional({
    example: "http://grafana/alert/1",
    description: "告警生成器 URL",
  })
  @IsOptional()
  @IsString()
  generatorURL?: string;

  @ApiPropertyOptional({ description: "告警指纹（去重用）" })
  @IsOptional()
  @IsString()
  fingerprint?: string;
}

/**
 * PK-19（DEEP_REVIEW 0ef3bbe）: POST /alerts/webhook 的 Alertmanager v2 请求体
 * DTO。
 *
 * F-53（UIAUDIT 后端轮 P2-2/P3-4）：本类原为**仅 openapi 文档**（控制器
 * @Body() 收 interface，metatype=Object，全局 ValidationPipe 整面跳过——
 * HMAC 正确时任意形状 JSON 直达映射层）。现挂上 class-validator 并在控制器
 * 参数管道以 `expectedType` 启用：
 *
 *   @Body(new ValidationPipe({
 *     expectedType: AlertmanagerWebhookDto,
 *     whitelist: true,        // 未知键静默剥离——Alertmanager 版本字段不可控，
 *                             // 不开 forbidNonWhitelisted（与全站纪律的**显式
 *                             // 例外**，理由：外部机器面 + HMAC 已鉴权 +
 *                             // 映射层自防御；对内部调用方的人操作面纪律不变）
 *     transform: true,
 *   }))
 *
 * metatype 仍是 interface（运行时 Object），全局管道照旧跳过，无双重校验。
 * HMAC 校验在控制器 handler 内对 `req.rawBody` 完成——管道对**已解析对象**
 * 的剥离不影响原始字节，签名面零变化。
 *
 * 必填面说明：**刻意全部 @IsOptional**——「alerts 缺失/空数组 → 400」的既有
 * 语义由映射层给出更精确的 NOTIFICATION_ALERT_PAYLOAD_EMPTY（控制器既有
 * 行为，live 已按此契约对接），若在 DTO 层把 alerts 设为必填，同类错误会
 * 降级成泛化 VALIDATION_FAILED，破坏既有错误契约。DTO 层只钉**形状**。
 */
export class AlertmanagerWebhookDto {
  @ApiPropertyOptional({
    example: "4",
    description: "Alertmanager webhook 协议版本",
  })
  @IsOptional()
  @IsString()
  version?: string;

  @ApiPropertyOptional({ description: "告警分组键" })
  @IsOptional()
  @IsString()
  groupKey?: string;

  @ApiPropertyOptional({ description: "截断的告警条数" })
  @IsOptional()
  @IsNumber()
  truncatedAlerts?: number;

  @ApiPropertyOptional({ description: "组级状态 firing/resolved" })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ description: "接收方名称" })
  @IsOptional()
  @IsString()
  receiver?: string;

  @ApiPropertyOptional({ description: "组公共标签" })
  @IsOptional()
  @IsObject()
  groupLabels?: Record<string, string>;

  @ApiPropertyOptional({ description: "公共标签" })
  @IsOptional()
  @IsObject()
  commonLabels?: Record<string, string>;

  @ApiPropertyOptional({ description: "公共注解" })
  @IsOptional()
  @IsObject()
  commonAnnotations?: Record<string, string>;

  @ApiPropertyOptional({ description: "Alertmanager 外部 URL" })
  @IsOptional()
  @IsString()
  externalURL?: string;

  @ApiPropertyOptional({
    type: [AlertmanagerAlertDto],
    description:
      "告警列表（空数组/缺失由控制器映射层以 400 NOTIFICATION_ALERT_PAYLOAD_EMPTY 拒绝）",
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AlertmanagerAlertDto)
  alerts?: AlertmanagerAlertDto[];
}
