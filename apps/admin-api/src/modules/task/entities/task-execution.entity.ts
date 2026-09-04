import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  VersionColumn,
} from "typeorm";
import { Task } from "./task.entity";

export enum ExecutionStatus {
  PENDING = "pending",
  RUNNING = "running",
  SUCCESS = "success",
  FAILED = "failed",
  TIMEOUT = "timeout",
  KILLED = "killed",
  CANCELLED = "cancelled",
}

export enum ExecutionFailureReason {
  PACKAGE_FETCH_FAILED = "package_fetch_failed",
  SCRIPT_ERROR = "script_error",
  TIMEOUT = "timeout",
  EXECUTOR_OFFLINE = "executor_offline",
  EXECUTOR_RESTART = "executor_restart",
  KILLED = "killed",
  UNKNOWN = "unknown",
}

@Entity("task_executions")
@Index(["taskId"])
@Index(["status"])
@Index(["taskId", "status"])
@Index(["createdAt"])
@Index("idx_task_executions_executor_address_status", [
  "executorAddress",
  "status",
])
@Index("idx_task_executions_running", ["executorAddress", "startTime"], {
  where: "\"status\" = 'running'",
})
export class TaskExecution {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Column() taskId: string;
  @Column() taskName: string;
  @Column({
    type: "enum",
    enum: ExecutionStatus,
    default: ExecutionStatus.PENDING,
  })
  status: ExecutionStatus;

  @ManyToOne("Task", "taskExecutions", { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "taskId" })
  task: Task | null;
  @Column({ nullable: true }) executorAddress: string;
  @Column({ type: "text", nullable: true }) logs: string;
  /** Where the detailed log lives: 'db' (execution_log_lines) or 's3' object. */
  @Column({ type: "varchar", nullable: true, default: "db" })
  logStorage: string | null;
  /** Gzipped object key when logStorage === 's3'. */
  @Column({ type: "varchar", nullable: true }) logObjectKey: string | null;
  @Column({ type: "jsonb", nullable: true }) result: Record<string, any>;
  @Column({ type: "jsonb", nullable: true }) params: Record<string, any>;
  @Column({ nullable: true }) startTime: Date;
  @Column({ nullable: true }) endTime: Date;
  @Column({ nullable: true }) duration: number;
  @Column({ type: "int", default: 0 }) retryCount: number;
  @Column({ nullable: true }) errorMessage: string;
  @Column({ type: "varchar", nullable: true })
  failureReason: ExecutionFailureReason | null;
  @Column({ type: "text", nullable: true }) aiAnalysis: string;
  @Column({ nullable: true }) triggerType: string;
  @Column({ nullable: true }) taskVersion: string;
  @CreateDateColumn() createdAt: Date;

  /** R-P0-007: Optimistic lock version for preventing concurrent updates */
  @VersionColumn() version: number;
}
