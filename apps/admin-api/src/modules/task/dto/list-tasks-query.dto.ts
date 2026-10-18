import { ApiPropertyOptional } from "@nestjs/swagger";
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

  /**
   * 任务名精确模糊匹配（仅 name 列）。
   *
   * 保留为**向后兼容**通道：CLI 的 `--keyword`、MCP 的 list_tasks、以及既有
   * 外部调用方都往这个字段传搜索词，语义（只搜 name）逐字节不变。
   *
   * 面向"搜索框"的通用关键字检索请用 `q`（name OR description）——见下。
   */
  @ApiPropertyOptional({
    description:
      "仅对任务**名称**做模糊匹配（向后兼容通道；CLI/MCP 使用它）。控制台搜索框承诺的是「任务名或描述」，请改用 `q`。",
  })
  @IsOptional()
  @IsString()
  name?: string;

  /**
   * 通用关键字检索：**name OR description** 模糊匹配。
   *
   * 为什么单独开一个字段而不是直接改 `name` 的语义：任务列表页的搜索框
   * 占位符承诺的是「搜索任务名、描述」，但实现只过滤了 name 列——用户输入
   * 描述里的关键字必然查不到结果，且因为不报错而完全无从察觉。
   *
   * 修法有两种，此处选**新增字段**而非改写 `name`：
   *  - `name` 已被 CLI（`acf task list -k`）、MCP（list_tasks）当作"按名搜"
   *    使用，把它的语义悄悄扩成"还搜描述"会让这些调用方的结果集变宽
   *    （与 NETOPT-3⑤ 修的同类问题同形：结果集静默变宽，调用方据错误结果
   *    得出结论）；
   *  - 新增 `q` 语义自明，且让"按名搜"与"按关键字搜"两条通道各自可测。
   *
   * 与 `name` 同时提供时取**交集**（AND）——两个条件各自成立才命中。
   */
  @ApiPropertyOptional({
    description:
      "跨任务名称**与**描述的关键字检索（LIKE 元字符按字面量匹配）。控制台搜索框发送的就是这个参数。",
  })
  @IsOptional()
  @IsString()
  q?: string;

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

  /**
   * §2.1（本轮）：**可选**的不透明游标——`GET /tasks/:id/executions` 上已落地的
   * keyset 分页推广到本端点。
   *
   * 只做加性过渡——不传它时行为与引入本字段之前**逐字节不变**（走 OFFSET 分支，
   * 响应里连 `nextCursor` 这个键都不出现）。传了它才切到 keyset 分支。
   *
   * ## 与 executions 端点的关键差异：这里游标必须与排序键同源
   *
   * 本端点支持 `sortBy`/`sortOrder` 白名单排序（`TASK_SORT_WHITELIST`，14 个键），
   * 而 keyset 游标编码的是**特定一组排序键的原值**。若允许"任意 sortBy + 任意
   * cursor"自由组合，会出现语义错乱：游标里的值来自 `createdAt` 序，查询却按
   * `priority` 序返回——"继续"的起点在该序里毫无意义，翻页必然漏行/重行，而且
   * 每一页都是 HTTP 200，调用方无从察觉。故 service 层对下列组合**显式 400 拒绝**
   * （见 `TaskService.assertCursorCompatibleWithQuery`），绝不静默降级：
   *   · `cursor` + 显式 `sortBy`（哪怕写的正是 `createdAt`——那也说明调用方对
   *     "游标绑定了哪套排序"存在误解，且未来若默认排序变更会静默出错）；
   *   · `cursor` + `lastStatus`（派生过滤分支见下）。
   *
   * 这里**刻意不做格式校验**（不挂 `@Matches`）：游标合法性判定（base64url →
   * ISO 时间 → uuid 形状）全部集中在纯函数 `decodeKeysetCursor`
   * （common/utils/keyset-cursor.util.ts）里，由它抛 `VALIDATION_FAILED`。
   * 理由与 `TaskExecutionsQueryDto#cursor` 逐字相同：管道抛的是字段名数组，
   * 无法给出"游标坏了、请从第一页重来"这句可操作指引。
   */
  @ApiPropertyOptional({
    description:
      "不透明的 keyset 游标（上一页响应的 data.nextCursor）。省略时走原有的 OFFSET 分页，响应与之前完全一致；传入时走 keyset 分支并在响应中追加 nextCursor。仅与**默认排序**（createdAt DESC, id DESC）组合；与 sortBy 或 lastStatus 同时给出返回 400。非法游标返回 400（VALIDATION_FAILED），不会静默退回第一页。",
  })
  @IsOptional()
  @IsString()
  cursor?: string;
}
