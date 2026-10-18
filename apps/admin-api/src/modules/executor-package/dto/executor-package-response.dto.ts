import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/**
 * ARCH-23 / N-12：执行器包管理面**响应体 DTO**。
 *
 * 与 Application / Project 同因：实体无 `@ApiProperty` → 直接标 `type:` 会 emit
 * 空壳 schema（前端生成 `Record<string, never>`，且 PK-15 闸红）。
 *
 * **为什么显式列字段而不是照抄实体全部列**：实体有一个
 * `filePath`（注释写明 "Absolute file path on the server"，varchar(1024)），
 * `findAll`/`findOne` 都是**直接返回实体**，故该字段**真的会进响应体**。
 * 本控制器是类级 `@Roles(ADMIN)`，泄漏面仅限管理员（不是对不可信用户的泄漏，
 * 故不是安全缺陷）——但它仍**不该进对外契约文档**：契约是给第三方照写的，
 * 写一个服务器绝对路径字段会诱导消费方去依赖它（那些路径在换部署/换盘后必然失效），
 * 且把内部目录结构固化成"承诺"。故 DTO 排除 `filePath`，
 * 并在字段注释里说明"下载请走 `/executor-packages/:id/download`"。
 *
 * 同时排除 `pushHistory` 的**内嵌**形态复杂性：它是有类型的数组，如实声明。
 */
export class ExecutorPackagePushRecordDto {
  @ApiProperty({ description: "目标执行器 ID" })
  executorId: string;

  @ApiProperty({
    enum: ["downloaded", "failed"],
    description: "推送结果",
  })
  status: string;

  @ApiProperty({ description: "所推送的包版本" })
  version: string;

  @ApiPropertyOptional({ description: "status=failed 时的失败原因" })
  error?: string;

  @ApiProperty({ description: "本次推送尝试的时间（ISO-8601）" })
  timestamp: string;
}

export class ExecutorPackageResponseDto {
  @ApiProperty({ description: "包 ID（uuid）" })
  id: string;

  @ApiProperty({ description: "包名称" })
  name: string;

  @ApiProperty({ description: "包版本" })
  version: string;

  @ApiProperty({ description: "包类型（runtime/tooling 分类）" })
  type: string;

  @ApiPropertyOptional({
    nullable: true,
    description: "目标平台（包与平台无关时为 null）",
  })
  platform: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "存储文件名",
  })
  filename: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "上传时的原始文件名",
  })
  originalFilename: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "MIME 类型",
  })
  mimeType: string | null;

  @ApiProperty({ description: "字节数" })
  fileSize: number;

  @ApiPropertyOptional({
    nullable: true,
    description: "SHA-256 校验和",
  })
  checksum: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "描述",
  })
  description: string | null;

  @ApiProperty({ description: "生命周期状态（active / deprecated / …）" })
  status: string;

  @ApiPropertyOptional({
    nullable: true,
    description: "上传者身份",
  })
  uploadedBy: string | null;

  @ApiPropertyOptional({
    type: [ExecutorPackagePushRecordDto],
    description: "对各执行器的推送尝试记录",
  })
  pushHistory: ExecutorPackagePushRecordDto[];

  @ApiPropertyOptional({
    nullable: true,
    description: "所属项目 ID（null = 默认项目视图）",
  })
  projectId: string | null;

  @ApiProperty({ description: "创建时间（ISO-8601）" })
  createdAt: Date;

  @ApiProperty({ description: "最后更新时间（ISO-8601）" })
  updatedAt: Date;

  // 注意：**不声明 filePath**——见类头注（服务器绝对路径不进对外契约）。
  // 下载走 GET /executor-packages/:id/download（服务端解析路径，不由客户端拼）。
}

