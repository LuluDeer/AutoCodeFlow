import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ApplicationResponseDto } from "./application-response.dto";

/**
 * ARCH-23 / N-12：应用部署域（tag "App Deployment"）响应体 DTO——11 端点
 * 此前 0/11 有 schema。字段与 AppDeploymentService 实际返回逐一对齐：
 * 全部读写面经 maskDeploymentForRead（行 env 与嵌套 application.env 同批
 * 掩码，QA1——兄弟 GET 不能旁路应用读面的掩码）。
 * 口径：findAll 是**裸 {data,total} 分页**（无页元数据，与 /sop 同形态）；
 * 写端点（deploy/approve/reject/cancel/upgrade/stop）POST 无 @HttpCode →
 * 实际 201（历史上直觉是 200，按实际落契约）。
 */

/** app_deployments 行的响应形态（含 application 关系——列表与详情都加载）。 */
export class AppDeploymentResponseDto {
  @ApiProperty({ format: "uuid" })
  id: string;

  @ApiProperty({ format: "uuid" })
  applicationId: string;

  @ApiPropertyOptional({
    type: ApplicationResponseDto,
    description: "父应用（已掩码读面 —— env 中的 secret 为 '***'）",
  })
  application?: ApplicationResponseDto;

  @ApiProperty({ description: "该应用运行所在执行器的地址" })
  executorAddress: string;

  @ApiProperty({ nullable: true, format: "uuid" })
  executorId: string | null;

  @ApiProperty({
    enum: ["pending", "deploying", "running", "stopped", "failed", "upgrading"],
  })
  status:
    "pending" | "deploying" | "running" | "stopped" | "failed" | "upgrading";

  @ApiProperty({ enum: ["once", "daemon", "scheduled"] })
  runMode: "once" | "daemon" | "scheduled";

  @ApiProperty({
    nullable: true,
    description: "从 git 源部署时的 git commit",
  })
  deployedCommit: string | null;

  @ApiProperty({
    nullable: true,
    description: "实际部署的版本（升级/回滚会改写它）",
  })
  deployedVersion: string | null;

  @ApiProperty({
    nullable: true,
    description: "启动命令快照（回滚/升级可能改写它）",
  })
  startCommand: string | null;

  @ApiProperty({
    nullable: true,
    additionalProperties: { type: "string" },
    description: "部署时刻的 env 快照，在所有读面均被掩码（QA1）",
  })
  env: Record<string, string> | null;

  @ApiProperty({
    nullable: true,
    description: "应用进程在执行器上的 pid（由心跳维护）",
  })
  pid: number | null;

  @ApiProperty({
    nullable: true,
    description: "该部署对应的最近一次执行器心跳",
  })
  lastHeartbeat: Date | null;

  @ApiProperty({
    nullable: true,
    description: "最近一次状态跃迁消息（停滞/重复部署防护在此写入）",
  })
  statusMessage: string | null;

  @ApiProperty({
    nullable: true,
    description: "最近一次部署完成时间",
  })
  deployedAt: Date | null;

  @ApiProperty({
    nullable: true,
    enum: ["pending", "probing", "promoted", "failed", "rolled_back"],
    description: "金丝雀发布阶段（DEP-02）；null = 不属于任何批次",
  })
  rolloutState: string | null;

  @ApiProperty({
    nullable: true,
    additionalProperties: true,
    description: "金丝雀批次元数据（batchId/canaryIds/leasedBy...）",
  })
  rolloutMeta: Record<string, unknown> | null;

  @ApiProperty({
    nullable: true,
    enum: ["pending_approval", "approved", "rejected"],
    description: "DEP-04 第二人审批状态；null = 无需审批",
  })
  approvalStatus: string | null;

  @ApiProperty({
    nullable: true,
    additionalProperties: true,
    description: "审批轨迹（操作者/原因/时间戳）",
  })
  approvalMeta: Record<string, unknown> | null;

  @ApiProperty({
    nullable: true,
    enum: ["manual", "upgrade", "rollback", "approval"],
    description: "触发语义（FEAT-20 持久化列）；null = legacy 行",
  })
  triggerType: string | null;

  @ApiProperty({
    nullable: true,
    description: "操作者的 JWT 用户名（FEAT-20）",
  })
  operator: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiProperty({ description: "乐观锁 @VersionColumn（TypeORM 版本列）" })
  version: number;
}

/** GET /app-deployments 与 GET /app-deployments/approvals/pending 共用——裸 {data,total}。 */
export class PaginatedAppDeploymentsDto {
  @ApiProperty({ type: [AppDeploymentResponseDto] })
  data: AppDeploymentResponseDto[];

  @ApiProperty()
  total: number;
}

/**
 * GET /app-deployments/stats —— 应用列表页的部署统计（每应用一行）。
 *
 * 存在理由：该页此前对每个应用各发一个列表请求来现算「运行 X/Y 台」，
 * 26 个应用 = 26 个请求共享同一个 60/min 限流桶 → 整页 429（生产实证
 * 2026-10-13）。聚合到一次查询后，页面无论多少应用都只发 1 个请求。
 *
 * 字段口径与原前端「拉全量再 filter」逐项对齐，见 service.findStats 注释。
 */
