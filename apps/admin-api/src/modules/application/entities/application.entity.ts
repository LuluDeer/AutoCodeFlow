import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
} from "typeorm";
import { Task } from "../../task/entities/task.entity";

export enum ApplicationStatus {
  ACTIVE = "active",
  DEPLOYING = "deploying",
  FAILED = "failed",
}

@Entity("applications")
@Index(["status"])
@Index(["createdAt"])
export class Application {
  @PrimaryGeneratedColumn("uuid") id: string;

  @Column({ unique: true }) name: string;

  @Column({ nullable: true }) description: string;

  @Column() version: string;

  @Column() runtime: string;

  @Column({
    type: "enum",
    enum: ApplicationStatus,
    default: ApplicationStatus.ACTIVE,
  })
  status: ApplicationStatus;

  @Column({ nullable: true }) gitRepo: string;

  @Column({ nullable: true }) gitBranch: string;

  @Column({ nullable: true }) gitCommit: string;

  @Column({ type: "jsonb", nullable: true }) manifest: Record<string, any>;

  @Column({ type: "jsonb", nullable: true }) env: Record<string, string>;

  @Column({ nullable: true }) entrypoint: string;

  @Column({ nullable: true }) packageUrl: string;

  /**
   * DEP-04: when true, deploy() freezes new deployments as pending-approval
   * rows instead of dispatching; a second person (≠ requester) must approve
   * via the approval endpoints before the push happens.
   */
  @Column({ default: false }) approvalRequired: boolean;

  /**
   * Optional HMAC-SHA256 secret for verifying release webhook signatures.
   * When set, callers must include an X-Hub-Signature-256 header.
   * Format: sha256=<hex-digest> (same convention as GitHub webhooks).
   */
  @Column({ nullable: true, select: false }) webhookSecret: string;

  /**
   * AUTH-01（多租户 Project，第一批）：应用归属项目（可空）。迁移
   * 1790000000009 加列 + FK ON DELETE SET NULL + 索引。存量行不回填——
   * 可空 = 未分配，列表过滤面按「IS NULL OR = 默认项目」归入默认项目
   * 视图（application.service.findAll）。只加列不加关系，避免与
   * project 模块循环导入。
   */
  @Column({ type: "uuid", nullable: true })
  projectId: string | null;

  /**
   * NF-03（任务级 RBAC 预研）：创建者用户 id。语义与 tasks.ownerUserId
   * 一致（NULL=无主仅 ADMIN 可改；写面守卫 application.service.assertCanWrite；
   * 不加 FK，悬垂 id=非本人 → 403 方向安全）。
   */
  @Column({ type: "integer", nullable: true })
  ownerUserId: number | null;

  @CreateDateColumn() createdAt: Date;

  @UpdateDateColumn() updatedAt: Date;

  @OneToMany("Task", "application")
  tasks: Task[];
}
