import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * NF-01：api_keys.scope 扩展任务触发域——`task:trigger`（CI/脚本免登录触发）。
 *
 * AUTH-03 既有三级 scope（readonly/trigger/manage）按「读/写 + 路径白名单」
 * 表达能力；NF-01 需要一个只覆盖 `POST /tasks/:id/trigger`（单任务触发）
 * 的更窄域：既有 `trigger` scope 白名单含批量触发（tasks/batch/trigger 与
 * 全部 tasks/:id/trigger），而 `task:trigger` 仅放行单任务触发端点——
 * CI 场景下最小权限，连批量面也不给。
 *
 * 约束形态：varchar(32) 列存「空格分隔的 scope 词表」（如
 * `readonly task:trigger`）。存量行不含新词，行为不变；新词加入后
 * guard 分流侧按词表判定（ApiKeysService.hasScope）。不使用 PG enum：
 * scope 集合仍是应用层域（AuthUser 侧 ApiKeyScope 三级保持不变），
 * 新词只在 api-keys 判定面消费。
 *
 * 幂等：IF NOT EXISTS，重复执行与 revert 重放均无副作用。
 */
export class AddApiKeyTaskTriggerScope1790000000005 implements MigrationInterface {
  name = "AddApiKeyTaskTriggerScope1790000000005";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "api_keys"
      ADD COLUMN IF NOT EXISTS "scopes" VARCHAR(128) NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "api_keys" DROP COLUMN IF EXISTS "scopes"
    `);
  }
}
