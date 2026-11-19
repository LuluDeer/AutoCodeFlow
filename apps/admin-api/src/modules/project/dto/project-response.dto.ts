import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/**
 * ARCH-23 / N-12：项目域**响应体 DTO**。
 *
 * 为什么不能直接标 `type: Project`（实体）或复用 `ProjectViewRow`（interface）：
 *   · **实体**没有 `@ApiProperty` → @nestjs/swagger 只 emit 空壳 schema
 *     （`properties:{}`），前端生成 `Record<string, never>`，且被 CI 的 PK-15
 *     空 schema 闸打红（本仓在 Application 上实测踩过，见 `application-response.dto.ts` 头注）；
 *   · **interface** 在运行时不存在，装饰器反射不到，同样产不出 schema。
 * 故落成带装饰器的类。
 *
 * 字段与 `toProjectView()`（projects.controller.ts 的纯函数）逐一对齐，
 * 含可空性——契约写错比没有契约更坏（前端会照错误类型写代码）。
 */
export class ProjectViewDto {
  @ApiProperty({ description: "项目 ID（uuid）" })
  id: string;

  @ApiProperty({ description: "项目名称" })
  name: string;

  @ApiPropertyOptional({
    nullable: true,
    description: "描述",
  })
  description: string | null;

  @ApiProperty({ description: "创建时间（ISO-8601）" })
  createdAt: Date;

  @ApiProperty({ description: "最后更新时间（ISO-8601）" })
  updatedAt: Date;

  @ApiPropertyOptional({
    nullable: true,
    enum: ["viewer", "editor", "admin"],
    description:
      "调用主体在该项目中的角色；非成员为 null。ADMIN 也会在这里拿到其真实的成员行（如实返回，不做合成）。",
  })
  myRole: string | null;
}

/**
 * 项目**实体**面的响应（GET /projects/:id、POST /projects、PATCH /projects/:id）。
 *
 * 为什么要与 `ProjectViewDto` 分开：这三个端点返回的是 `Project` **实体**
 * （`service.findOne/create/update`），**不带 `myRole`**——那是 `findAll` 的
 * 列表视图专有字段。首版我把它们一律标成 `ProjectViewDto`，等于在契约里
 * 承诺了一个永不返回的字段（前端会照 `myRole` 写代码然后拿到 undefined）。
 * 这类"文档按想象写"比没有 schema 更坏，故按实际返回拆成两个 DTO。
 */
export class ProjectEntityDto {
  @ApiProperty({ description: "项目 ID（uuid）" })
  id: string;

  @ApiProperty({ description: "唯一项目名称" })
  name: string;

  @ApiPropertyOptional({
    nullable: true,
    description: "描述",
  })
  description: string | null;

  @ApiProperty({ description: "创建时间（ISO-8601）" })
  createdAt: Date;

  @ApiProperty({ description: "最后更新时间（ISO-8601）" })
  updatedAt: Date;
}

/**
 * GET /projects 分页信封（**仅当**请求携带 page/pageSize 时返回）。
 *
 * 形状对齐 common/dto/pagination.dto.ts 的 `paginate()`（与 tasks/users 列表
 * 同款，含 R-21 遗留的 list/items 双键——收敛单键是跨包破坏面，另轮处理）。
 * 不传分页参数时该端点仍返回**全量数组**（旧契约，acf-cli/mcp-server/项目
 * 选择器按数组解析，零改动）——双形态在 controller 注释里说明。
 */
export class ProjectListPageDto {
  @ApiProperty({
    type: [ProjectViewDto],
    description: "分页行（items 的 legacy 别名）",
  })
  list: ProjectViewDto[];

  @ApiProperty({
    type: [ProjectViewDto],
    description: "分页行",
  })
  items: ProjectViewDto[];

  @ApiProperty({ description: "可见项目总数" })
  total: number;

  @ApiProperty({ description: "当前页（从 1 开始）" })
  page: number;

