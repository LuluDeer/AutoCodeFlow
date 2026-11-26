import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * ADR-040 / P1：Capability 注册表建表迁移。
 *
 * `capabilities` 一行 = 一个可装载的能力声明。列名驼峰加引号，对齐 TypeORM
 * 默认命名策略（与 1789800000000-CreateTaskTemplates 同款）。
 *
 * 索引：
 * - `uq_capabilities_key`：key 唯一（稳定标识，幂等 hard gate + 按 key 点查）；
 * - `idx_capabilities_kind` / `idx_capabilities_visibility`：列表过滤。
 *
 * 幂等：CREATE TABLE / INDEX IF NOT EXISTS；down 逆序 DROP INDEX / TABLE IF EXISTS。
 * 重复执行与 revert 重放均无副作用。无 CONCURRENTLY（新表无存量行），故无需
 * statement_timeout 豁免；遵守 check-migrations.mjs 的 CONCURRENTLY 守卫约定。
 */
export class CreateCapabilities1790000000103 implements MigrationInterface {
  name = "CreateCapabilities1790000000103";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "capabilities" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "key" varchar(128) NOT NULL,
        "kind" varchar(24) NOT NULL,
        "label" varchar(128) NOT NULL,
        "description" text,
        "version" varchar(32) NOT NULL DEFAULT '1.0.0',
        "source" jsonb NOT NULL DEFAULT '{"type":"builtin"}'::jsonb,
        "visibility" varchar(16) NOT NULL DEFAULT 'private',
        "scope" jsonb NOT NULL DEFAULT '{"mode":"supervised","guidance":"L2"}'::jsonb,
        "manifest" jsonb NOT NULL,
        "enabled" boolean NOT NULL DEFAULT true,
        "createdBy" varchar(64),
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_capabilities" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_capabilities_key"
      ON "capabilities" ("key")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_capabilities_kind"
      ON "capabilities" ("kind")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_capabilities_visibility"
      ON "capabilities" ("visibility")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_capabilities_visibility"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_capabilities_kind"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_capabilities_key"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "capabilities"`);
  }
}
