import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * P5（agent-and-deployment）：SOP 主表（设计文档 04 §2.1）。
 *
 * SOP = 「文档 + 契约」的合体：`bodyMarkdown` 是给人/LLM 看的血肉，
 * `frontMatterJson` 是给平台代码校验的骨架（验收命令、能力要求、硬边界）。
 * 两者分离的理由（04 §1）：只有 Markdown 平台无法程序化校验「SOP 是否被
 * 执行」；只有 YAML 人和 LLM 都读不懂。
 *
 * 本表承载**当前态**；历史版本在 `sop_versions`（不可变快照）。发布前
 * `currentVersion` 为 NULL（从未发布过），`status` 停留在 `draft`。
 */

/** SOP 状态——封闭枚举，drift 由 check 脚本钉住。 */
export const SOP_STATUSES = ["draft", "published", "deprecated"] as const;
export type SopStatus = (typeof SOP_STATUSES)[number];

@Entity("sops")
@Index("idx_sops_status_updatedAt", ["status", "updatedAt"])
export class Sop {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** 机器可读标识（如 `daily-report`）。全仓唯一，指派与拉取都按它寻址。 */
  @Column({ type: "varchar", length: 128, unique: true })
  slug: string;

  @Column({ type: "varchar", length: 255 })
  title: string;

  /** 当前已发布版本（semver）。NULL = 从未发布（草稿态）。 */
  @Column({ type: "varchar", length: 32, nullable: true })
  currentVersion: string | null;

  @Column({ type: "varchar", length: 16, default: "draft" })
  status: SopStatus;

  /**
   * 关联应用（可选——声明式 SOP 的验收锚点未必挂在某个应用上）。
   * 存 id 不加 FK 约束（对齐 AddAgentRuntimeTables 先例：跨模块引用
   * 用可空列 + 索引，避免跨模块迁移顺序耦合）。
   */
  @Column({ type: "uuid", nullable: true })
  applicationId: string | null;

  /**
   * 解析后的 front-matter（**机器读的契约**）。存解析结果而非原文：
   * 校验、执行器拉取、scope 推导都读这里，不必每次重新 parse。
   */
  @Column({ type: "jsonb", nullable: true })
  frontMatterJson: Record<string, unknown> | null;

  @Column({ type: "text", nullable: true })
  bodyMarkdown: string | null;

  /** 创建者：`agent:<sessionId>` 或 `user:<id>`（审计与定责用）。 */
  @Column({ type: "varchar", length: 128 })
  createdBy: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
