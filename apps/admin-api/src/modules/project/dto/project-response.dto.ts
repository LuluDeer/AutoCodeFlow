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
  @ApiProperty({ description: "Project id (uuid)" })
  id: string;

  @ApiProperty({ description: "Project name" })
  name: string;

  @ApiPropertyOptional({ description: "Description", nullable: true })
  description: string | null;

  @ApiProperty({ description: "Creation time (ISO-8601)" })
  createdAt: Date;

  @ApiProperty({ description: "Last update time (ISO-8601)" })
  updatedAt: Date;

  @ApiPropertyOptional({
    description:
      "Calling subject's role in this project; null for non-members. " +
      "ADMIN also gets its real member row here (honest, not synthesized).",
    nullable: true,
    enum: ["viewer", "editor", "admin"],
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
  @ApiProperty({ description: "Project id (uuid)" })
  id: string;

  @ApiProperty({ description: "Unique project name" })
  name: string;

  @ApiPropertyOptional({ description: "Description", nullable: true })
  description: string | null;

  @ApiProperty({ description: "Creation time (ISO-8601)" })
  createdAt: Date;

  @ApiProperty({ description: "Last update time (ISO-8601)" })
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
    description: "Page rows (legacy alias of items)",
    type: [ProjectViewDto],
  })
  list: ProjectViewDto[];

  @ApiProperty({ description: "Page rows", type: [ProjectViewDto] })
  items: ProjectViewDto[];

  @ApiProperty({ description: "Total visible projects" })
  total: number;

  @ApiProperty({ description: "Current page (1-based)" })
  page: number;

  @ApiProperty({ description: "Page size (clamped to 1..100)" })
  pageSize: number;

  @ApiProperty({ description: "Total pages" })
  totalPages: number;
}

/** GET /projects/:id/members 的单行（ProjectMemberView 的可生成版本）。 */
export class ProjectMemberViewDto {
  @ApiProperty({ description: "Membership row id (uuid)" })
  id: string;

  @ApiProperty({ description: "Project id (uuid)" })
  projectId: string;

  @ApiProperty({ description: "User id" })
  userId: number;

  @ApiProperty({
    description: "Role granted to this member",
    enum: ["viewer", "editor", "admin"],
  })
  role: string;

  @ApiProperty({ description: "Membership creation time (ISO-8601)" })
  createdAt: Date;
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
    description: "Calling user id; null when the request carries no user",
    nullable: true,
  })
  userId: number | null;

  @ApiProperty({
    description:
      "True when the caller is ADMIN (admin-web uses this to render all projects)",
  })
  isAdmin: boolean;

  @ApiProperty({
    description: "Membership rows for the calling user across all projects",
    type: [ProjectMemberViewDto],
  })
  memberships: ProjectMemberViewDto[];
}
