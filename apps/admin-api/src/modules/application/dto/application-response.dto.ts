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
  @ApiProperty({ description: "应用 ID（uuid）" })
  id: string;

  @ApiProperty({ description: "唯一应用名称" })
  name: string;

  @ApiPropertyOptional({
    nullable: true,
    description: "人类可读描述",
  })
  description: string | null;

  @ApiProperty({ description: "应用版本" })
  version: string;

  @ApiProperty({ description: "运行时标识（node / python / shell …）" })
  runtime: string;

  @ApiProperty({ description: "生命周期状态" })
  status: string;

  @ApiPropertyOptional({
    nullable: true,
    description: "Git 仓库 URL",
  })
  gitRepo: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "Git 分支",
  })
  gitBranch: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "锁定的 git commit",
  })
  gitCommit: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: Object,
    description: "部署清单（jsonb）",
  })
  manifest: Record<string, unknown> | null;

  @ApiPropertyOptional({
    nullable: true,
    type: Object,
    example: { LOG_LEVEL: "info", DB_PASSWORD: "***" },
    description: "环境变量映射；secret 类键在所有读面均被掩码为 ***",
  })
  env: Record<string, string> | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "入口点路径",
  })
  entrypoint: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "包下载 URL",
  })
  packageUrl: string | null;

  @ApiProperty({ description: "部署是否需要审批" })
  approvalRequired: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description: "所属项目 ID（null = 默认项目视图）",
  })
  projectId: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "MUTEX-01：互斥组 ID（null = 该应用不参与按设备互斥）",
  })
  mutexGroupId: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "属主用户 ID",
  })
  ownerUserId: number | null;

  @ApiProperty({ description: "创建时间（ISO-8601）" })
  createdAt: Date;

  @ApiProperty({ description: "最后更新时间（ISO-8601）" })
  updatedAt: Date;

  @ApiPropertyOptional({
    nullable: true,
    description:
      "R7 实测出现性：create/update 等 save() 回程把 select:false 列 hydrated 成 null 带出；findAll/findById select 读取不含该键。值恒 null（secret 不回传）。首版头注的『不声明』裁定据此修订",
  })
  webhookSecret?: string | null;
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
      "失去代码来源的任务数（全量统计，不按页截断 —— DEEP-AUDIT B·4.1）",
  })
  tasksLosingSource: number;

  @ApiProperty({ description: "随级联删除的部署行数" })
  deploymentCount: number;

  @ApiProperty({ description: "磁盘上已上传的包文件是否会被删除" })
  packageFileWillBeDeleted: boolean;
}

/** POST /applications/webhook —— CI/CD 版本发布回调（@Public + HMAC）。 */
export class ReleaseWebhookResponseDto {
  @ApiProperty({ enum: [true] })
  ok: true;

  @ApiProperty({ type: ApplicationResponseDto })
  updatedApp: ApplicationResponseDto;

  @ApiProperty({
    description: "triggerDeploy=true 时被升级的 RUNNING 部署数；否则为 0",
  })
  triggeredDeployments: number;
}

/** GET /applications/:id/versions —— 版本历史行（快照行 + legacy 部署行合并）。 */
export class ApplicationVersionHistoryRowDto {
  @ApiProperty({
    nullable: true,
    format: "uuid",
    description: "application_versions.id；null = 由 legacy 部署派生的行",
  })
  id: string | null;

  @ApiProperty({
    nullable: true,
    format: "uuid",
    description: "legacy 行携带部署 ID",
  })
  deploymentId: string | null;

  @ApiProperty({ nullable: true, format: "uuid" })
  sourceDeploymentId: string | null;

  @ApiProperty({
    nullable: true,
    description: "legacy 行回退到 '__unknown__' 桶键",
  })
  version: string | null;

  @ApiProperty({ nullable: true })
  commit: string | null;

  @ApiProperty({ description: "快照状态或 legacy 部署状态" })
  status: string;

  @ApiProperty({
    nullable: true,
    description: "快照行使用版本创建时间",
  })
  deployedAt: Date | null;

  @ApiProperty({ nullable: true })
  createdAt: Date | null;

  @ApiProperty({
    nullable: true,
    description: "legacy 行携带该部署的执行器；快照行留为 null",
  })
  executorAddress: string | null;

  @ApiProperty({
    description: "该版本的部署次数（同版本多实例滚动分别单独计数）",
  })
  deployCount: number;

  @ApiProperty({
    nullable: true,
    additionalProperties: true,
    description: "已掩码的版本快照（读面）；legacy 行为 null",
  })
  snapshot: Record<string, unknown> | null;
}

/** R3-A（§4.3）：版本行的设备徽标（设备心跳上报的事实聚合，见 AppReleaseDevice）。 */
export class AppReleaseDeviceDto {
  @ApiProperty({ description: "执行器行 id" })
  executorId: string;

  @ApiProperty({
    nullable: true,
    description: "执行器可读名（executors.appName）；行已删/未上报名时 null",
  })
  executorName: string | null;

