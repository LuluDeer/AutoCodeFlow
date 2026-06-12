import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
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

@Entity("app_deployments")
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

  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}
