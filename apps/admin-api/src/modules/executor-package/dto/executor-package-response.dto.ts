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
  @ApiProperty({ description: "Target executor id" })
  executorId: string;

  @ApiProperty({ description: "Push outcome", enum: ["downloaded", "failed"] })
  status: string;

  @ApiProperty({ description: "Package version pushed" })
  version: string;

  @ApiPropertyOptional({ description: "Failure reason when status=failed" })
  error?: string;

  @ApiProperty({ description: "When this push attempt happened (ISO-8601)" })
  timestamp: string;
}

export class ExecutorPackageResponseDto {
  @ApiProperty({ description: "Package id (uuid)" })
  id: string;

  @ApiProperty({ description: "Package name" })
  name: string;

  @ApiProperty({ description: "Package version" })
  version: string;

  @ApiProperty({ description: "Package type (runtime/tooling taxonomy)" })
  type: string;

  @ApiPropertyOptional({
    description: "Target platform (null when the package is platform-agnostic)",
    nullable: true,
  })
  platform: string | null;

  @ApiPropertyOptional({ description: "Stored filename", nullable: true })
  filename: string | null;

  @ApiPropertyOptional({
    description: "Original upload filename",
    nullable: true,
  })
  originalFilename: string | null;

  @ApiPropertyOptional({ description: "MIME type", nullable: true })
  mimeType: string | null;

  @ApiProperty({ description: "Size in bytes" })
  fileSize: number;

  @ApiPropertyOptional({ description: "SHA-256 checksum", nullable: true })
  checksum: string | null;

  @ApiPropertyOptional({ description: "Description", nullable: true })
  description: string | null;

  @ApiProperty({ description: "Lifecycle status (active / deprecated / …)" })
  status: string;

  @ApiPropertyOptional({ description: "Uploader identity", nullable: true })
  uploadedBy: string | null;

  @ApiPropertyOptional({
    description: "Push attempts against executors",
    type: [ExecutorPackagePushRecordDto],
  })
  pushHistory: ExecutorPackagePushRecordDto[];

  @ApiPropertyOptional({
    description: "Owning project id (null = default project view)",
    nullable: true,
  })
  projectId: string | null;

  @ApiProperty({ description: "Creation time (ISO-8601)" })
  createdAt: Date;

  @ApiProperty({ description: "Last update time (ISO-8601)" })
  updatedAt: Date;

  // 注意：**不声明 filePath**——见类头注（服务器绝对路径不进对外契约）。
  // 下载走 GET /executor-packages/:id/download（服务端解析路径，不由客户端拼）。
}

/** GET /executor-packages 的列表包装。 */
export class ExecutorPackageListDto {
  @ApiProperty({
    description: "Page of packages",
    type: [ExecutorPackageResponseDto],
  })
  items: ExecutorPackageResponseDto[];

  @ApiProperty({ description: "Total matching packages (before paging)" })
  total: number;
}

// ── ARCH-23 / N-12（2026-10-07 A2 批补）：push 面 + Registry + Artifacts ──

/** POST /executor-packages/{id}/push —— 逐台推送结果行。 */
export class ExecutorPushResultDto {
  @ApiProperty({ format: "uuid" })
  executorId: string;

  @ApiProperty()
  address: string;

  @ApiProperty({
    description:
      "queued=已入 pull 命令队列；success=push 同步 accepted；error=失败",
    enum: ["queued", "success", "error"],
  })
  status: "queued" | "success" | "error";

  @ApiPropertyOptional({
    description: "queued 时回填中台命令 ID（终态由 push-result 回调收敛）",
    format: "uuid",
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

  @ApiProperty({ description: "bytes" })
  size: number;

  @ApiProperty({ description: "sha256 over the stored bytes" })
  sha256: string;
}

/** PUT /executions/{execId}/artifacts/{name} —— 执行器回传入账回执。 */
export class ArtifactUploadResponseDto {
  @ApiProperty({ enum: [true] })
  ok: true;

  @ApiProperty()
  name: string;

  @ApiProperty({ description: "bytes" })
  size: number;

  @ApiProperty()
  sha256: string;
}
