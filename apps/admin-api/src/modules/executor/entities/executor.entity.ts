import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  VersionColumn,
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
@Index("uq_executors_address", ["address"], { unique: true })
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
  @Column({ nullable: true }) executorVersion: string;
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
   * CONSISTENCY-02: executor-node 心跳上报的"当前正在执行的 executionId 列表"
   * （≤200，执行器侧裁剪）。stale 扫描据此判断 RUNNING 行是否仍在真实执行——
   * 执行器在线且上报集合包含该 executionId 时跳过本轮误判恢复，避免把回调退避
   * 重试/排队导致超阈值的正常执行误杀。
   * 语义：null = 旧版执行器未上报该字段（区别于 []：[] 表示上报了且当前空闲）。
   */
  @Column({ type: "jsonb", nullable: true })
  runningExecutionIds: string[] | null;

  /**
   * U16: executor 心跳上报的 dead-letter 积压数（回调重试死信队列长度）。
   * node 端 ab4971f 起上报、python 端 001 起上报；admin 侧经心跳白名单采纳
   * （非负整数 0..100000，非法/缺失不改 DB 值，与 maxConcurrentTasks 同模式）。
   * 语义：null = 旧版执行器未上报该字段。幂等迁移见
   * migrations/1788900000000-AddExecutorDeadLetterCount.ts。
   */
  @Column({ type: "int", nullable: true }) deadLetterCount: number | null;

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

  /**
   * AUTH-01（多租户 Project，第一批）：执行器归属项目（可空）。迁移
   * 1790000000009 加列 + FK ON DELETE SET NULL + 索引。存量行不回填——
   * 可空 = 未分配，语义上归默认项目视图。只加列不加关系（执行器注册/
   * 心跳路径不感知项目，调度面后续批次消费）。
   */
  @Column({ type: "uuid", nullable: true })
  projectId: string | null;

  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;

  /** R-P0-006: Optimistic lock version for preventing dispatch race conditions */
  @VersionColumn() version: number;
}
