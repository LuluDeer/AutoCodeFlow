import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * FEAT-01: 通知静默规则持久化（notification_silences）。
 *
 * NOTIF-003 的静默 Map 是内存态、重启即丢——本表作为恢复源（写穿 +
 * onModuleInit 回灌）。幂等：IF NOT EXISTS，重复执行与 revert 重放无副作用。
 */
export class CreateNotificationSilences1789100000000
  implements MigrationInterface
{
  name = "CreateNotificationSilences1789100000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_silences" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "scope" varchar(16) NOT NULL DEFAULT 'global',
        "channelType" varchar(32),
        "taskId" varchar(64),
        "applicationId" varchar(64),
        "level" varchar(32),
        "reason" varchar(255),
        "startTime" timestamptz,
        "endTime" timestamptz,
        "durationMinutes" integer,
        "createdBy" varchar(128),
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_notification_silences" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notification_silences_endTime"
      ON "notification_silences" ("endTime")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notification_silences_scope_taskId"
      ON "notification_silences" ("scope", "taskId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notification_silences_scope_taskId"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notification_silences_endTime"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "notification_silences"`);
  }
}
