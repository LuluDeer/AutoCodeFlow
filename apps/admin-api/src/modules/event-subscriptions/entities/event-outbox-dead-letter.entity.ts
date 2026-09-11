import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

/**
 * FEAT-19 reliability: terminal failures of an outbox row.
 *
 * This is deliberately separate from subscription dead letters: one outbox row
 * represents an event that may target several subscriptions and therefore has
 * no subscription owner.  The outbox dispatcher writes this row before it
 * guardedly marks the source row dead-lettered.
 */
@Entity("event_outbox_dead_letters")
@Index("uq_event_outbox_dead_letters_outboxId", ["outboxId"], {
  unique: true,
})
@Index("idx_event_outbox_dead_letters_createdAt", ["createdAt"])
export class EventOutboxDeadLetter {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** Source event_outbox row; deleting the source removes its terminal record. */
  @Column({ type: "uuid" })
  outboxId: string;

  /** Event name copied from the source outbox row. */
  @Column({ type: "varchar", length: 64 })
  eventType: string;

  /** Complete outbound envelope retained for operational inspection/replay. */
  @Column({ type: "jsonb" })
  payload: Record<string, unknown>;

  /** Cumulative outbox attempts, including the terminal attempt. */
  @Column({ type: "int" })
  attempts: number;

  /** Last delivery failure summary, truncated by the dispatcher. */
  @Column({ type: "varchar", length: 1024 })
  lastError: string;

  /** Time at which the source row was reliably moved to dead-letter state. */
  @Column({ type: "timestamptz" })
  deadLetteredAt: Date;

  @CreateDateColumn()
  createdAt: Date;
}
