import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * FEAT-21：任务级 webhook 入站触发——tasks.webhookSecret 列。
 *
 * 每任务一把触发密钥（null = 未启用），外部系统按 applications 发版 webhook
 * 的既有签名纪律调用公开端点 POST /api/webhooks/tasks/:taskId：
 * HMAC-SHA256 over `${timestamp}.${rawBody}`（X-AutoCodeFlow-Timestamp /
 * X-Hub-Signature-256），校验收敛在 common/utils/webhook-hmac.util.ts。
 *
 * 存储格式与 tasks.secrets 同生命周期（SEC-02）：配置 SEC_SECRETS_KEY 后为
 * `enc:v1:...` 信封，未配置降级明文——列本身无格式约束，读侧用
 * isEncryptedSecret 区分。select:false（实体侧）保证默认读面不带出。
 *
 * 有意不加独立开关列：secret 非 null 即启用，disable 置 NULL——与应用的
 * webhookSecret 先例同构，少一列就少一个会漂移的布尔。
 *
 * 幂等：IF NOT EXISTS，重复执行与 revert 重放均无副作用。
 */
export class AddTaskWebhookSecret1790000000045 implements MigrationInterface {
  name = "AddTaskWebhookSecret1790000000045";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tasks"
      ADD COLUMN IF NOT EXISTS "webhookSecret" VARCHAR NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tasks" DROP COLUMN IF EXISTS "webhookSecret"
    `);
  }
}
