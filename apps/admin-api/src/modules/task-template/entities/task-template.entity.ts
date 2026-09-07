import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * CORE-03「任务模板与一键克隆」：常用任务形态（定时备份/健康巡检/数据同步…）
 * 固化为可复用的模板。本表承载官方预置模板（isOfficial=true，迁移内幂等 seed，
 * 与 packages/mcp-server `TASK_TEMPLATES` 五个 key 语义对齐）与用户自定义模板。
 *
 * `config` 是合法 CreateTaskDto 子集（落库前经 CreateTaskDto 语义校验，见
 * task-template.util.ts），实例化为任务时作为默认值、显式传入字段覆盖之。
 * 官方模板不可删除（service 层拒 403），key 全局唯一（迁移建唯一索引）。
 */
@Entity("task_templates")
@Index("idx_task_templates_isOfficial", ["isOfficial"])
export class TaskTemplate {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** 稳定标识：官方模板用 scheduled_backup 等（与 mcp 对齐）；自定义模板唯一。 */
  @Column({ type: "varchar", length: 64, unique: true })
  key: string;

  @Column({ type: "varchar", length: 128 })
  name: string;

  @Column({ type: "text", nullable: true })
  description: string | null;

  /** 粗分类标签（前端渲染 Tag）：备份/巡检/同步/清理/通知… */
  @Column({ type: "varchar", length: 32, nullable: true })
  category: string | null;

  /** 合法 CreateTaskDto 子集；不含 name（实例化时由用户提供）。 */
  @Column({ type: "jsonb" })
  config: Record<string, unknown>;

  @Column({ type: "boolean", default: false })
  isOfficial: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
