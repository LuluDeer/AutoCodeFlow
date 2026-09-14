import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * Executor performance metrics history.
 * Stores periodic snapshots of executor health for trend analysis.
 *
 * R-09（DEEP_REVIEW 0ef3bbe）: retention 由 ExecutorService.cleanupMetricsHistory
 * 每日 cron 清理（保留期同 logRetention.days，默认 30 天）。每执行器每 30s 心跳
 * 写一行（2,880 行/天/执行器），无清理则表无限膨胀。
 */
@Entity("executor_metrics_history")
@Index(["executorAddress", "createdAt"])
export class ExecutorMetricsHistory {
  @PrimaryGeneratedColumn("uuid") id: string;

  @Column() executorAddress: string;

  @Column({ type: "float", nullable: true }) cpuUsage: number;

  @Column({ type: "float", nullable: true }) memUsage: number;

  @Column({ type: "float", nullable: true }) diskUsage: number;

  @Column({ type: "int", default: 0 }) runningTaskCount: number;

  @Column({ type: "int", default: 0 }) totalTaskCount: number;

  @Column({ type: "int", default: 0 }) failedTaskCount: number;

  @Column({ type: "float", nullable: true }) avgExecutionTime: number;

  @Column({ type: "int", default: 0 }) uptimeSeconds: number;

  @CreateDateColumn() createdAt: Date;
}
