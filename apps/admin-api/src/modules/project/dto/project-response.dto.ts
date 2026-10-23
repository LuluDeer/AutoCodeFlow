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
