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
@Index("IDX_executor_metrics_history_executor_created", [
  "executorId",
  "createdAt",
])
export class ExecutorMetricsHistory {
  @PrimaryGeneratedColumn("uuid") id: string;

  @Column() executorAddress: string;

  /**
   * ADR-017 阶段 3 复查补口（「相关轨道」第 3 条）：执行器**行身份**。
   *
   * 为什么必须补这一列：本表此前**只有** `executorAddress`。ADR-017 §5 允许
   * pull 模式同址多行（各自成行、地址只是标签），于是同址多行的 24h 趋势曲线
   * 在物理上无法拆分——不是查询少写了一个谓词，而是数据面缺一列（生产实证
   * 2026-10-22：6 台全 pull 的机队里有 2 个地址发生过指纹变更/DHCP 复用）。
   *
   * `NULL` = 迁移前的历史行（无法回填：地址→行在多行下有歧义，与迁移
   * 1790000000055 不回填 `task_executions.executorId` 的理由同源）。读面因此
   * 采用「行身份优先 + 该行身份为空时按地址回落」的谓词，保证历史曲线不断档。
   */
  @Column({ type: "uuid", nullable: true }) executorId: string | null;

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
