import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * ARCH-31 / FEAT-19 follow-up: add an expiring, token-guarded lease to the
 * event outbox so multiple PostgreSQL-backed dispatcher instances can claim
 * disjoint rows without relying on process-local coordination.
 */
export class AddEventOutboxLeases1790000000012 implements MigrationInterface {
  name = "AddEventOutboxLeases1790000000012";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "event_outbox"
      ADD COLUMN IF NOT EXISTS "leaseUntil" timestamptz NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "event_outbox"
      ADD COLUMN IF NOT EXISTS "leaseToken" varchar(64) NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_event_outbox_leaseUntil"
      ON "event_outbox" ("leaseUntil")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_event_outbox_leaseUntil"`,
    );
    await queryRunner.query(`
      ALTER TABLE "event_outbox"
      DROP COLUMN IF EXISTS "leaseToken"
    `);
    await queryRunner.query(`
      ALTER TABLE "event_outbox"
      DROP COLUMN IF EXISTS "leaseUntil"
    `);
  }
}
