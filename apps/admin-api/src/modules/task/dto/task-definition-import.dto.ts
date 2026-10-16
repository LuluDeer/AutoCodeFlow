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
    example: "1",
    description: "本 API 接受的导出 schema 版本",
  })
  @IsIn([TASK_EXPORT_SCHEMA_VERSION])
  schemaVersion!: string;

  @ApiPropertyOptional({ description: "源导出物的 exportedAt（仅供参考）" })
  @IsISO8601()
  @IsOptional()
  exportedAt?: string;

  @ApiProperty({
    type: CreateTaskDto,
    description:
      "任务定义。secrets 绝不参与定义传输：携带的 secrets 键会被忽略（并给出告警），导入后的任务不带 secrets 启动。",
  })
  @IsObject()
  @ValidateNested()
  @Type(() => CreateTaskDto)
  task!: CreateTaskDto;
}

/** POST /tasks/import 的响应体（envelope data）。 */
export class TaskImportResultDto {
  @ApiProperty({ description: "新建任务的 id" })
  taskId!: string;
  @ApiProperty({
    description:
      '最终任务名（冲突时追加后缀 \\" (imported)\\" / \\" (imported) N\\"）',
  })
  name!: string;
  @ApiProperty({
    type: [String],
    description:
      "总是包含「请重新配置 secrets」的提示（SEC-02 红线）；可能包含其它说明（例如被忽略的 secrets 键）。",
  })
  warnings!: string[];
}
