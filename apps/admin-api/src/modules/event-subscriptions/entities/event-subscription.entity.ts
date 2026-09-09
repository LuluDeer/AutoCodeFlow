import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * FEAT-07: 出站事件订阅行。
 *
 * 一个订阅 = 一个回调 URL + 一组订阅的事件名 + 一个 HMAC 签名密钥。
 * 事件名集合与 DOMAIN_EVENTS 常量对齐（execution.completed / execution.failed /
 * executor.offline / deployment.completed）；匹配语义见 event-subscription.util.ts。
 * secret 由服务端生成（create 时未提供则随机 32 字节 hex），任何读端点都不回显。
 */
@Entity("event_subscriptions")
@Index("idx_event_subscriptions_userId", ["userId"])
@Index("idx_event_subscriptions_enabled", ["enabled"])
export class EventSubscription {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** 创建者用户 id（users.id 为自增 int）；null = 系统级订阅（仅 ADMIN 可建）。 */
  @Column({ type: "int", nullable: true })
  userId: number | null;

  /** 订阅的事件名数组（jsonb 字符串数组），如 ["execution.failed"]。 */
  @Column({ type: "jsonb" })
  eventTypes: string[];

  /** 回调 URL（写入前经 assertSafeHttpUrl SSRF 校验；出站时二次校验）。 */
  @Column({ type: "varchar", length: 2048 })
  url: string;

  /** HMAC-SHA256 签名密钥——永不出 API（列表/详情均脱敏为固定占位）。 */
  @Column({ type: "varchar", length: 256 })
  secret: string;

  @Column({ type: "boolean", default: true })
  enabled: boolean;

  /** 失败统计：连续失败次数（成功派发即清零）；终败死信落库时 +1。 */
  @Column({ type: "int", default: 0 })
  consecutiveFailures: number;

  @Column({ type: "timestamptz", nullable: true })
  lastFailureAt: Date | null;

  /** 最近一次失败摘要（截 512，排障用；不含 secret/payload 原文）。 */
  @Column({ type: "varchar", length: 512, nullable: true })
  lastFailureError: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
