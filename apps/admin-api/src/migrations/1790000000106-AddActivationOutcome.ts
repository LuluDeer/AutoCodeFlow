import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * N5「业务结果归因埋点」：`capability_activation_log` 追加三列。
 *
 * - `baselineMetric varchar(64)`：基线指标名；NULL = 未采集基线。
 * - `improvement numeric(12,2)`：相对基线的改进量；NULL = 未量化。
 * - `confirmed boolean DEFAULT false`：业务结果是否已确认；schema 默认 false。
 *
 * 三列均为可空新列（confirmed 带 default false），**不回填**：存量激活行保持
 * 前两列 NULL、confirmed=false，历史事实不被追溯改写（与 append-only 契约一致）。
 *
 * 幂等：ADD COLUMN IF NOT EXISTS；down 逆序 DROP COLUMN IF EXISTS。
 * 无索引变更，不涉及 CONCURRENTLY 守卫。
 *
 * 跨写域事项（本写域不动 docs）：时间戳 106 需在 docs/PLAN-CLAIMS.md 的迁移
 * 分配表登记，由 lead 统一补登。
 */
export class AddActivationOutcome1790000000106 implements MigrationInterface {
  name = "AddActivationOutcome1790000000106";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "capability_activation_log"
      ADD COLUMN IF NOT EXISTS "baselineMetric" varchar(64)
    `);
    await queryRunner.query(`
      ALTER TABLE "capability_activation_log"
      ADD COLUMN IF NOT EXISTS "improvement" numeric(12,2)
    `);
    await queryRunner.query(`
      ALTER TABLE "capability_activation_log"
      ADD COLUMN IF NOT EXISTS "confirmed" boolean DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "capability_activation_log"
      DROP COLUMN IF EXISTS "confirmed"
    `);
    await queryRunner.query(`
      ALTER TABLE "capability_activation_log"
      DROP COLUMN IF EXISTS "improvement"
    `);
    await queryRunner.query(`
      ALTER TABLE "capability_activation_log"
      DROP COLUMN IF EXISTS "baselineMetric"
    `);
  }
}
