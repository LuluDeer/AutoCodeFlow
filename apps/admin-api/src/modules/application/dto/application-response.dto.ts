import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/**
 * ARCH-23 / N-12：应用读面**响应体 DTO**。
 *
 * ## 为什么不能直接标 `type: Application`（实体）
 *
 * 实体类没有 `@ApiProperty` 装饰器，@nestjs/swagger 只会 emit
 * `{type:'object', properties:{}}` —— 一个**空壳 schema**。后果有两层：
 *   ① 前端 `gen:api-types` 生成出 `Record<string, never>`，**比没有类型更坏**
 *      （看着有类型，实际一个字段都写不了）；
 *   ② CI 既有的 PK-15 空 schema 守卫会直接打红（本仓实测踩过：
 *      commit 74afb6f8 的 api-types-drift job 因此失败）。
 * 故必须落成带 `@ApiProperty` 的 DTO。
 *
 * ## 为什么不用 `PickType(Application, ...)`
 *
 * `@nestjs/swagger` 的 PickType 需要源类有 swagger 元数据；实体没有，
 * 映射结果同样为空。故显式声明字段——**顺带把 `webhookSecret` 排除在外**：
 * 它是 `select: false` 的 HMAC 密钥，即便实际响应因 `select:false` 不会带出，
 * 也不该出现在**对外契约文档**里（契约是给第三方照着写的，写明一个永不返回的
 * 密钥字段只会误导）。字段与 `ApplicationService.maskReadSurface` 的输出对齐：
 * `env` 的 secret 类键在读面被掩码为 `***`。
 */
export class ApplicationResponseDto {
  @ApiProperty({ description: "Application id (uuid)" })
  id: string;

  @ApiProperty({ description: "Unique application name" })
  name: string;

  @ApiPropertyOptional({ description: "Human description", nullable: true })
  description: string | null;

  @ApiProperty({ description: "Application version" })
  version: string;

  @ApiProperty({ description: "Runtime identifier (node / python / shell …)" })
  runtime: string;

  @ApiProperty({ description: "Lifecycle status" })
  status: string;

  @ApiPropertyOptional({ description: "Git repository URL", nullable: true })
  gitRepo: string | null;

  @ApiPropertyOptional({ description: "Git branch", nullable: true })
  gitBranch: string | null;

  @ApiPropertyOptional({ description: "Pinned git commit", nullable: true })
  gitCommit: string | null;

  @ApiPropertyOptional({
    description: "Deployment manifest (jsonb)",
    nullable: true,
    type: Object,
  })
  manifest: Record<string, unknown> | null;

  @ApiPropertyOptional({
    description:
      "Environment map; secret-class keys are masked as *** on every read surface",
    nullable: true,
    type: Object,
    example: { LOG_LEVEL: "info", DB_PASSWORD: "***" },
  })
  env: Record<string, string> | null;

  @ApiPropertyOptional({ description: "Entrypoint path", nullable: true })
  entrypoint: string | null;

  @ApiPropertyOptional({ description: "Package download URL", nullable: true })
  packageUrl: string | null;

  @ApiProperty({ description: "Whether deployment requires approval" })
  approvalRequired: boolean;

  @ApiPropertyOptional({
    description: "Owning project id (null = default project view)",
    nullable: true,
  })
  projectId: string | null;

  @ApiPropertyOptional({
    description:
      "MUTEX-01: mutex group id (null = app does not participate in per-device mutual exclusion)",
    nullable: true,
  })
  mutexGroupId: string | null;

  @ApiPropertyOptional({ description: "Owner user id", nullable: true })
  ownerUserId: number | null;

  @ApiProperty({ description: "Creation time (ISO-8601)" })
  createdAt: Date;

  @ApiProperty({ description: "Last update time (ISO-8601)" })
  updatedAt: Date;

  // 注意：**不声明 webhookSecret**——见类头注。
}

// ── ARCH-23 / N-12（2026-10-07 批）：Application Management 其余端点契约 ──
// 上批只覆盖了 findAll/findById/create/update（4/18）；本批补齐其余 10 端点
// + mutex-groups 4 端点的注解引用。

/** GET /applications/:id/removal-impact —— 删除影响面预览（确认框如实告知）。 */
export class RemovalImpactResponseDto {
  @ApiProperty()
  applicationName: string;

  @ApiProperty({
    description:
      "Tasks losing their code source (ALL-RUN total, not page-truncated — DEEP-AUDIT B·4.1)",
  })
  tasksLosingSource: number;

  @ApiProperty({ description: "Deployments removed by cascade" })
  deploymentCount: number;

  @ApiProperty({
    description: "Whether the uploaded package file on disk is deleted",
  })
  packageFileWillBeDeleted: boolean;
}

/** POST /applications/webhook —— CI/CD 版本发布回调（@Public + HMAC）。 */
export class ReleaseWebhookResponseDto {
  @ApiProperty({ enum: [true] })
  ok: true;

  @ApiProperty({ type: ApplicationResponseDto })
  updatedApp: ApplicationResponseDto;

  @ApiProperty({
    description:
      "Count of RUNNING deployments upgraded when triggerDeploy=true; 0 otherwise",
  })
  triggeredDeployments: number;
}

