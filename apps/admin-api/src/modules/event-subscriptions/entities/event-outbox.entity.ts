import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

/**
 * FEAT-19: 事务性 outbox 行——出站 webhook 的跨进程 at-least-once 落库层。
 *
 * 写入时机：既有 OutboundEventDispatcher 的派发入口在内存派发（进程内快速
 * 路径）的同时写一行 outbox（写成功才返回——进程重启不丢待投事件）。
 * 消费时机：OutboxDispatcher 启动 + 每 5s 扫描 dispatchedAt IS NULL 且
 * deadLettered=false 的行，逐行按既有派发语义（签名 POST + 退避重试）补投；
 * 成功回写 dispatchedAt；失败 attempts+1、nextAttemptAt 指数退避（封顶 5min），
 * 超过 MAX_OUTBOX_ATTEMPTS 落 event_subscription_dead_letters 并置
 * deadLettered=true（行终态）。
 *
 * at-least-once 语义：同一行可能在「成功回写 dispatchedAt 前」被多次投递
 * （并发扫描/重启窗口），订阅方必须幂等消费；eventId 仅作追踪键不作唯一约束。
 */
@Entity("event_outbox")
@Index("idx_event_outbox_dispatchedAt", ["dispatchedAt"])
@Index("idx_event_outbox_nextAttemptAt", ["nextAttemptAt"])
@Index("idx_event_outbox_eventId", ["eventId"])
@Index("idx_event_outbox_leaseUntil", ["leaseUntil"])
export class EventOutbox {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** 事件追踪键（事件名 + 生成 uuid）；非唯一——at-least-once 允许重投。 */
  @Column({ type: "varchar", length: 64 })
  eventId: string;

  /** 事件名（与 X-AutoCodeFlow-Event 头同值）。 */
  @Column({ type: "varchar", length: 64 })
  eventType: string;

  /** 出站信封全文（event/occurredAt/data），重投时原样签名发送。 */
  @Column({ type: "jsonb" })
  payload: Record<string, unknown>;

  /** NULL=未派发（扫描对象）；非空=已投递终态。 */
  @Column({ type: "timestamptz", nullable: true })
  dispatchedAt: Date | null;

  /** outbox 路径累计失败次数（退避基数）。 */
  @Column({ type: "int", default: 0 })
  attempts: number;

  /** 下次补投时刻（失败后 = now + 指数退避，封顶 5min）。 */
  @Column({ type: "timestamptz", nullable: true })
  nextAttemptAt: Date | null;

  /** 跨进程 claim 的租约截止时刻；NULL 表示当前没有租约。 */
  @Column({ type: "timestamptz", nullable: true })
  leaseUntil: Date | null;

  /** 当前租约持有者的随机 token，防止过期持有者终结新租约。 */
  @Column({ type: "varchar", length: 64, nullable: true })
  leaseToken: string | null;

  /** 超过阈值落死信后置 true（行终态，不再扫描）。 */
  @Column({ type: "boolean", default: false })
  deadLettered: boolean;

  @CreateDateColumn()
  createdAt: Date;
}
