import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * ARCH-31: 渠道配置（ChannelConfigStore）的共享持久化载体。
 *
 * 背景：`PATCH /notification/channels/:key` 保存的渠道配置此前只存在于
 * 接收请求的那一个 admin-api 进程的内存里。多实例（水平扩容 / 滚动重启 /
 * 无会话粘滞负载均衡）下，其余实例的内存 Map 永远是空的——告警被路由到
 * 这些实例时「保存过的 webhook/SMTP 配置」整体失效，静默回退到 env 默认
 * 值（告警发不到人）。本表把保存动作变成跨实例可见的共享状态。
 *
 * 语义与既有规则保持一致：
 * - key 为渠道键（email/slack/dingtalk/wecom/webhook/feishu），主键唯一；
 * - config 为 RAW（未脱敏）配置对象——与 env、system_config 的存储面同
 *   姿态，脱敏只发生在控制器读面（N11/N32），落库值必须是真实机密；
 * - enabled 与 config 同行，避免「配置在、开关不在」的半状态（N37）；
 * - 无本表行 = 该渠道从未保存过，行为与环境回退一致（零破坏升级）。
 *
 * 幂等：建表与索引均带 IF NOT EXISTS 守卫，down 完整回滚，供 QA-08 迁移
 * 演练（up → down → up）与既有守卫重跑。
 */
export class CreateNotificationChannelConfigs1790000000014 implements MigrationInterface {
  name = "CreateNotificationChannelConfigs1790000000014";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_channel_configs" (
        "key" varchar(32) NOT NULL,
        "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "enabled" boolean NOT NULL DEFAULT false,
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_notification_channel_configs" PRIMARY KEY ("key")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notification_channel_configs_updatedAt"
      ON "notification_channel_configs" ("updatedAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notification_channel_configs_updatedAt"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "notification_channel_configs"`,
    );
  }
}
