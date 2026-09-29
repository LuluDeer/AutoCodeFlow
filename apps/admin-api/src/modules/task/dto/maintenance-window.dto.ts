import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";
// 与调度主 cron 同一语义门（规范化后 nodeCron.validate + 界内守卫）——
// 取代此前裸结构正则 @Matches(CRON_5FIELD_RE)：结构正则会放行「调度器
// 注册后永不触发」的形态（如 32-40 * * * *，node-cron v4 validate 误放），
// 造成窗口静默不生效。
import { IsCron5Field } from "./cron-expression.constraint";

/**
 * FEAT-06: 任务级维护窗口条目（CreateTaskDto.maintenanceWindows 的元素，
 * 经 @ValidateNested({ each: true }) 递归校验——未知字段会被全局
 * forbidNonWhitelisted 管道直接 400）。start/end 均为 5 字段 cron，
 * 与 CreateTaskDto.cronExpression 共用同一 CRON_5FIELD_RE，保证窗口
 * cron 与调度主 cron 的合法性口径一致。
 *
 * 本 DTO 只做**结构**校验；裸 n/step（POSIX 语义，如 `12/20`）在写边界由
 * task.service.normalizeTaskDto 等价规范化为 `n-max/step` 后落库，运行时
 * parseWindowCron（nodeCron.validate 门）拿到的永远是可解析的规范式。
 */
export class MaintenanceWindowDto {
  @ApiProperty({
    description: "窗口开启 Cron（5 字段：分 时 日 月 周）",
    example: "30 2 * * *",
  })
  @IsString()
  @IsNotEmpty()
  @IsCron5Field()
  start: string;

  @ApiProperty({
    description: "窗口关闭 Cron（5 字段：分 时 日 月 周）",
    example: "0 4 * * *",
  })
  @IsString()
  @IsNotEmpty()
  @IsCron5Field()
  end: string;

  @ApiPropertyOptional({ description: "窗口用途说明（展示/日志用）" })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  description?: string;
}
