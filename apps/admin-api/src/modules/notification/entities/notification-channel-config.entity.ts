import {
  Column,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * ARCH-31: 渠道配置的共享持久化行（迁移 1790000000014）。
 *
 * `ChannelConfigStore` 此前是纯进程内 Map——多实例下「保存即只在保存它的
 * 那个实例生效」。本实体让保存动作落到 DB，其余实例按刷新周期读穿，从而
 * 让「渠道配置」这一项从 ARCH-31 矩阵的 🔴 降为 🟡（TTL 内收敛）。
 *
 * 注意：config 落库为 RAW 值（与 system_config / env 的存储面同姿态），
 * 脱敏只发生在控制器读面；本表不得被任何读面端点直接透出。
 */
@Entity("notification_channel_configs")
@Index("idx_notification_channel_configs_updatedAt", ["updatedAt"])
export class NotificationChannelConfig {
  /** 渠道键：email/slack/dingtalk/wecom/webhook/feishu */
  @PrimaryColumn({ type: "varchar", length: 32 })
  key: string;

  /** RAW（未脱敏）配置对象，形如 { webhookUrl, secret? } */
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  config: Record<string, string>;

  /** N37：渠道开关与配置同行，防止半状态 */
  @Column({ type: "boolean", default: false })
  enabled: boolean;

  @UpdateDateColumn()
  updatedAt: Date;
}