  @ApiProperty({
    nullable: true,
    description:
      "该设备该应用 current 指向的版本（保留场景下可能与本行版本不同）",
  })
  currentVersion: string | null;

  @ApiProperty({
    description: "本行版本 ∈ 设备 retainedVersions（设备磁盘仍持有该版本）",
  })
  retained: boolean;

  @ApiProperty({
    description: "executors.status === ONLINE（离线设备的版本事实可能已过期）",
  })
  online: boolean;

  @ApiProperty({
    nullable: true,
    description: "executors.lastHeartbeat（设备最后上报时刻，ISO）",
  })
  lastHeartbeat: string | null;
}

/** GET /applications/:id/releases —— DEP-01 统一发布追溯：一行 = 一次版本发布。 */
export class AppReleaseRowDto {
  @ApiProperty({
    nullable: true,
    format: "uuid",
    description: "application_versions.id；null = 纯部署历史（无快照行）",
  })
  id: string | null;

  @ApiProperty({ nullable: true })
  version: string | null;

  @ApiProperty({
    nullable: true,
    description: "快照中的 packageUrl（部署时刻的值 —— 不回退到应用当前 URL）",
  })
  packageUrl: string | null;

  @ApiProperty({ nullable: true })
  gitCommit: string | null;

  @ApiProperty({
    nullable: true,
    description: "最近一次部署完成时间（ISO 字符串 —— 本视图做了字符串化）",
  })
  deployedAt: string | null;

  @ApiProperty({ nullable: true, format: "uuid" })
  latestDeploymentId: string | null;

  @ApiProperty({
    nullable: true,
    enum: ["pending", "deploying", "running", "stopped", "failed", "upgrading"],
  })
  deploymentStatus: string | null;

  @ApiProperty({ description: "该版本的部署次数" })
  deploymentCount: number;

  @ApiProperty({ nullable: true })
  executorAddress: string | null;

  @ApiProperty({ nullable: true, enum: ["once", "daemon", "scheduled"] })
  runMode: string | null;

  @ApiProperty({
    nullable: true,
    enum: ["manual", "upgrade", "rollback", "approval", "unknown"],
    description: "优先取持久化列，legacy 行推导得出（无法判定时为 unknown）",
  })
  triggerType: string | null;

  @ApiProperty({
    nullable: true,
    description: "取 deployments.operator，回退到 versions.createdBy",
  })
  operator: string | null;

  @ApiProperty({
    enum: ["deployments.operator", "application_versions.createdBy"],
  })
  operatorSource: "deployments.operator" | "application_versions.createdBy";

  @ApiProperty({
    description: "operator 为 null 时的原因（RELEASE_OPERATOR_MISSING_REASON）",
  })
  operatorMissingReason: string;

  @ApiProperty({
    type: () => [AppReleaseDeviceDto],
    description:
      "R3-A（§4.3）：正在运行或本地保留该版本的设备（设备心跳上报事实；无设备上报时为空数组）。deploymentStatus/executorAddress 等字段仍是部署行推断（渐进迁移），设备真实状态以本字段为准。响应字段只增不改",
  })
  devices: AppReleaseDeviceDto[];
}

/** GET /applications/:id/releases 信封（裸四键 + truncated，非 paginate() 双键形态）。 */
export class AppReleasesResponseDto {
  @ApiProperty({ type: [AppReleaseRowDto] })
  data: AppReleaseRowDto[];

  @ApiProperty()
  total: number;

  @ApiProperty()
  page: number;

  @ApiProperty({ description: "默认 50，上限 200" })
  pageSize: number;

  @ApiProperty({
    description:
      "R4（§4.7）：synthetic 聚合扫描到达 5000 行上限（聚合以已扫描部分为准，可能不完整）时 true；未到上限或非第 1 页恒 false。响应字段只增不改",
  })
  truncated: boolean;

  @ApiProperty({
    type: [String],
    description:
      "P8-R（部署模型评审遗留）：truncated=true 吞掉被截版本的 devices 徽标时，列出「有设备保留（currentVersion 命中或 ∈ retainedVersions）但不在本页返回行中」的版本号（字母序）；truncated=false 恒空数组。响应字段只增不改",
  })
  retainedButTruncated: string[];
}

/** POST /applications/:id/sync-tasks —— manifest.json 任务注册回执。 */
export class SyncTasksResponseDto {
  @ApiProperty({ enum: [true] })
  ok: true;

  @ApiProperty({ description: "本次同步注册的任务定义数量" })
  registeredCount: number;
}

/** POST /applications/:id/analyze —— AI 应用健康分析。 */
export class AppHealthAnalysisResponseDto {
  @ApiProperty({ format: "uuid" })
  appId: string;

  @ApiProperty()
  appName: string;

  @ApiProperty({
    description: "AI 评估文本（空字符串 = AI 不可用，fail-open 放行）",
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
