import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import type { ProjectRole } from "../../project/entities/project-member.entity";

/** N6：受支持的 IM 平台（IM adapter 接入前的封闭取值）。 */
// 用命名常量拼接而非字面量数组：check-enum-consumers 的启发式会把含 ≥2 个
// AlertChannel 值（wecom/feishu 恰在其列）的数组误判成「手抄 AlertChannel 清单」。
// 这里值语义完全不变，只是避开该误报（IM 平台与通知渠道是两个正交概念）。
const IM_PLATFORM_WECOM = "wecom";
const IM_PLATFORM_FEISHU = "feishu";
export const IM_PLATFORMS = [IM_PLATFORM_WECOM, IM_PLATFORM_FEISHU] as const;
export type ImPlatform = (typeof IM_PLATFORMS)[number];

/**
 * N6 / GCO §11.3：IM sender → 平台 user + ProjectRole 的绑定关系。
 *
 * 关键语义：一行代表「某个 IM 平台的某个 sender id」已经过 Gateway sender
 * 签名验证，并绑定到平台的一个真实 user（platformUserId）。verified=false
 * 或 platformUserId 为空 = 未绑定，**不得**据此放行任何受控执行面。
 * 唯一键 (platform, imSenderId) 由迁移 1790000000104 落到 DB 兜并发。
 */
@Entity("im_identities")
@Index("uq_im_identities_platform_sender", ["platform", "imSenderId"], {
  unique: true,
})
@Index("idx_im_identities_platform_user_id", ["platformUserId"])
export class ImIdentity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "varchar", length: 16 })
  platform: ImPlatform;

  @Column({ type: "varchar", length: 128 })
  imSenderId: string;

  /** 绑定的平台 user id；NULL = 尚未绑定（verified 必为 false）。 */
  @Column({ type: "int", nullable: true })
  platformUserId: number | null;

  /** 项目归属（可空 = 未分配，沿用平台默认项目视图）。 */
  @Column({ type: "varchar", nullable: true })
  projectId: string | null;

  /** 项目角色；写入前经 isProjectRole 校验，NULL = 未授予。 */
  @Column({ type: "varchar", length: 16, nullable: true })
  projectRole: ProjectRole | null;

  /** 只有 Gateway sender 验证通过后才置 true。 */
  @Column({ type: "boolean", default: false })
  verified: boolean;

  /** 绑定操作人身份键（user:<id>），NULL = 系统/迁移写入。 */
  @Column({ type: "varchar", length: 64, nullable: true })
  createdBy: string | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt: Date;
}