/**
 * GET /executor-packages 的列表包装。
 *
 * PLAN-BACKEND-ARCHITECTURE §2.1（游标分页·加性过渡）：本类**只新增**了可选的
 * `nextCursor`，既有 `items` / `total` 的名字与类型一个都没动。
 *
 * 为什么**不**改造成 `paginate()` 信封（`{list,items,total,page,pageSize,totalPages}`）：
 * `items`/`total` 有真实消费方（`apps/admin-web/src/api/executor-packages.ts` 的
 * `list()` 与 `listLatest()`，前者喂包表分页、后者喂安装向导的「最新可用包」），
 * 换信封会让 `res.items` 变 undefined ⇒ 包表恒空、安装向导取不到任何包。
 * 那是破坏性变更，故本轮只做加性扩展（与审计端点同款取舍）。
 *
 * `nextCursor` 的**出现条件**：请求带 `cursor` 时才出现（字符串 = 下一页，
 * `null` = 已到末页）；不带 `cursor` 走 OFFSET 分支，该键**根本不出现**。
 * 故它是 `@ApiPropertyOptional` 而不是必填 + nullable——契约必须能表达
 * "键可能不存在"，否则与 OFFSET 分支的真实响应不符。
 */
export class ExecutorPackageListDto {
  @ApiProperty({
    type: [ExecutorPackageResponseDto],
    description: "包分页",
  })
  items: ExecutorPackageResponseDto[];

  @ApiProperty({ description: "匹配的包总数（分页前）" })
  total: number;

  /**
   * 仅当请求带 `cursor` 时出现（keyset 分支）：`null` = 已到末页。
   *
   * 游标绑定本端点固定排序 `createdAt DESC, id DESC`；载荷里的 id 是包表的
   * uuid 主键（子查询按主键取库内 `createdAt` 原值，零精度损失）。
   */
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      "keyset 分页的下一页游标；null = 已到末页。仅当请求带 cursor 参数时出现（此时走 keyset 分支）；不带 cursor 的请求走 OFFSET 分支，响应中不含该键。",
  })
  nextCursor?: string | null;
}

// ── ARCH-23 / N-12（2026-10-07 A2 批补）：push 面 + Registry + Artifacts ──

/** POST /executor-packages/{id}/push —— 逐台推送结果行。 */
export class ExecutorPushResultDto {
  @ApiProperty({ format: "uuid" })
  executorId: string;

  @ApiProperty()
  address: string;

  @ApiProperty({
    enum: ["queued", "success", "error"],
    description:
      "queued=已入 pull 命令队列；success=push 同步 accepted；error=失败",
  })
  status: "queued" | "success" | "error";

  @ApiPropertyOptional({
    format: "uuid",
    description: "queued 时回填中台命令 ID（终态由 push-result 回调收敛）",
  })
  commandId?: string;

  @ApiPropertyOptional({ description: "error 时的失败原因" })
  error?: string;
}

/** GET /registry/{pypi,npm}/packages —— 上游索引包名清单（registry.controller）。 */
export class RegistryPackagesResponseDto {
  @ApiProperty({
    type: [String],
    description:
      "Package names parsed from the upstream index (empty = upstream reachable but no packages; upstream 5xx/401 会被压成空 200——前端错误态依赖此形状)",
  })
  packages: string[];
}

/** POST /registry/pypi/upload —— 代理上传回执。 */
export class RegistryUploadResponseDto {
  @ApiProperty()
  success: boolean;
}

/** 任务执行工件清单行（task_executions.artifacts jsonb 元素形态，artifacts.controller）。 */
export class ExecutionArtifactDto {
  @ApiProperty()
  name: string;

  @ApiProperty({ description: "字节" })
  size: number;

  @ApiProperty({ description: "对存储字节计算的 sha256" })
  sha256: string;
}

/** PUT /executions/{execId}/artifacts/{name} —— 执行器回传入账回执。 */
export class ArtifactUploadResponseDto {
  @ApiProperty({ enum: [true] })
  ok: true;

  @ApiProperty()
  name: string;

  @ApiProperty({ description: "字节" })
  size: number;

  @ApiProperty()
  sha256: string;
}