export class AppDeploymentStatsDto {
  @ApiProperty({ format: "uuid" })
  applicationId: string;

  @ApiProperty({ description: "该应用全部部署行数（含 stopped/failed）" })
  total: number;

  @ApiProperty({ description: "status='running' 的部署行数" })
  running: number;

  @ApiProperty({ description: "status='failed' 的部署行数" })
  failed: number;

  @ApiProperty({
    nullable: true,
    description:
      "最近一次部署活动时间（MAX(deployedAt ?? createdAt)）；该应用无部署行为 null",
  })
  lastDeployedAt: string | null;
}

/** DELETE /app-deployments/:id —— 只接受终态行（failed/stopped），其余 409。 */
export class DeploymentRemoveResponseDto {
  @ApiProperty({ enum: [true] })
  ok: true;

  @ApiProperty({ description: "被删除的部署 ID" })
  deletedId: string;
}

/** R2（§4.4）：upgrade-all 响应的覆盖面分组计数（按部署行状态）。 */
export class UpgradeAllCoverageDto {
  @ApiProperty({
    description:
      "RUNNING 且 runMode≠scheduled 的行数（活进程语义：daemon/once）",
  })
  running: number;

  @ApiProperty({
    description:
      "RUNNING 且 runMode=scheduled 的行数（仅部署待触发——实证口径：scheduled 部署完成即上报 running，行稳态就是 RUNNING，默认与 running 一并覆盖）",
  })
  scheduled: number;

  @ApiProperty({
    description:
      "STOPPED 行数（仅 includeStopped=true 时纳入升级；计数恒回显）",
  })
  stopped: number;

  @ApiProperty({ description: "FAILED 行数（恒排除，应走显式重新部署）" })
  failed: number;

  @ApiProperty({
    description:
      "pending/deploying/upgrading 在途行数（恒跳过，逐行进 skipped 明细）",
  })
  inFlight: number;
}

/** R2（§4.4）：upgrade-all 跳过明细——在途行不抛错，逐行给出原因。 */
export class UpgradeAllSkippedItemDto {
  @ApiProperty({ format: "uuid" })
  deploymentId: string;

  @ApiProperty({ nullable: true, format: "uuid" })
  executorId: string | null;

  @ApiProperty({ enum: ["pending", "deploying", "upgrading"] })
  status: string;

  @ApiProperty({
    enum: ["in_flight", "awaiting_approval"],
    description:
      "in_flight=在途部署/升级不可重入；awaiting_approval=待审批行（DEP-04，复用 pending 占坑）",
  })
  reason: string;
}

/** POST /applications/:id/upgrade-all（DEP-02 灰度/全量升级的批次回执）。 */
export class UpgradeAllResponseDto {
  @ApiProperty({
    description: "false = 金丝雀批次被拒绝（ARCH-31 在途互斥）或全部失败",
  })
  ok: boolean;

  @ApiPropertyOptional({
    description:
      "版本定向灰度时回显实际目标版本（快照恢复后的 app.version）；缺省（latest）不带",
  })
  version?: string;

  @ApiProperty({ description: "触发时刻运行中的部署数" })
  total: number;

  @ApiProperty()
  succeeded: number;

  @ApiProperty()
  failed: number;

  /**
   * R2（§4.4）：覆盖面分组计数——upgrade-all 本体恒返回；optional 仅因
   * ApplicationRollbackResponseDto.rollout 复用本类型（deprecated rollback 走
   * upgradeRunningDeployments，不带该字段——「只增不改」约束下不能给它加形状）。
   */
  @ApiPropertyOptional({
    type: UpgradeAllCoverageDto,
    description:
      "该应用部署行按状态分组的计数（R2 §4.4）。running+scheduled 为默认覆盖面；stopped 仅 includeStopped=true 时升级；failed 恒排除；inFlight 恒跳过",
  })
  coverage?: UpgradeAllCoverageDto;

  @ApiPropertyOptional({
    type: [UpgradeAllSkippedItemDto],
    description:
      "在途行（pending/deploying/upgrading）的跳过明细——不抛错，逐行给出原因（R2 §4.4）",
  })
  skipped?: UpgradeAllSkippedItemDto[];

  @ApiPropertyOptional({
    type: "object",
    properties: {
      batchId: { type: "string" },
      strategy: { type: "string", enum: ["canary", "all"] },
      canaryIds: { type: "array", items: { type: "string", format: "uuid" } },
      promotedIds: { type: "array", items: { type: "string", format: "uuid" } },
      blockedReason: {
        type: "string",
        description: "ARCH-31：同一应用上存在在途批次（跨实例互斥，不是异常）",
      },
    },
    required: ["batchId", "strategy", "canaryIds", "promotedIds"],
    description: "在实际启动了金丝雀批次（或被阻塞）时出现",
  })
  rollout?: {
    batchId: string;
    strategy: "canary" | "all";
    canaryIds: string[];
    promotedIds: string[];
    blockedReason?: string;
  };
}

