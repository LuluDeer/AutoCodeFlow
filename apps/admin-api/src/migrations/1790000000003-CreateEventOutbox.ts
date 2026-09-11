import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * FEAT-19「Webhook at-least-once（跨进程 outbox）」：建 event_outbox 表。
 *
 * 背景与动机：FEAT-07 的出站派发是进程内形态——事件到达即内存快照订阅 +
 * 首投 + 最多 3 次 setTimeout 退避重试。进程重启即丢在途投递与待重试事件
 * （at-most-once for in-flight retries）。本迁移建事务性 outbox 落库层：
 * 每个待派发事件先写 event_outbox（与业务同库、随事务提交），派发器
 * OutboxDispatcher 启动时 + 周期性扫描未派发行补投——跨进程重启不丢事件。
 *
 * 列设计：
 * - eventId varchar(64)：幂等/追踪键（事件名 + 生成 uuid），非唯一索引
 *   ——at-least-once 语义下同一事件允许被派发多次（订阅方幂等），故不加
 *   唯一约束阻断重投。
 * - eventType varchar(64)：事件名（与 X-AutoCodeFlow-Event 头同值）。
 * - payload jsonb：出站信封全文（buildEventPayload 形状：event/occurredAt/data），
 *   重投时原样签名发送（保证重投载荷与首投逐字节同构，签名才可复算）。
 * - dispatchedAt timestamptz 可空：NULL = 未派发（扫描对象）；非空 = 已投递
 *   终态（快速路径或 outbox 路径成功后回写）。
 * - attempts int 默认 0：outbox 路径累计失败次数（指数退避基数）。
 * - nextAttemptAt timestamptz 可空：下次补投时刻（失败后 = now + 退避，
 *   封顶 5min）；扫描按它排序取应投行。
 * - deadLettered boolean 默认 false：source-level outbox 超过 MAX_OUTBOX_ATTEMPTS 后落
 *   event_outbox_dead_letters（由迁移 1790000000013 创建）并置 true（行终态，
 *   不再扫描）。具体订阅投递失败由 event_subscription_dead_letters 承载。
 *
 * 幂等：CREATE TABLE / INDEX IF NOT EXISTS；重复执行与 revert 重放均无副作用。
 * 列名驼峰加引号对齐 TypeORM 默认命名策略（先例：1789900000000-CreateEventSubscriptions）。
 */
export class CreateEventOutbox1790000000003 implements MigrationInterface {
  name = "CreateEventOutbox1790000000003";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "event_outbox" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "eventId" varchar(64) NOT NULL,
        "eventType" varchar(64) NOT NULL,
        "payload" jsonb NOT NULL,
        "dispatchedAt" timestamptz,
        "attempts" int NOT NULL DEFAULT 0,
        "nextAttemptAt" timestamptz,
        "deadLettered" boolean NOT NULL DEFAULT false,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_event_outbox" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_event_outbox_dispatchedAt"
      ON "event_outbox" ("dispatchedAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_event_outbox_nextAttemptAt"
      ON "event_outbox" ("nextAttemptAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_event_outbox_eventId"
      ON "event_outbox" ("eventId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_event_outbox_eventId"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_event_outbox_nextAttemptAt"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_event_outbox_dispatchedAt"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "event_outbox"`);
  }
}
