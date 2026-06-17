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
