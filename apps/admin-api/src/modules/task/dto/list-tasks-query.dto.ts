import { IsOptional, IsUUID, IsString } from "class-validator";
import { PaginationDto } from "../../../common/dto/pagination.dto";

/**
 * F-10（DEEP_REVIEW 0ef3bbe）: 任务列表轻量投影白名单。
 * `?fields=id,name` 时 service 层只 select 这些列，跳过 params/secrets/
 * glueSource/requirements/runbook/maintenanceWindows 等重量 jsonb/text 列——
 * 依赖下拉/DAG 等只需 id 与 name 的消费方不再拉全列，消除千级任务
 * 6 并发请求风暴。白名单严格收口：secrets 永不投影（SEC-02），重量列
 * （params/glueSource/dependencies/requirements/runbook/maintenanceWindows）
 * 不在白名单内，请求即 400。
 */
export const TASK_PROJECTION_WHITELIST = [
  "id",
  "name",
  "description",
  "status",
  "runtime",
  "runtimeVersion",
  "triggerType",
  "cronExpression",
  "timezone",
  "fixedRate",
  "applicationId",
  "projectId",
  "executorAppName",
  "enabled",
  "timeout",
  "maxRetry",
  "retryDelay",
  "lastTriggerTime",
  "lastRunTime",
  "lastStatus",
  "nextRunTime",
  "createdAt",
  "updatedAt",
] as const;

export class ListTasksQueryDto extends PaginationDto {
  @IsOptional()
  @IsUUID()
  applicationId?: string;

  /**
   * AUTH-01: 项目过滤。字面量 "default" 映射为默认项目 uuid（未分配行
   * IS NULL OR projectId=默认 uuid 一起命中）；传具体 uuid 时精确过滤。
   */
  @IsOptional()
  @IsString()
  projectId?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  runtime?: string;

  @IsOptional()
  @IsString()
  triggerType?: string;

  /**
   * F-10: 逗号分隔的投影字段白名单（如 "id,name"）。非法字段（不在
   * TASK_PROJECTION_WHITELIST 内）由 service 层校验并 400——DTO 层只做
   * 字符串形状校验，白名单语义校验在 service（需访问常量集）。
   */
  @IsOptional()
  @IsString()
  fields?: string;
}
