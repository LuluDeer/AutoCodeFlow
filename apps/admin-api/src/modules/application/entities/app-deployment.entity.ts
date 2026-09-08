import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from "typeorm";
import { Application } from "./application.entity";

export enum DeploymentStatus {
  PENDING = "pending",
  DEPLOYING = "deploying",
  RUNNING = "running",
  STOPPED = "stopped",
  FAILED = "failed",
  UPGRADING = "upgrading",
}

export enum RunMode {
  ONCE = "once",
  DAEMON = "daemon",
  SCHEDULED = "scheduled",
}

/** DEP-04：审批推进状态（approvalStatus 列）。NULL = 非审批路径。
 *  待审批行复用 status=PENDING（不扩 DeploymentStatus 枚举），因此天然被
 *  in-flight 部分唯一索引约束：同一应用至多一个待审批/在途部署。 */
export enum DeploymentApprovalStatus {
  PENDING_APPROVAL = "pending_approval",
  APPROVED = "approved",
  REJECTED = "rejected",
  CANCELLED = "cancelled",
}

/** DEP-02/DEP-03：灰度批次推进状态（rolloutState 列）。NULL = 非批次路径。 */
export enum RolloutState {
  PENDING = "pending",
  PROBING = "probing",
  PROMOTED = "promoted",
  FAILED = "failed",
  ROLLED_BACK = "rolled_back",
}

@Entity("app_deployments")
@Index(["applicationId"])
@Index(["applicationId", "status"])
@Index(["status"])
@Index("idx_app_deployments_executor_address_status", [
  "executorAddress",
  "status",
])
export class AppDeployment {
  @PrimaryGeneratedColumn("uuid") id: string;

  @Column() applicationId: string;

  @ManyToOne(() => Application, { onDelete: "CASCADE" })
  @JoinColumn({ name: "applicationId" })
  application: Application;

  /** The executor address this deployment lives on */
  @Column() executorAddress: string;

  /** Logical executor ID if known */
  @Column({ nullable: true }) executorId: string | null;

  @Column({
    type: "enum",
    enum: DeploymentStatus,
    default: DeploymentStatus.PENDING,
  })
  status: DeploymentStatus;

  @Column({ type: "enum", enum: RunMode, default: RunMode.DAEMON })
  runMode: RunMode;

  /** Git commit that is currently deployed */
  @Column({ nullable: true }) deployedCommit: string | null;

  @Column({ nullable: true }) deployedVersion: string | null;

  /** Override start command (optional, falls back to manifest entrypoint) */
  @Column({ nullable: true }) startCommand: string | null;

  /** Environment variable overrides for this deployment */
  @Column({ type: "jsonb", nullable: true }) env: Record<string, string> | null;

  /** PID reported by executor (for daemon mode) */
  @Column({ type: "int", nullable: true }) pid: number | null;

  /** Last heartbeat from executor for this running app */
  @Column({ nullable: true }) lastHeartbeat: Date | null;

  /** Human-readable progress / error message */
  @Column({ type: "text", nullable: true }) statusMessage: string | null;

  @Column({ nullable: true }) deployedAt: Date | null;

  /** DEP-02/DEP-03：灰度批次推进状态（迁移 1790000000001）。NULL=非批次路径。 */
  @Column({ type: "varchar", nullable: true }) rolloutState: string | null;

  /** DEP-02/DEP-03：批次元数据 { batchId, role, strategy, percentage,
   *  upgradedIds, failureReason?, rolledBackTo? }。 */
  @Column({ type: "jsonb", nullable: true })
  rolloutMeta: Record<string, any> | null;

  /** DEP-04：审批推进状态（迁移 1790000000002）。NULL=非审批路径。 */
  @Column({ type: "varchar", nullable: true }) approvalStatus: string | null;

  /** DEP-04：审批痕迹 { requestedBy, requestedByName, requestedAt,
   *  actedBy?, actedByName?, actedAt?, reason? }。 */
  @Column({ type: "jsonb", nullable: true })
  approvalMeta: Record<string, any> | null;

  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}
