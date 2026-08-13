import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

export enum ExecutorStatus {
  ONLINE = "online",
  OFFLINE = "offline",
}
export enum ExecutorType {
  PYTHON = "python",
  NODE = "node",
  UNIVERSAL = "universal",
}

@Entity("executors")
@Index(["status"])
@Index(["groupName"])
@Index(["lastHeartbeat"])
export class Executor {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Column() appName: string;
  @Column() address: string;
  @Column({
    type: "enum",
    enum: ExecutorStatus,
    default: ExecutorStatus.OFFLINE,
  })
  status: ExecutorStatus;
  @Column({ type: "enum", enum: ExecutorType, default: ExecutorType.PYTHON })
  type: ExecutorType;
  @Column({ nullable: true }) version: string;
  @Column({ type: "simple-array", nullable: true }) capabilities: string[];
  @Column({ nullable: true }) lastHeartbeat: Date;
  @Column({ nullable: true }) executorStartedAt: Date | null;
  @Column({ nullable: true }) executorStartupId: string | null;
  @Column({ type: "int", default: 0 }) runningTaskCount: number;
  @Column({ type: "float", nullable: true }) cpuUsage: number;
  @Column({ type: "float", nullable: true }) memUsage: number;

  /** Extended performance metrics */
  @Column({ type: "float", nullable: true }) diskUsage: number;
  @Column({ type: "float", nullable: true }) networkLatency: number;
  @Column({ type: "int", default: 0 }) totalTaskCount: number;
  @Column({ type: "int", default: 0 }) failedTaskCount: number;

  /** Max concurrent tasks this executor may run simultaneously (null = unlimited). */
  @Column({ type: "int", nullable: true }) maxConcurrentTasks: number | null;
  /**
   * SEC-03: per-executor token stored as bcrypt hash.
   * Rotated via POST /api/executors/:id/rotate-token.
   */
  @Column({ nullable: true, select: false }) tokenHash: string | null;

  /** Executor group name for logical grouping. */
  @Column({ nullable: true }) groupName: string | null;

  /** Executor tags for flexible filtering and routing. */
  @Column({ type: "simple-array", nullable: true }) tags: string[] | null;

  /** Executor description. */
  @Column({ type: "text", nullable: true }) description: string | null;

  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}
