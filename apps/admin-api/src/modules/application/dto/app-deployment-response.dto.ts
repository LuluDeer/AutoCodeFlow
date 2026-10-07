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
    description:
      "Parent application (masked read surface — env secrets are '***')",
    type: ApplicationResponseDto,
  })
  application?: ApplicationResponseDto;

  @ApiProperty({ description: "Executor address the app runs on" })
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
    description: "Git commit when deployed from git source",
    nullable: true,
  })
  deployedCommit: string | null;

  @ApiProperty({
    description: "Version actually deployed (upgrade/rollback rewrites it)",
    nullable: true,
  })
  deployedVersion: string | null;

  @ApiProperty({
    description: "Launch command snapshot (rollback/upgrade may rewrite it)",
    nullable: true,
  })
  startCommand: string | null;

  @ApiProperty({
    description: "Deploy-time env snapshot, MASKED on every read surface (QA1)",
    nullable: true,
    additionalProperties: { type: "string" },
  })
  env: Record<string, string> | null;

  @ApiProperty({
    description: "App process pid on the executor (heartbeat-maintained)",
    nullable: true,
  })
  pid: number | null;

  @ApiProperty({
    description: "Last executor heartbeat for this deployment",
    nullable: true,
  })
  lastHeartbeat: Date | null;

  @ApiProperty({
    description:
      "Last state transition message (stall/dup-deploy guards write here)",
    nullable: true,
  })
  statusMessage: string | null;

  @ApiProperty({
    description: "Most recent deployment completion time",
    nullable: true,
  })
  deployedAt: Date | null;

  @ApiProperty({
    description: "Canary rollout phase (DEP-02); null = not part of a batch",
    nullable: true,
    enum: ["pending", "probing", "promoted", "failed", "rolled_back"],
  })
  rolloutState: string | null;

  @ApiProperty({
    description: "Canary batch metadata (batchId/canaryIds/leasedBy...)",
    nullable: true,
    additionalProperties: true,
  })
  rolloutMeta: Record<string, unknown> | null;

  @ApiProperty({
    description:
      "DEP-04 second-person approval state; null = approval not required",
    nullable: true,
    enum: ["pending_approval", "approved", "rejected"],
  })
  approvalStatus: string | null;

  @ApiProperty({
    description: "Approval trail (actor/reason/timestamps)",
    nullable: true,
    additionalProperties: true,
  })
  approvalMeta: Record<string, unknown> | null;

  @ApiProperty({
    description:
      "Trigger semantics (FEAT-20 persisted column); null = legacy row",
    nullable: true,
    enum: ["manual", "upgrade", "rollback", "approval"],
  })
  triggerType: string | null;

  @ApiProperty({
    description: "JWT username of the operator (FEAT-20)",
    nullable: true,
  })
  operator: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiProperty({
    description: "Optimistic-lock @VersionColumn (TypeORM version column)",
  })
  version: number;
}

/** GET /app-deployments 与 GET /app-deployments/approvals/pending 共用——裸 {data,total}。 */
export class PaginatedAppDeploymentsDto {
  @ApiProperty({ type: [AppDeploymentResponseDto] })
  data: AppDeploymentResponseDto[];

  @ApiProperty()
  total: number;
}

/** DELETE /app-deployments/:id —— 只接受终态行（failed/stopped），其余 409。 */
export class DeploymentRemoveResponseDto {
  @ApiProperty({ enum: [true] })
  ok: true;

  @ApiProperty({ description: "The removed deployment id" })
  deletedId: string;
}

/** POST /applications/:id/upgrade-all（DEP-02 灰度/全量升级的批次回执）。 */
export class UpgradeAllResponseDto {
  @ApiProperty({
    description:
      "false = canary batch rejected (ARCH-31 in-flight mutual exclusion) or all failed",
  })
  ok: boolean;

  @ApiPropertyOptional({
    description:
      "版本定向灰度时回显实际目标版本（快照恢复后的 app.version）；缺省（latest）不带",
  })
  version?: string;

  @ApiProperty({ description: "Running deployments at trigger time" })
  total: number;

  @ApiProperty()
  succeeded: number;

  @ApiProperty()
  failed: number;

  @ApiPropertyOptional({
    description:
      "Present when a canary batch was actually started (or blocked)",
    type: "object",
    properties: {
      batchId: { type: "string" },
      strategy: { type: "string", enum: ["canary", "all"] },
      canaryIds: { type: "array", items: { type: "string", format: "uuid" } },
      promotedIds: { type: "array", items: { type: "string", format: "uuid" } },
      blockedReason: {
        type: "string",
        description:
          "ARCH-31: in-flight batch on the same app (cross-instance mutual exclusion, not an exception)",
      },
    },
    required: ["batchId", "strategy", "canaryIds", "promotedIds"],
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
    description: "Spread of the triggered upgrade-all batch receipt",
  })
  rollout?: UpgradeAllResponseDto;

  @ApiProperty({
    description:
      "Version the app was rolled back to (deployedVersion for legacy path)",
  })
  rolledBackTo: string | null;

  @ApiProperty({
    description:
      "application_versions.id when the snapshot path was taken; null = legacy deployment-row path",
    nullable: true,
    format: "uuid",
  })
  versionId: string | null;

  @ApiPropertyOptional({
    description: "Only on the legacy path (always false there — R16)",
  })
  packageUrlRestored?: boolean;

  @ApiProperty({
    type: ApplicationResponseDto,
    description: "The restored application row (masked)",
  })
  updatedApp: ApplicationResponseDto;
}
