import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from "class-validator";
import { CRON_5FIELD_RE } from "../maintenance-window.util";

/**
 * FEAT-06: 任务级维护窗口条目（CreateTaskDto.maintenanceWindows 的元素，
 * 经 @ValidateNested({ each: true }) 递归校验——未知字段会被全局
 * forbidNonWhitelisted 管道直接 400）。start/end 均为 5 字段 cron，
 * 与 CreateTaskDto.cronExpression 共用同一 CRON_5FIELD_RE，保证窗口
 * cron 与调度主 cron 的合法性口径一致。
 */
export class MaintenanceWindowDto {
  @ApiProperty({
    description: "窗口开启 Cron（5 字段：分 时 日 月 周）",
    example: "30 2 * * *",
  })
  @IsString()
  @IsNotEmpty()
  @Matches(CRON_5FIELD_RE, {
    message:
      "maintenanceWindows[].start must be a valid 5-field cron expression (min hour day month weekday)",
  })
  start: string;

  @ApiProperty({
    description: "窗口关闭 Cron（5 字段：分 时 日 月 周）",
    example: "0 4 * * *",
  })
  @IsString()
  @IsNotEmpty()
  @Matches(CRON_5FIELD_RE, {
    message:
      "maintenanceWindows[].end must be a valid 5-field cron expression (min hour day month weekday)",
  })
  end: string;

  @ApiPropertyOptional({ description: "窗口用途说明（展示/日志用）" })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  description?: string;
}
