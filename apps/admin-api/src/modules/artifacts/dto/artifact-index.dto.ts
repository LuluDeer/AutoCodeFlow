import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsUUID } from "class-validator";
import { Type } from "class-transformer";
import { PageQueryDto } from "../../../common/dto/pagination.dto";

/**
 * ARTIFACTS-INDEX-46：GET /artifacts 查询参数。
 *
 * 继承 PageQueryDto（API-07 教训：分页与业务过滤分层——本端点消费
 * applicationId/taskId 两个真实过滤器，故在此显式声明，不混入通用基类）。
 */
export class ListArtifactRowsDto extends PageQueryDto {
  @ApiPropertyOptional({
    format: "uuid",
    description:
      "按应用过滤（冗余自任务行 tasks.applicationId 的写时快照；任务未挂应用/应用已删的产物行不命中）",
  })
  @IsOptional()
  @Type(() => String)
  @IsUUID()
  applicationId?: string;

  @ApiPropertyOptional({
    format: "uuid",
    description: "按任务过滤（冗余自执行行 task_executions.taskId）",
  })
  @IsOptional()
  @Type(() => String)
  @IsUUID()
  taskId?: string;
}

/**
 * GET /artifacts 的响应行（execution_artifacts 行投影）。
 *
 * ARCH-23 先例：实体无 @ApiProperty 不进契约——响应 DTO 显式列字段，
 * 排除 execution/task 关联对象（只下发 id 列，避免嵌套实体形状固化）。
 */
export class ExecutionArtifactRowDto {
  @ApiProperty({ format: "uuid" })
  id: string;

  @ApiProperty({ format: "uuid", description: "所属执行 ID" })
  executionId: string;

  @ApiProperty({ format: "uuid", description: "所属任务 ID（冗余快照）" })
  taskId: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      "所属应用 ID（冗余快照；null = 任务未挂应用或应用已删除——SET NULL 语义）",
  })
  applicationId: string | null;

  @ApiProperty({ description: "产物裸文件名" })
  name: string;

  @ApiProperty({ description: "字节数" })
  size: number;

  @ApiProperty({ description: "存储字节的 sha256" })
  sha256: string;

  @ApiProperty({ description: "索引行创建时间（ISO-8601，随终态回调写入）" })
  createdAt: Date;
}