  @ApiProperty({ description: "每页条数（限制在 1..100）" })
  pageSize: number;

  @ApiProperty({ description: "总页数" })
  totalPages: number;
}

/** GET /projects/:id/members 的单行（ProjectMemberView 的可生成版本）。 */
export class ProjectMemberViewDto {
  @ApiProperty({ description: "成员关系行 ID（uuid）" })
  id: string;

  @ApiProperty({ description: "项目 ID（uuid）" })
  projectId: string;

  @ApiProperty({ description: "用户 ID" })
  userId: number;

  @ApiProperty({
    enum: ["viewer", "editor", "admin"],
    description: "授予该成员的角色",
  })
  role: string;

  @ApiProperty({ description: "成员关系创建时间（ISO-8601）" })
  createdAt: Date;

  /**
   * 身份补全三态（2026-10-23）：有值 = 该用户；`null` = 用户已被删除（成员行
   * 因无 FK 残留）；**键缺席** = 补全不可用（用户服务未接线或查询失败）。
   * 前端据此分别显示「用户名」「用户 #N（已删除）」「#N」，绝不编造用户名。
   */
  @ApiPropertyOptional({
    nullable: true,
    description: "用户名；null = 用户已被删除，缺席 = 身份补全不可用",
  })
  username?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "邮箱；与 username 同三态语义",
  })
  email?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "属主账号是否启用（禁用账号的成员行仍存在，但已无法登录）",
  })
  userActive?: boolean | null;
}

/**
 * GET /projects/:id/removal-impact —— 删除影响面预览（PROJECT-IMPACT-01）。
 *
 * 为什么需要它：项目删除走 FK `ON DELETE SET NULL`，任务不会消失、cron 照旧
 * 触发，但 `projectId` 被静默置空后会被 `ProjectAccessService.resolveRole`
 * 按**默认项目**判定（`projectId ?? DEFAULT_PROJECT_ID`）——原本靠「项目 editor」
 * 身份才能改的任务，删项目后对非 ADMIN 变成「看得见但改不动」。这个后果在
 * 界面上完全看不出来，只能在确认框里如实告知。
 *
 * 与本仓既有约定同构：`application.service.describeRemovalImpact`（P0-3）、
 * `executor.service.describeRemovalImpact`（DEEP-AUDIT B·1.1）。
 *
 * 注意**没有** applicationCount：applications/executors/executor_packages 三表
 * 虽然都有 `projectId` 列，但 `CreateApplicationDto` / `UpdateApplicationDto` /
 * 执行器 DTO 里**都没有 projectId 字段**，运行期无任何写入口能把它们挂到某个
 * 项目下（列恒为 NULL）。给一个永远为 0 的字段会让确认框写出
 * 「删除后 0 个应用回到未分配」这种看似精确、实则毫无信息量的废话。
 */
export class ProjectRemovalImpactResponseDto {
  @ApiProperty({ description: "项目名称（确认框标题回显）" })
  projectName: string;

  @ApiProperty({
    description:
      "该项目下未软删除的任务数（status != deleted）。这些任务删除后会退回「未分配」视图",
  })
  taskCount: number;

  @ApiProperty({
    description:
      "其中处于 active 状态的任务数——删除后仍会被 cron 触发，是真正会持续产生副作用的那部分",
  })
  activeTaskCount: number;

  @ApiProperty({
    description: "项目成员关系行数（删除时由 FK ON DELETE CASCADE 一并清除）",
  })
  memberCount: number;

  @ApiProperty({
    description:
      "是否可删；默认项目恒为 false（remove 会返回 404 PROJECT_DEFAULT_IMMUTABLE）",
  })
  deletable: boolean;
}

/**
 * GET /projects/:id/summary —— 项目详情统计的单行「最近失败」记录。
 *
 * 字段与 metrics.service.getRecentFailures 的投影对齐（执行行上冗余的
 * taskName 直接带出，免二次回表 tasks）；`failureReason`/`errorMessage`/
 * `duration` 均可空，前端按三态渲染，不编造。
 */
