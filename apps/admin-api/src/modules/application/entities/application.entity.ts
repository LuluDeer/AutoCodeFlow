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
// MUTEX-01：挂组查询/组删除级联定位（迁移 1790000000044 同名 DDL）。
@Index("idx_applications_mutex_group", ["mutexGroupId"])
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
   * MUTEX-01（应用互斥组，迁移 1790000000044）：应用挂入的互斥组（可空）。
   * NULL = 不参与互斥——该应用的执行只受设备 maxConcurrentTasks 约束，行为
   * 与引入本特性前逐字节一致。非空时，该应用产生的执行在**同一台设备上**
   * 与同组其它应用的执行互斥（组内并发数见 MutexGroup.maxConcurrentPerDevice）。
   * 调度侧消费的是执行行上的组快照（task_executions.mutexGroupId），本列是
   * 配置事实源；组删除（FK SET NULL）后应用自动回到不参与互斥。
   */
  @Column({ type: "uuid", nullable: true })
  mutexGroupId: string | null;

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
