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
  /**
   * P2: stale sweep 赢得 RUNNING→FAILED 条件 UPDATE 时写入的可溯源标记——
   * 区别于执行器回调上报的 UNKNOWN，便于排查"worker 崩溃型故障 + sweep 兑现
   * 重试预算"的链路。命名沿用既有 snake_case 约定（对齐 executor_restart）。
   */
  STALE_RECOVERED = "stale_recovered",
  /** BUG-10 细化：依赖安装失败（npm install / uv pip install / uv venv） */
  DEPENDENCY_INSTALL_FAILED = "dependency_install_failed",
  /** BUG-10 细化：Git clone/fetch/checkout 失败（区别于包拉取） */
  GIT_FETCH_FAILED = "git_fetch_failed",
  /** BUG-10 细化：运行时/可执行文件不可用（spawn ENOENT、uv 缺失） */
  RUNTIME_MISSING = "runtime_missing",
  KILLED = "killed",
  UNKNOWN = "unknown",
}

/**
 * FEAT-05：单个执行产物（artifact）的清单条目。执行器在任务工作目录下约定
 * `artifacts/` 收集文件，任务结束回调随清单（name/size/sha256）上报，文件字节
 * 单独 PUT 上传到 admin 的 uploads/artifacts/<execId>/ 目录。清单是 best-effort
 * ——收集/上传失败绝不阻塞任务终态。
 */
export interface ExecutionArtifact {
  name: string;
  size: number;
  sha256: string;
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
  /**
   * 改动2（可观测性补齐）：执行器回调上报的原始进程退出码（nullable=未上报）。
   * failureReason 是由 errorMessage/logs/exitCode 推断的分类，本列保留原始
   * 退出码用于失败溯源；幂等迁移见 migrations/1788800000000-AddExecutionExitCode.ts。
   */
  @Column({ type: "int", nullable: true }) exitCode: number | null;
  @Column({ type: "text", nullable: true }) aiAnalysis: string;
  /**
   * FEAT-05: 执行产物清单（见 ExecutionArtifact）。nullable=无产物/未上报。
   * 幂等迁移见 migrations/1789600000000-AddExecutionArtifacts.ts。
   */
  @Column({ type: "jsonb", nullable: true })
  artifacts: ExecutionArtifact[] | null;
  @Column({ nullable: true }) triggerType: string;
  @Column({ nullable: true }) taskVersion: string;
  @CreateDateColumn() createdAt: Date;

  /** R-P0-007: Optimistic lock version for preventing concurrent updates */
  @VersionColumn() version: number;
}