export class ProjectSummaryRecentFailureDto {
  @ApiProperty({ description: "执行记录 ID（uuid）" })
  id: string;

  @ApiProperty({ description: "所属任务 ID（uuid）" })
  taskId: string;

  @ApiProperty({ description: "执行时快照的任务名" })
  taskName: string;

  @ApiProperty({
    enum: [
      "pending",
      "running",
      "success",
      "failed",
      "timeout",
      "killed",
      "cancelled",
      "package_fetch_failed",
    ],
    description: "执行终态状态",
  })
  status: string;

  @ApiPropertyOptional({
    nullable: true,
    description: "失败成因标签（失败/超时行有值，其余为 null）",
  })
  failureReason?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "失败错误信息（截断后的可读文本；无则 null）",
  })
  errorMessage?: string | null;

  @ApiProperty({ description: "执行创建时间（ISO-8601）" })
  createdAt: Date;

  @ApiPropertyOptional({
    nullable: true,
    description: "执行耗时（毫秒）；未跑完/合成行为 null",
  })
  duration?: number | null;
}

/** GET /projects/:id/summary —— 单行「最近活动」执行记录（不限终态）。 */
export class ProjectSummaryRecentExecutionDto {
  @ApiProperty({ description: "执行记录 ID（uuid）" })
  id: string;

  @ApiProperty({ description: "所属任务 ID（uuid）" })
  taskId: string;

  @ApiProperty({ description: "执行时快照的任务名" })
  taskName: string;

  @ApiProperty({
    enum: [
      "pending",
      "running",
      "success",
      "failed",
      "timeout",
      "killed",
      "cancelled",
      "package_fetch_failed",
    ],
    description: "执行状态",
  })
  status: string;

  @ApiProperty({ description: "执行创建时间（ISO-8601）" })
  createdAt: Date;

  @ApiPropertyOptional({
    nullable: true,
    description: "执行耗时（毫秒）；未跑完/合成行为 null",
  })
  duration?: number | null;
}

/**
 * GET /projects/:id/summary —— 项目详情统计（P1-2 闭环）。
 *
 * ## 取数口径（每项可在界面上核对，禁止补假统计）
 *
 * - `taskCount`：tasks 表按 `projectId` 归属，**排除** `status = deleted`
 *   （软删任务对用户不可见，计入会报出界面上数不出来的数字，与
 *   removal-impact 同口径）。默认项目额外纳入 `projectId IS NULL` 的未分配行
 *   （与 task.service 的 `projectId="default"` 视图一致）。
 * - `applicationCount`：applications 表按 `projectId` 归属；默认项目同样纳入
 *   NULL 行。**注意**：当前应用写入口（Create/UpdateApplicationDto）尚未开放
 *   projectId 字段，该列在运行期实际恒为 NULL——非默认项目此计数预期为 0，
 *   这是真实查询结果而非占位；默认项目的 NULL 应用计入本视图。
 * - `memberCount`：project_members 成员关系行数。
 * - `executionsLast7d`：task_executions 经 `taskId` 关联 tasks，按任务归属统计
 *   近 7 天（`createdAt >= now - 7d`）的执行数；窗口内无执行记 0。
 * - `failedExecutionsLast7d` / `timeoutExecutionsLast7d`：同一窗口内的**分桶明细**——
 *   `status = failed` / `status = timeout` 各自的行数。两桶**不要相加**：用户要看的是
 *   「脚本失败」与「超时」各多少，合并会让 timeout 这个字段失去意义。
 * - `failureRate`：窗口内 `(failed + timeout) / executionsLast7d`（百分比，保留两位小数）。
 *   分子取 `FAILED_EXECUTION_STATUSES`（= FAILED ∪ TIMEOUT）——这是**已宣示的产品口径**：
 *   admin-web `locales/zh.ts:1479` 逐字写着「失败 = 失败 + 超时（人工终止不计入失败率）」。
 *   ⚠️ 因此 **`failureRate` 不等于 `failedExecutionsLast7d / executionsLast7d`**：
 *   后者只含 FAILED 桶，前者是两桶合并。这个「不等」是**契约而非缺陷**，别把它「修正」
 *   回去——两者相等会让超时风暴时的失败率漏报（回调上报的 timeout 落 TIMEOUT 桶）。
 *   **窗口内无执行时为 null**——前端显示「暂无数据」，不渲染 0%。
 * - `recentFailures`：该项目任务下最近 5 条失败/超时执行（不限 7 天窗口，
 *   按 createdAt DESC）；`recentExecutions`：最近 5 条执行（不限终态）。
 *   列表为空时返回空数组，前端渲染空态。
 */
