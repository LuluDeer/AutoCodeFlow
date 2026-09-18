import { IsOptional, IsUUID, IsString, IsIn, IsEnum } from "class-validator";
import { PaginationDto } from "../../../common/dto/pagination.dto";
import {
  TaskStatus,
  TaskRuntime,
  TaskTriggerType,
} from "../entities/task.entity";

/**
 * F-10（DEEP_REVIEW 0ef3bbe）: 任务列表轻量投影白名单。
 * `?fields=id,name` 时 service 层只 select 这些列，跳过 params/secrets/
 * glueSource/requirements/runbook/maintenanceWindows 等重量 jsonb/text 列——
 * 依赖下拉/DAG 等只需 id 与 name 的消费方不再拉全列，消除千级任务
 * 6 并发请求风暴。白名单严格收口：secrets 永不投影（SEC-02）。
 *
 * PERF-02（本轮体验审查）：`dependencies` 曾被显式排除在白名单外，理由是
 * 「重量列」——但它是 TaskDependencyGraph 的**唯一**边集来源
 * （admin-web/src/components/dag-layout.ts:58 直接读 t.dependencies，undefined
 * 即 `continue`）。而 useAllTasksForDag 走的是 listAll 的默认投影
 * `?fields=id,name`，于是边集恒空：任何配了上下游依赖的任务打开「依赖」页签
 * 都显示「该任务没有依赖其他任务」，且「触发整条链」退化为只触发单任务。
 * 这是 F-10 性能修复引入的静默功能损坏（单元测试 mock 掉了 API 层所以全绿）。
 *
 * 故将其纳入白名单：它是 `Record<string, string>` 的轻量映射（任务 id →
 * 任务名），量级与 id/name 同级，不属于 params/glueSource 那类大文本；真正
 * 的重量列（secrets/params/glueSource/requirements/runbook/maintenanceWindows）
 * 仍严格排除。
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
  // PERF-02: DAG 边集来源，见文件头注释。
  "dependencies",
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

  // F-06（本轮审计）: 枚举字段收紧——此前 @IsString 让 status=xyz 之类非法值
  // 静默查空结果而不是 400（与 CreateTaskDto 的 @IsEnum 严格度不一致）。子类
  // 重声明会覆盖基类 PaginationDto 的同名 @IsString（基类被 audit/executions/
  // config 等 6 个 DTO 共享，不能把 TaskStatus 语义强加给它们，故只在此收紧）。
  @IsOptional()
  @IsEnum(TaskStatus)
  status?: string;

  @IsOptional()
  @IsEnum(TaskRuntime)
  runtime?: string;

  @IsOptional()
  @IsEnum(TaskTriggerType)
  triggerType?: string;

  /**
   * F-03（本轮审计）: 列表排序字段。语义白名单在 service 层校验（对齐 fields
   * 的既有模式——DTO 只做形状校验，白名单需访问 service 的常量集）。缺省 =
   * createdAt DESC（旧行为不变）。
   */
  @IsOptional()
  @IsString()
  sortBy?: string;

  /** F-03: 排序方向（asc|desc），缺省 desc。非法值（非 asc/desc）直接 400。 */
  @IsOptional()
  @IsIn(["asc", "desc"])
  sortOrder?: "asc" | "desc";

  /**
   * F-10: 逗号分隔的投影字段白名单（如 "id,name"）。非法字段（不在
   * TASK_PROJECTION_WHITELIST 内）由 service 层校验并 400——DTO 层只做
   * 字符串形状校验，白名单语义校验在 service（需访问常量集）。
   */
  @IsOptional()
  @IsString()
  fields?: string;
}