/**
 * POST /applications/:id/rollback/:deploymentId —— 应用回滚 = 版本快照恢复 +
 * 在途实例滚动升级。rolledBackTo/versionId/packageUrlRestored 的存在性随路径
 * 不同：快照路径给 versionId（packageUrlRestored 缺省）、legacy 部署行路径给
 * packageUrlRestored:false 且 versionId:null（R16：legacy 无法恢复 packageUrl）。
 */
export class ApplicationRollbackResponseDto {
  @ApiProperty()
  ok: boolean;

  @ApiProperty()
  total: number;

  @ApiProperty()
  succeeded: number;

  @ApiProperty()
  failed: number;

  @ApiPropertyOptional({
    type: UpgradeAllResponseDto,
    description: "透传所触发的 upgrade-all 批次回执",
  })
  rollout?: UpgradeAllResponseDto;

  @ApiProperty({
    description: "应用回滚到的版本（legacy 路径下取 deployedVersion）",
  })
  rolledBackTo: string | null;

  @ApiProperty({
    nullable: true,
    format: "uuid",
    description:
      "走快照路径时为 application_versions.id；null = 走了 legacy 部署行路径",
  })
  versionId: string | null;

  @ApiPropertyOptional({
    description: "仅在 legacy 路径下出现（该路径下恒为 false —— R16）",
  })
  packageUrlRestored?: boolean;

  @ApiProperty({
    type: ApplicationResponseDto,
    description: "恢复后的应用行（已掩码）",
  })
  updatedApp: ApplicationResponseDto;
}

/**
 * R1（2026-10-24 部署模型评审 §4.2）：POST /applications/:id/set-current-version
 * ——只按版本快照恢复应用当前字段，绝不触碰部署行/设备。
 */
export class SetCurrentVersionResponseDto {
  @ApiProperty()
  ok: boolean;

  @ApiProperty({
    description: "恒 false——本端点不下发任何设备（下发走 deploy-version）",
  })
  dispatched: boolean;

  @ApiProperty({ description: "恢复后的应用 version（= 快照 version）" })
  version: string;

  @ApiProperty({
    format: "uuid",
    description: "命中的 application_versions.id",
  })
  versionId: string;

  @ApiProperty({
    type: ApplicationResponseDto,
    description: "恢复后的应用行（已掩码）",
  })
  updatedApp: ApplicationResponseDto;
}

/** deploy-version 响应：成功进入下发链的部署行。 */
export class DeployVersionUpgradedEntryDto {
  @ApiProperty({ format: "uuid" })
  deploymentId: string;

  @ApiProperty({
    nullable: true,
    format: "uuid",
    description: "部署行所在执行器（行无执行器时 null）",
  })
  executorId: string | null;

  @ApiProperty({ nullable: true })
  executorAddress: string | null;
}

/** deploy-version 响应：被跳过的执行器/部署行（业务明细，非错误）。 */
export class DeployVersionSkippedEntryDto {
  @ApiProperty({
    nullable: true,
    format: "uuid",
    description: "显式点名路径下恒有值；缺省（全 RUNNING）路径下取部署行值",
  })
  executorId: string | null;

  @ApiProperty({ nullable: true, format: "uuid" })
  deploymentId: string | null;

  @ApiProperty({
    enum: ["no_deployment", "not_running", "upgrade_rejected"],
    description:
      "no_deployment=该执行器在本应用下没有部署行；not_running=最新部署行状态非 running（detail 带实际 status）；upgrade_rejected=upgrade 链拒绝（detail 带原因）",
  })
  reason: string;

  @ApiPropertyOptional({
    nullable: true,
    description: "跳过原因的机器可读补充（状态值 / 原始错误消息）",
  })
  detail?: string | null;
}

/**
 * R1（2026-10-24 部署模型评审 §4.2）：POST /applications/:id/deploy-version
 * ——字段恢复 + 下发（缺省全部 RUNNING 行；显式 executorIds 按执行器点名，
 * 无行/不可下发的进 skipped，不报错）。
 */
export class DeployVersionResponseDto {
  @ApiProperty()
  ok: boolean;

  @ApiProperty({
    description: "恒 true——本端点就是下发动作（恢复+下发）",
  })
  dispatched: boolean;

  @ApiProperty({ description: "本次下发的目标版本（= 快照 version）" })
  version: string;

  @ApiProperty({
    format: "uuid",
    description: "命中的 application_versions.id",
  })
  versionId: string;

  @ApiProperty({ type: [DeployVersionUpgradedEntryDto] })
  upgraded: DeployVersionUpgradedEntryDto[];

  @ApiProperty({ type: [DeployVersionSkippedEntryDto] })
  skipped: DeployVersionSkippedEntryDto[];

  @ApiProperty({
    type: ApplicationResponseDto,
    description: "恢复后的应用行（已掩码）",
  })
  updatedApp: ApplicationResponseDto;
}
