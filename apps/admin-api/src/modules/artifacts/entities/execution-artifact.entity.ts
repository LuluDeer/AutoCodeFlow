import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from "typeorm";
import { TaskExecution } from "../../task/entities/task-execution.entity";
import { Application } from "../../application/entities/application.entity";

/**
 * ARTIFACTS-INDEX-46（部署模型评审 §4.6）：执行产物元数据索引行。
 *
 * 一行 = 某次执行清单里的一个产物（唯一 (executionId, name)）。写面与
 * task_executions.artifacts jsonb **双轨**（终态回调写点同步 upsert，TTL 清理
 * 同批 delete）；存量 jsonb 不回填（迁移 1790000000065 头注——不猜映射）。
 *
 * 读面：GET /artifacts?applicationId=&taskId=&page= 只查本表——存量执行无本表行
 * → 如实返回空（过渡期语义，见 ArtifactsService.listArtifactRows 注释）；按执行
 * 读清单的旧端点继续读 jsonb（回落路径）。
 */
@Entity("execution_artifacts")
@Index("UQ_execution_artifacts_execution_name", ["executionId", "name"], {
  unique: true,
})
// 以下两条必须与迁移 DDL 一一对应（名称/列序对齐
// migrations/1790000000065-ExecutionArtifactsIndex.ts）。生产 synchronize=false，
// 迁移是 schema 唯一来源——实体 @Index 只在显式命名且与迁移对齐时才有意义
// （同 task-execution.entity 对 NETOPT-3① 的说明）。
@Index("idx_execution_artifacts_task", ["taskId"])
@Index("idx_execution_artifacts_application", ["applicationId"])
export class ExecutionArtifactRow {
  @PrimaryGeneratedColumn("uuid") id: string;

  /** 所属执行（清单随终态回调上报，文件字节在 uploads/artifacts/<execId>/）。 */
  @Column({ type: "uuid" }) executionId: string;

  @ManyToOne(() => TaskExecution, { onDelete: "CASCADE" })
  @JoinColumn({ name: "executionId" })
  execution: TaskExecution;

  /** 冗余自执行行（task_executions.taskId）——按任务查产物不必回连执行表。 */
  @Column({ type: "uuid" }) taskId: string;

  /**
   * 冗余自任务行（tasks.applicationId），可空：任务可不挂应用；应用删除后
   * SET NULL 保留历史产物行（与 projectId SET NULL 同款语义，见迁移头注）。
   */
  @Column({ type: "uuid", nullable: true }) applicationId: string | null;

  /** 产物裸文件名（与 jsonb 清单条目同源，SAFE_ARTIFACT_NAME_RE 校验过）。 */
  @Column({ type: "varchar", length: 255 }) name: string;

  /** 字节数（与 jsonb 清单条目同源）。 */
  @Column({ type: "integer" }) size: number;

  /** 存储字节的 sha256（与 jsonb 清单条目同源）。 */
  @Column({ type: "varchar", length: 64 }) sha256: string;

  @CreateDateColumn() createdAt: Date;
}
