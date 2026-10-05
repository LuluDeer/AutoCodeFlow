import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsISO8601,
  IsIn,
  IsObject,
  IsOptional,
  ValidateNested,
} from "class-validator";
import { CreateTaskDto } from "./create-task.dto";
import { TASK_EXPORT_SCHEMA_VERSION } from "../task-definition.util";

/**
 * E-1（任务定义导入）：POST /tasks/import 请求体。
 *
 * body = GET /tasks/:id/export 的导出物（TaskExportPayloadDto 同形）。
 * `task` 直接复用 **CreateTaskDto 的全量写校验**（@ValidateNested +
 * @Type）：cron/时区/枚举/params 体积/secrets 键名等约束与 POST /tasks
 * 完全同源；全局 ValidationPipe 的 whitelist + forbidNonWhitelisted 会把
 * 导入物里的未知键（含导出侧不存在的任何新增字段）打成 400。
 */
export class ImportTaskDto {
  @ApiProperty({
    enum: [TASK_EXPORT_SCHEMA_VERSION],
    description: "Export schema version this API accepts",
    example: "1",
  })
  @IsIn([TASK_EXPORT_SCHEMA_VERSION])
  schemaVersion!: string;

  @ApiPropertyOptional({
    description: "exportedAt of the source export (informational)",
  })
  @IsISO8601()
  @IsOptional()
  exportedAt?: string;

  @ApiProperty({
    type: CreateTaskDto,
    description:
      "Task definition. Secrets are never part of a definition transfer: " +
      "a carried secrets key is ignored (with a warning) and the imported " +
      "task starts without secrets.",
  })
  @IsObject()
  @ValidateNested()
  @Type(() => CreateTaskDto)
  task!: CreateTaskDto;
}

/** POST /tasks/import 的响应体（envelope data）。 */
export class TaskImportResultDto {
  @ApiProperty({ description: "Newly created task id" })
  taskId!: string;
  @ApiProperty({
    description:
      'Final task name (suffix " (imported)" / " (imported) N" appended on conflicts)',
  })
  name!: string;
  @ApiProperty({
    type: [String],
    description:
      "Always contains the reconfigure-secrets hint (SEC-02 red line); " +
      "may contain additional notes (e.g. an ignored secrets key).",
  })
  warnings!: string[];
}
