import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

/**
 * P5（agent-and-deployment）：SOP 版本快照（设计文档 04 §2.2）。
 *
 * **不可变**是本表的存在理由：执行器 Agent 按版本执行 SOP，出问题必须能
 * 定位「当时执行的是哪一份」。发布后行永不 UPDATE（修订 = 发新版本），
 * `contentHash`（sha256，覆盖 front-matter + 正文）供执行器侧校验
 * 「我手里这份和中台发布的是否同一份」——这是跨 Agent 信任链的锚点。
 *
 * 不可变性由两个机制保证：① service 层只提供 insert，不提供 update；
 * ② DB 层无 UPDATE 触发器之外，本表不暴露任何写路径给 controller。
 */

@Entity("sop_versions")
@Index("idx_sop_versions_sopId_publishedAt", ["sopId", "publishedAt"])
// 唯一约束：同 SOP 版本号唯一（并发发布撞车时后者失败重试，不产生重复版本）
@Index("uq_sop_versions_sopId_version", ["sopId", "version"], { unique: true })
// contentHash 反查：执行器上报「我执行的是 hash X」时定位版本
@Index("idx_sop_versions_contentHash", ["contentHash"])
export class SopVersion {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  sopId: string;

  @Column({ type: "varchar", length: 32 })
  version: string;

  /** 该版本的 front-matter 完整快照。 */
  @Column({ type: "jsonb" })
  frontMatterJson: Record<string, unknown>;

  /** 该版本的正文完整快照。 */
  @Column({ type: "text" })
  bodyMarkdown: string;

  /** 本次变更说明（澄清修订时写「补充了什么」）。 */
  @Column({ type: "text", nullable: true })
  changelog: string | null;

  /** sha256(stable(frontMatter + body))——执行器侧「我执行的是哪份」的校验锚点。 */
  @Column({ type: "varchar", length: 64 })
  contentHash: string;

  @Column({ type: "varchar", length: 128 })
  publishedBy: string;

  @Column({ type: "timestamptz", default: () => "now()" })
  publishedAt: Date;

  @CreateDateColumn()
  createdAt: Date;
}
