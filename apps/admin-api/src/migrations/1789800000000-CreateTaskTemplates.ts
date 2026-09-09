import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * CORE-03「任务模板与一键克隆」：建 `task_templates` 表 + 幂等预置 5 个官方模板。
 *
 * 五个官方模板（key/定位/config）与 packages/mcp-server `TASK_TEMPLATES`
 * （ECO-03）同口径，避免 admin 与 MCP 两套模板语义漂移。迁移内 seed 是**冻结快照**
 * （迁移必须不可变，故不 import 应用常量）；`task-template.migration.spec.ts`
 * 断言本处 VALUES 与运行时 `OFFICIAL_TASK_TEMPLATES` 逐项一致，漂移即红。
 *
 * 幂等：CREATE TABLE / INDEX IF NOT EXISTS；INSERT ... ON CONFLICT (key) DO NOTHING。
 * 重复执行与 revert 重放均无副作用。列名驼峰加引号对齐 TypeORM 默认命名策略。
 */
export class CreateTaskTemplates1789800000000 implements MigrationInterface {
  name = "CreateTaskTemplates1789800000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "task_templates" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "key" varchar(64) NOT NULL,
        "name" varchar(128) NOT NULL,
        "description" text,
        "category" varchar(32),
        "config" jsonb NOT NULL,
        "isOfficial" boolean NOT NULL DEFAULT false,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_task_templates" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_task_templates_key"
      ON "task_templates" ("key")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_task_templates_isOfficial"
      ON "task_templates" ("isOfficial")
    `);
    // 官方模板 seed（冻结快照，与 mcp TASK_TEMPLATES 对齐；isOfficial=true）。
    await queryRunner.query(`
      INSERT INTO "task_templates"
        ("key", "name", "description", "category", "config", "isOfficial")
      VALUES
        ('scheduled_backup', '定时备份',
         '周期性备份任务：Cron 定时触发（默认每天 02:00），失败按重试预算退避重试，冲突丢弃。',
         '备份',
         '{"triggerType":"cron","cronExpression":"0 2 * * *","runtime":"shell","entrypoint":"backup.sh","timeoutSeconds":3600,"maxRetry":3,"retryDelay":60,"blockStrategy":"discard"}'::jsonb,
         true),
        ('health_check', '健康巡检',
         '端点/服务健康探针：固定间隔轮询（默认 60s），低超时、不重试——快速失败暴露问题。',
         '巡检',
         '{"triggerType":"fixed_rate","fixedRate":60,"runtime":"shell","entrypoint":"check.sh","timeoutSeconds":30,"maxRetry":0}'::jsonb,
         true),
        ('data_sync', '数据同步',
         '数据同步流水线：较长超时、串行不重叠、失败退避重试（默认每 30 分钟一次）。',
         '同步',
         '{"triggerType":"fixed_rate","fixedRate":1800,"runtime":"python","entrypoint":"sync.py","timeoutSeconds":7200,"maxRetry":2,"retryDelay":300,"blockStrategy":"discard"}'::jsonb,
         true),
        ('log_cleanup', '日志清理',
         '每日清理：在执行器主机上剪除过期文件/日志（默认每天 03:30），失败轻试一次。',
         '清理',
         '{"triggerType":"cron","cronExpression":"30 3 * * *","runtime":"shell","entrypoint":"cleanup.sh","timeoutSeconds":600,"maxRetry":1}'::jsonb,
         true),
        ('webhook_ping', 'Webhook 通知',
         '手动/API 触发的出站 Webhook 通知器，通常作为下游依赖串联，不排程。',
         '通知',
         '{"triggerType":"manual","runtime":"node","entrypoint":"ping.js","timeoutSeconds":60,"maxRetry":1}'::jsonb,
         true)
      ON CONFLICT ("key") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_task_templates_isOfficial"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_task_templates_key"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "task_templates"`);
  }
}
