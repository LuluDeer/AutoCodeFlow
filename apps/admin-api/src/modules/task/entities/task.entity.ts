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

export enum TaskStatus {
  ACTIVE = "active",
  PAUSED = "paused",
  DELETED = "deleted",
}
export enum BlockStrategy {
  SERIAL = "serial",
  DISCARD = "discard",
  COVER_EARLY = "cover_early",
}

export enum TaskPriority {
  LOW = 1,
  NORMAL = 2,
  HIGH = 3,
  CRITICAL = 4,
}
export enum ExecuteMode {
  SINGLE = "single",
  BROADCAST = "broadcast",
}
export enum MisfireStrategy {
  IGNORE = "ignore",
  FIRE_ONCE = "fire_once",
}
export enum TaskTriggerType {
  CRON = "cron",
  FIXED_RATE = "fixed_rate",
  API = "api",
  MANUAL = "manual",
}
export enum TaskRuntime {
  PYTHON = "python",
  NODE = "node",
  SHELL = "shell",
}

@Entity("tasks")
@Index(["status"])
@Index(["applicationId"])
@Index(["createdAt"])
export class Task {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Column() name: string;
  @Column({ nullable: true }) description: string;
  @Column({ type: "enum", enum: TaskStatus, default: TaskStatus.ACTIVE })
  status: TaskStatus;
  @Column({ type: "enum", enum: TaskTriggerType }) triggerType: TaskTriggerType;
  @Column({ nullable: true }) cronExpression: string;
  @Column({ nullable: true }) timezone: string;
  @Column({ nullable: true }) fixedRate: number;
  @Column({ type: "enum", enum: TaskRuntime, default: TaskRuntime.PYTHON })
  runtime: TaskRuntime;
  @Column({ nullable: true }) runtimeVersion: string;
  @Column({ type: "jsonb", nullable: true }) dependencies: Record<
    string,
    string
  >;
  @Column({ nullable: true }) entrypoint: string;
  @Column({ nullable: true }) gitRepo: string;
  @Column({ nullable: true }) gitBranch: string;
  @Column({ nullable: true }) gitCommit: string;
  @Column({ nullable: true }) currentVersion: string;
  @Column({ type: "int", default: 0 }) timeout: number;
  @Column({ type: "int", default: 3 }) maxRetry: number;
  @Column({ type: "int", default: 0 }) retryDelay: number;
  @Column({ type: "simple-array", nullable: true }) retryableErrors: string[];
  @Column({ type: "enum", enum: BlockStrategy, default: BlockStrategy.SERIAL })
  blockStrategy: BlockStrategy;
  @Column({
    type: "enum",
    enum: MisfireStrategy,
    default: MisfireStrategy.IGNORE,
  })
  misfireStrategy: MisfireStrategy;
  @Column({ type: "enum", enum: TaskPriority, default: TaskPriority.NORMAL })
  priority: TaskPriority;
  @Column({ type: "enum", enum: ExecuteMode, default: ExecuteMode.SINGLE })
  executeMode: ExecuteMode;
  @Column({ nullable: true }) lastTriggerTime: Date;
  @Column({ nullable: true }) alarmEmail: string;
  @Column({ type: "simple-array", nullable: true }) alarmChannels: string[];
  @Column({ type: "jsonb", nullable: true }) params: Record<string, any>;
  @Column({ nullable: true }) executorAppName: string;
  @Column({ nullable: true }) applicationId: string;

  @ManyToOne("Application", "tasks", { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "applicationId" })
  application: { id: string; name: string; version: string } | null;

  /** Executor group to use for this task. */
  @Column({ nullable: true }) executorGroup: string | null;

  /** Executor tags required for this task. */
  @Column({ type: "simple-array", nullable: true }) executorTags:
    | string[]
    | null;

  /** Glue script: source code editable in the admin UI (XXL-JOB GLUE mode). */
  @Column({ type: "text", nullable: true }) glueSource: string | null;

  /** Language of the glue script: python, javascript, shell. */
  @Column({ nullable: true }) glueLanguage: string | null;

  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}
