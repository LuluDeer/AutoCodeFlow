import { IsOptional, IsUUID, IsString, IsIn, IsEnum } from "class-validator";
import { PaginationDto } from "../../../common/dto/pagination.dto";
import {
  TaskStatus,
  TaskRuntime,
  TaskTriggerType,
} from "../entities/task.entity";
import { ExecutionStatus } from "../entities/task-execution.entity";

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
 *
 * 沿革（P2-18 落地轮）：曾混入 `lastStatus` / `lastRunTime` / `nextRunTime`
 * 三个**幽灵项**——Task 实体从来没有这三列（全量迁移史亦无），`?fields=` 传
 * 它们会 400，属于"契约公示了不存在的列"的假 API 面，已删除。lastStatus 的
 * 产品语义（按最近一次执行状态筛任务）改由同名 query 参数承担——它是执行
 * 维度的派生过滤，见 ListTasksQueryDto#lastStatus 的子查询实现。
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

  /**
   * P2-18: 按任务**最近一次执行**的状态筛任务（值域 = ExecutionStatus）。
   *
   * 语义钉死：`lastStatus=X` ⇔ 该任务在 task_executions 里最近一次执行
   * （taskId 下 createdAt DESC、tie-break id DESC 取第一条）的 status === X。
   * 最近一次还在 pending/running 也如实参与筛选——值班看到的就是当前真实状态。
   *
   * 实现说明：Task 实体没有 lastStatus 冗余列（刻意不加 schema）——service 层
   * findAll 用关联子查询（EXISTS + 标量子查询取最近一条）实现，与实体 status
   * （active/paused）正交。这是**执行维度**的派生过滤，不属于投影白名单。
   */
  @IsOptional()
  @IsEnum(ExecutionStatus)
  lastStatus?: ExecutionStatus;

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
