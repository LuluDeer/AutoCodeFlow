import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * N15 / GCO §11：运行时能力审计表 `capability_activation_log`（本轮新增，
 * 时间戳 1790000000105；需在 docs/PLAN-CLAIMS.md 迁移分配表登记——由维护者
 * 统一补登，本写域不动 docs/）。
 *
 * 列语义见 capability-activation/entities/activation-log.entity.ts 头注。索引：
 * - `idx_cap_activation_key_created_at`：(capabilityKey, createdAt) 按能力倒查；
 * - `idx_cap_activation_user_created_at`：(userId, createdAt) 按平台用户倒查；
 * - `idx_cap_activation_project_created_at`：(projectId, createdAt) 项目 showback；
 * - `idx_cap_activation_session`：(sessionId) 定位会话全部激活。
 *
 * **append-only 取舍**：`audit_logs` 靠 DB 触发器（audit_logs-append-only-guard
 * 迁移）守 append-only；本表**不引入 DB 触发器**——本表是高频激活流水，服务层
 * 只暴露 append（POST）+ 只读查询（GET stats），没有 update/delete 路径即可
 * 达成同等语义。少一层触发器 = 少一份 DDL 约束维护成本，且避免迁移依赖
 * PostgreSQL 函数/触发器的环境差异。若未来出现越过服务层直写 DB 的调用方，
 * 再在同一张表上补触发器即可（纯加性 DDL）。
 *
 * `capabilityKey` 无 FK：能力可删，历史激活事实必须留存。
 *
 * 幂等：CREATE TABLE / INDEX IF NOT EXISTS；down 逆序 DROP，无 CONCURRENTLY
 * （新表无存量行，遵守 check-migrations.mjs 的 CONCURRENTLY 守卫约定）。
 */
export class CreateCapabilityActivationLog1790000000105 implements MigrationInterface {
  name = "CreateCapabilityActivationLog1790000000105";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "capability_activation_log" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "capabilityKey" varchar(128) NOT NULL,
        "capabilityVersion" varchar(32),
        "sessionId" varchar(128),
        "parametersDigest" varchar(64) NOT NULL,
        "userId" int,
        "username" varchar,
        "imPlatform" varchar(16),
        "imSenderId" varchar(128),
        "projectId" varchar,
        "result" varchar(16) NOT NULL DEFAULT 'success',
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_capability_activation_log" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_cap_activation_key_created_at"
      ON "capability_activation_log" ("capabilityKey", "createdAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_cap_activation_user_created_at"
      ON "capability_activation_log" ("userId", "createdAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_cap_activation_project_created_at"
      ON "capability_activation_log" ("projectId", "createdAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_cap_activation_session"
      ON "capability_activation_log" ("sessionId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_cap_activation_session"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_cap_activation_project_created_at"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_cap_activation_user_created_at"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_cap_activation_key_created_at"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "capability_activation_log"`);
  }
}