export class ProjectSummaryResponseDto {
  @ApiProperty({ description: "项目 ID（uuid）" })
  projectId: string;

  @ApiProperty({ description: "项目名称（详情页标题回显）" })
  projectName: string;

  @ApiProperty({
    description:
      "未软删除的任务数（排除 status=deleted；默认项目含未分配 NULL 行）",
  })
  taskCount: number;

  @ApiProperty({
    description:
      "归属本项目的应用数（按 applications.projectId；默认项目含 NULL 行。当前应用写入口尚未开放项目归属，非默认项目预期为 0）",
  })
  applicationCount: number;

  @ApiProperty({ description: "项目成员关系行数" })
  memberCount: number;

  @ApiProperty({
    description: "近 7 天执行数（经 taskId 关联 tasks.projectId 统计）",
  })
  executionsLast7d: number;

  @ApiProperty({
    description: "近 7 天失败执行数（status=failed，分桶明细，不含 timeout）",
  })
  failedExecutionsLast7d: number;

  @ApiProperty({
    description: "近 7 天超时执行数（status=timeout，分桶明细，不含 failed）",
  })
  timeoutExecutionsLast7d: number;

  @ApiPropertyOptional({
    nullable: true,
    description:
      "近 7 天失败率 =（failed + timeout）/ 执行总数，百分比保留两位；分子按已宣示口径「失败 = 失败 + 超时」合并，故**不等于** failedExecutionsLast7d / executionsLast7d（那两个字段是分桶明细）；窗口内无执行为 null，前端显示暂无数据",
  })
  failureRate: number | null;

  @ApiProperty({
    type: [ProjectSummaryRecentFailureDto],
    description: "最近 5 条失败/超时执行（按 createdAt DESC，不限 7 天窗口）",
  })
  recentFailures: ProjectSummaryRecentFailureDto[];

  @ApiProperty({
    type: [ProjectSummaryRecentExecutionDto],
    description: "最近 5 条执行（按 createdAt DESC，不限终态与窗口）",
  })
  recentExecutions: ProjectSummaryRecentExecutionDto[];
}

/**
 * GET /projects/me/roles 的响应。
 *
 * 字段按 `projects.controller.ts:myRoles` 的**实际返回**逐一对齐（查证后修正了
 * 我最初臆测的 `{roles: {projectId: role}}` 映射形态——实际是三元结构
 * `{userId, isAdmin, memberships[]}`，memberships 复用成员视图）。
 * 这类"文档按想象写"的漂移比没有 schema 更坏：前端会照错误结构写代码。
 */
export class MyProjectRolesDto {
  @ApiPropertyOptional({
    nullable: true,
    description: "调用方用户 ID；请求未携带用户时为 null",
  })
  userId: number | null;

  @ApiProperty({
    description: "调用方为 ADMIN 时为 true（admin-web 据此渲染全部项目）",
  })
  isAdmin: boolean;

  @ApiProperty({
    type: [ProjectMemberViewDto],
    description: "调用方在所有项目中的成员关系行",
  })
  memberships: ProjectMemberViewDto[];
}
