import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

/**
 * FEAT-07: 出站派发终败死信。
 *
 * 一个订阅的一次事件派发，经最多 3 次指数退避重试仍失败（网络错误/5xx/
 * 超时）后整包落本表：payload 为发送时的完整 JSON 载荷（含签名字段原文），
 * error 为最后一次失败摘要（截 1024），attempts 为实际尝试次数。
 * 查看：GET /event-subscriptions/:id/dead-letters（属主/ADMIN）。
 * 重放：POST /event-subscriptions/:id/dead-letters/:dlId/replay（以订阅当前
 * url/secret 重新签名派发一次，成功即删行；重放不自动重试）。
 */
@Entity("event_subscription_dead_letters")
@Index("idx_event_subscription_dead_letters_sub", ["subscriptionId", "createdAt"])
export class EventSubscriptionDeadLetter {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  subscriptionId: string;

  /** 事件名（execution.failed / executor.offline / deployment.completed …）。 */
  @Column({ type: "varchar", length: 64 })
  eventType: string;

  /** 发送时的完整载荷（jsonb 原文）。 */
  @Column({ type: "jsonb" })
  payload: Record<string, unknown>;

  /** 最后一次失败原因摘要。 */
  @Column({ type: "varchar", length: 1024 })
  error: string;

  /** 实际尝试次数（含首次与全部重试）。 */
  @Column({ type: "int", default: 0 })
  attempts: number;

  @CreateDateColumn()
  createdAt: Date;
}
