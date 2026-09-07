import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * FEAT-07「Webhook 出站事件」：建两张表。
 *
 * 1. `event_subscriptions` — 出站事件订阅：
 *    - `eventTypes` 为 jsonb 字符串数组（如 ["execution.failed","executor.offline"]），
 *      订阅的事件名集合；事件名是稳定契约（只增不改，见 domain-events.ts）。
 *    - `url` 为订阅方 HTTPS 回调端点（写入前经 assertSafeHttpUrl SSRF 守卫校验）。
 *    - `secret` 为 HMAC-SHA256 签名密钥（出站时以 applications 发版 webhook
 *      同款约定签名，见 api-reference.md「Webhook 出站事件」段）。
 *    - `consecutiveFailures` / `lastFailureAt` 为可选失败统计列，便于运维排障。
 *
 * 2. `event_subscription_dead_letters` — 重试终败的死信：
 *    - 出站派发最多 3 次指数退避后仍失败 → 整包（payload+error+attempts）落本表，
 *      供 GET /event-subscriptions/:id/dead-letters 查看与手动 replay。
 *
 * 幂等：CREATE TABLE / INDEX IF NOT EXISTS；重复执行与 revert 重放均无副作用。
 * 列名驼峰加引号对齐 TypeORM 默认命名策略（先例：1789800000000-CreateTaskTemplates）。
 */
export class CreateEventSubscriptions1789900000000 implements MigrationInterface {
  name = "CreateEventSubscriptions1789900000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "event_subscriptions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" integer,
        "eventTypes" jsonb NOT NULL,
        "url" varchar(2048) NOT NULL,
        "secret" varchar(256) NOT NULL,
        "enabled" boolean NOT NULL DEFAULT true,
        "consecutiveFailures" int NOT NULL DEFAULT 0,
        "lastFailureAt" timestamptz,
        "lastFailureError" varchar(512),
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_event_subscriptions" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_event_subscriptions_userId"
      ON "event_subscriptions" ("userId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_event_subscriptions_enabled"
      ON "event_subscriptions" ("enabled")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "event_subscription_dead_letters" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "subscriptionId" uuid NOT NULL,
        "eventType" varchar(64) NOT NULL,
        "payload" jsonb NOT NULL,
        "error" varchar(1024) NOT NULL,
        "attempts" int NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_event_subscription_dead_letters" PRIMARY KEY ("id"),
        CONSTRAINT "fk_dead_letters_subscription"
          FOREIGN KEY ("subscriptionId") REFERENCES "event_subscriptions"("id")
          ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_event_subscription_dead_letters_sub"
      ON "event_subscription_dead_letters" ("subscriptionId", "createdAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_event_subscription_dead_letters_sub"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "event_subscription_dead_letters"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_event_subscriptions_enabled"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_event_subscriptions_userId"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "event_subscriptions"`);
  }
}
