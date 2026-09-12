import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * FEAT-19 reliability: keep terminal outbox failures in an outbox-owned
 * dead-letter table.  An outbox row can target multiple subscriptions and must
 * never be represented by a subscription dead-letter sentinel.
 *
 * The foreign key and indexes are created idempotently.  The source row is
 * retained as the parent so operators can correlate the terminal record with
 * its original event envelope.
 */
export class CreateEventOutboxDeadLetters1790000000013 implements MigrationInterface {
  name = "CreateEventOutboxDeadLetters1790000000013";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "event_outbox_dead_letters" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "outboxId" uuid NOT NULL,
        "eventType" varchar(64) NOT NULL,
        "payload" jsonb NOT NULL,
        "attempts" int NOT NULL,
        "lastError" varchar(1024) NOT NULL,
        "deadLetteredAt" timestamptz NOT NULL DEFAULT now(),
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_event_outbox_dead_letters" PRIMARY KEY ("id"),
        CONSTRAINT "fk_event_outbox_dead_letters_outbox"
          FOREIGN KEY ("outboxId") REFERENCES "event_outbox"("id")
          ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_event_outbox_dead_letters_outboxId"
      ON "event_outbox_dead_letters" ("outboxId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_event_outbox_dead_letters_createdAt"
      ON "event_outbox_dead_letters" ("createdAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_event_outbox_dead_letters_createdAt"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_event_outbox_dead_letters_outboxId"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "event_outbox_dead_letters"`);
  }
}
