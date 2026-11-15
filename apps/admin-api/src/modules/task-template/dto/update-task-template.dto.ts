import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";

/**
 * PATCH /task-templates/:id —— 自定义模板的局部更新请求体。
 *
 * 可编辑字段刻意收窄为展示与运行参数：`name / description / category / config`。
 * `key`（稳定标识）、`isOfficial`（官方标记）、`createdBy`（属主）**不可经本端点
 * 改写**——键漂移会让按 key 引用模板的 SOP / 清单失锚；官方只读；属主只能由
 * 删除重建转移。
 *
 * `config` 的结构合法性在 service 层复用 `assertValidTaskTemplateConfig`
 * （CreateTaskDto 子集语义）；本 DTO 只保证它是对象。
 * `description` / `category` 传 `null` 表示清空（`@IsOptional()` 对 null 短路）。
 */
export class UpdateTaskTemplateDto {
  @ApiPropertyOptional({ example: "每日订单同步", description: "模板展示名" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({
    description: "模板说明；传 null 清空",
    nullable: true,
  })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  description?: string | null;

  @ApiPropertyOptional({
    description: "粗分类标签（备份/巡检/同步/清理/通知…）；传 null 清空",
    nullable: true,
  })
  @IsString()
  @IsOptional()
  @MaxLength(32)
  category?: string | null;

  @ApiPropertyOptional({
    type: "object",
    additionalProperties: true,
    description: "合法 CreateTaskDto 子集（省略 name）；整体替换现有 config",
  })
  @IsObject()
  @IsOptional()
  config?: Record<string, unknown>;
}