/** GET /applications/:id/versions —— 版本历史行（快照行 + legacy 部署行合并）。 */
export class ApplicationVersionHistoryRowDto {
  @ApiProperty({
    description:
      "application_versions.id; null = legacy deployment-derived row",
    nullable: true,
    format: "uuid",
  })
  id: string | null;

  @ApiProperty({
    description: "Legacy rows carry the deployment id",
    nullable: true,
    format: "uuid",
  })
  deploymentId: string | null;

  @ApiProperty({ nullable: true, format: "uuid" })
  sourceDeploymentId: string | null;

  @ApiProperty({
    description: "Legacy rows fall back to '__unknown__' bucket key",
    nullable: true,
  })
  version: string | null;

  @ApiProperty({ nullable: true })
  commit: string | null;

  @ApiProperty({ description: "Snapshot status or legacy deployment status" })
  status: string;

  @ApiProperty({
    description: "Snapshot rows use the version creation time",
    nullable: true,
  })
  deployedAt: Date | null;

  @ApiProperty({ nullable: true })
  createdAt: Date | null;

  @ApiProperty({
    description:
      "Legacy rows carry the deployment's executor; snapshot rows leave null",
    nullable: true,
  })
  executorAddress: string | null;

  @ApiProperty({
    description:
      "Deploy count for this version (same-version multi-instance rolls count individually)",
  })
  deployCount: number;

  @ApiProperty({
    description: "Masked version snapshot (read surface); null on legacy rows",
    nullable: true,
    additionalProperties: true,
  })
  snapshot: Record<string, unknown> | null;
}

/** GET /applications/:id/releases —— DEP-01 统一发布追溯：一行 = 一次版本发布。 */
export class AppReleaseRowDto {
  @ApiProperty({
    description:
      "application_versions.id; null = pure deployment history (no snapshot row)",
    nullable: true,
    format: "uuid",
  })
  id: string | null;

  @ApiProperty({ nullable: true })
  version: string | null;

  @ApiProperty({
    description:
      "Snapshot packageUrl (deploy-time value — does NOT fall back to the app's current URL)",
    nullable: true,
  })
  packageUrl: string | null;

  @ApiProperty({ nullable: true })
  gitCommit: string | null;

  @ApiProperty({
    description:
      "Most recent deployment completion (ISO string — this view stringifies)",
    nullable: true,
  })
  deployedAt: string | null;

  @ApiProperty({ nullable: true, format: "uuid" })
  latestDeploymentId: string | null;

  @ApiProperty({
    nullable: true,
    enum: ["pending", "deploying", "running", "stopped", "failed", "upgrading"],
  })
  deploymentStatus: string | null;

  @ApiProperty({ description: "Deploy count for this version" })
  deploymentCount: number;

  @ApiProperty({ nullable: true })
  executorAddress: string | null;

  @ApiProperty({ nullable: true, enum: ["once", "daemon", "scheduled"] })
  runMode: string | null;

  @ApiProperty({
    description:
      "Persisted column first, legacy rows derive (unknown when undecidable)",
    nullable: true,
    enum: ["manual", "upgrade", "rollback", "approval", "unknown"],
  })
  triggerType: string | null;

  @ApiProperty({
    description: "Deployments.operator, falling back to versions.createdBy",
    nullable: true,
  })
  operator: string | null;

  @ApiProperty({
    enum: ["deployments.operator", "application_versions.createdBy"],
  })
  operatorSource: "deployments.operator" | "application_versions.createdBy";

  @ApiProperty({
    description:
      "Why operator is null when it is (RELEASE_OPERATOR_MISSING_REASON)",
  })
  operatorMissingReason: string;
}

/** GET /applications/:id/releases 信封（裸四键，非 paginate() 双键形态）。 */
export class AppReleasesResponseDto {
  @ApiProperty({ type: [AppReleaseRowDto] })
  data: AppReleaseRowDto[];

  @ApiProperty()
  total: number;

  @ApiProperty()
  page: number;

  @ApiProperty({ description: "Default 50, capped 200" })
  pageSize: number;
}

/** POST /applications/:id/sync-tasks —— manifest.json 任务注册回执。 */
export class SyncTasksResponseDto {
  @ApiProperty({ enum: [true] })
  ok: true;

  @ApiProperty({ description: "Task definitions registered by this sync" })
  registeredCount: number;
}

/** POST /applications/:id/analyze —— AI 应用健康分析。 */
export class AppHealthAnalysisResponseDto {
  @ApiProperty({ format: "uuid" })
  appId: string;

  @ApiProperty()
  appName: string;

  @ApiProperty({
    description:
      "AI assessment text (empty string = AI unavailable, fail-open)",
  })
  analysis: string;

  @ApiProperty({
    type: "object",
    properties: {
      totalTasks: { type: "number" },
      avgSuccessRate: { type: "number" },
      avgDuration: { type: "number" },
      criticalTasks: { type: "array", items: { type: "string" } },
    },
    required: ["totalTasks", "avgSuccessRate", "avgDuration", "criticalTasks"],
  })
  stats: {
    totalTasks: number;
    avgSuccessRate: number;
    avgDuration: number;
    criticalTasks: string[];
  };
}
