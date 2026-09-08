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

  @CreateDateColumn() createdAt: Date;

  @UpdateDateColumn() updatedAt: Date;

  @OneToMany("Task", "application")
  tasks: Task[];
}
