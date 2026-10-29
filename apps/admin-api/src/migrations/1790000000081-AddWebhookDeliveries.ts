import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * SEC-3：`webhook_deliveries`——应用发布 webhook 的投递幂等账本。
 *
 * 缺口：`x-autoflow-delivery` 幂等键此前只被接收、从不参与判定，同一 delivery
 * id 重试会重复「更新应用版本 + 滚动升级」（一次网络抖动 = 一次重复发布）。
 *
 * 本体是**唯一约束** `(scope, "deliveryKey")`：claim 走
 * `INSERT ... ON CONFLICT DO UPDATE ... WHERE "expiresAt" < now() RETURNING`，
 * 由 PG 仲裁并发，命中 0 行 = 已有有效投递（重复），命中 1 行 = 首次/已过期重占。
 * 因此本迁移必须建的是 **UNIQUE INDEX**（不是普通索引），否则去重语义直接失效。
 *
 * `idx_webhook_deliveries_expires_at`：retention sweep 每批按 `"expiresAt" < now()`
 * 删行，没这个索引就是每轮全表扫。
 *
 * 新表、空表建索引 ⇒ 无需 CONCURRENTLY（无并发写，事务内一条语句即可）。
 * down：DROP TABLE（两个索引随表级联删除）。
 */
export class AddWebhookDeliveries1790000000081 implements MigrationInterface {
  name = "AddWebhookDeliveries1790000000081";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "scope" character varying(32) NOT NULL,
        "deliveryKey" character varying(128) NOT NULL,
        "appId" uuid,
        "receivedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "expiresAt" TIMESTAMPTZ NOT NULL,
        CONSTRAINT "PK_webhook_deliveries_id" PRIMARY KEY ("id")
      )
    `);
    // 去重仲裁的唯一约束（claim 的 ON CONFLICT 目标）。
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_webhook_deliveries_scope_delivery_key"
        ON "webhook_deliveries" ("scope", "deliveryKey")
    `);
    // retention sweep 的删除谓词索引。
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_webhook_deliveries_expires_at"
        ON "webhook_deliveries" ("expiresAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "webhook_deliveries"`);
  }
}
