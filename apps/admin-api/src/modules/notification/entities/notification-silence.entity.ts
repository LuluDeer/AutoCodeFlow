import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

/**
 * FEAT-01: 通知静默规则的持久化载体（替代 NOTIF-003 内存 Map 的重启易失）。
 *
 * 语义：
 * - scope=global：静默所有渠道的所有通知（可按 level 收窄）；
 * - scope=task：仅静默某一任务（taskId 必填）；
 * - scope=application：仅静默某一应用下的任务（applicationId 必填）；
 * - channelType 为空 = 全渠道；指定 = 仅该渠道（email/slack/dingtalk/wecom/webhook）。
 * NotificationService 仍持内存 Map 作为热路径判定，本表是重启后的恢复源
 * （写穿 + onModuleInit 回灌），DB 不可用时降级回纯内存语义。
 */
export const SILENCE_SCOPES = ["global", "task", "application"] as const;
export type SilenceScope = (typeof SILENCE_SCOPES)[number];

@Entity("notification_silences")
@Index("idx_notification_silences_endTime", ["endTime"])
@Index("idx_notification_silences_scope_taskId", ["scope", "taskId"])
export class NotificationSilence {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "varchar", length: 16, default: "global" })
  scope: SilenceScope;

  /** 空 = 全渠道；否则 email/slack/dingtalk/wecom/webhook */
  @Column({ type: "varchar", length: 32, nullable: true })
  channelType: string | null;

  @Column({ type: "varchar", length: 64, nullable: true })
  taskId: string | null;

  @Column({ type: "varchar", length: 64, nullable: true })
  applicationId: string | null;

  /** 空 = 所有级别；否则 info/warning/critical 等 AlertLevel */
  @Column({ type: "varchar", length: 32, nullable: true })
  level: string | null;

  @Column({ type: "varchar", length: 255, nullable: true })
  reason: string | null;

  @Column({ type: "timestamptz", nullable: true })
  startTime: Date | null;

  /** 空 = 不过期；durationMinutes 写入时折算 */
  @Column({ type: "timestamptz", nullable: true })
  endTime: Date | null;

  @Column({ type: "int", nullable: true })
  durationMinutes: number | null;

  @Column({ type: "varchar", length: 128, nullable: true })
  createdBy: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
