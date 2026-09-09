import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * SEC-02: tasks.secrets（nullable jsonb）——任务级凭据键值对，独立于
 * params（普通运行参数）。存储侧加密语义见 common/utils/secret-crypto.util.ts：
 * 配置 SEC_SECRETS_KEY 后叶子值为 AES-256-GCM `enc:v1:` 信封；未配置时降级
 * 明文（零破坏升级路径）。存量行不做迁移加密，首次 update 自然转密文。
 * 幂等：IF NOT EXISTS / IF EXISTS，重复执行与 revert 重放均无副作用。
 */
export class AddTaskSecrets1789500000001 implements MigrationInterface {
  name = "AddTaskSecrets1789500000001";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tasks"
      ADD COLUMN IF NOT EXISTS "secrets" JSONB NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tasks" DROP COLUMN IF EXISTS "secrets"
    `);
  }
}
