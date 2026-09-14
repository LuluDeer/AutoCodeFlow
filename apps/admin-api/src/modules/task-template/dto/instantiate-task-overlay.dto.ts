import { ApiPropertyOptional } from "@nestjs/swagger";

/**
 * PK-19（DEEP_REVIEW 0ef3bbe）: POST /task-templates/:id/instantiate 的请求体
 * Swagger 文档 DTO。
 *
 * 本端点把模板 config 展开为默认，再用请求 body 逐字段覆盖（自由 overlay，
 * 最终合并后对 CreateTaskDto 校验）。body 形状是「模板覆盖字段的开放集合」，
 * 无固定字段集。本类只文档化典型覆盖字段；控制器 @Body() 仍收
 * Record<string, unknown>（metatype = Object，ValidationPipe 不 whitelist，
 * 自由 overlay 字段不被 400 拦截）。不挂 class-validator。
 */
export class InstantiateTaskOverlayDto {
  @ApiPropertyOptional({
    description: "覆盖字段（与 CreateTaskDto 同形状；显式字段胜出模板默认）。至少需 name。",
    example: { name: "prod-deploy", schedule: "0 2 * * *" },
  })
  overlay?: Record<string, unknown>;
}
