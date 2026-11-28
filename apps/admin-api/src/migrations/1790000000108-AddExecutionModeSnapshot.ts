import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 执行快照：把「本次派发是单播还是广播」钉在执行行上。
 *
 * 背景：回调侧释放广播占坑时，旧实现读的是 `tasks.executeMode` 的**当前值**。
 * 任务在执行途中被改成 single 后，所有历史广播执行的回调都被当成单播，
 * `broadcastReservedCount` 一只不减（槽位泄漏）；反向改法还会把单播执行误当广播，
 * 多减一次造成容量虚低、超发任务。
 *
 * 修法：claim 时把任务当时的模式复制到执行行（`executeMode` / `isBroadcast`），
 * 回调只读执行行自己的快照。两列都可空：NULL = 迁移前存量行 / 无法还原的快照，
 * 此时回调按「非广播」处理（与引入本列前的单播释放语义逐字节一致），绝不回读
 * 任务当前配置去猜历史执行。
 *
 * 幂等：IF [NOT] EXISTS，重复执行与 revert 重放均无副作用。
 */
export class AddExecutionModeSnapshot1790000000108 implements MigrationInterface {
  name = "AddExecutionModeSnapshot1790000000108";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 两条独立的 ALTER TABLE：迁移对称性守卫按「每条 ALTER TABLE 一个
    // ADD/DROP COLUMN」抽取，逗号续写的多列形态会漏判后一列（down 同理）。
    await queryRunner.query(`
      ALTER TABLE "task_executions"
      ADD COLUMN IF NOT EXISTS "executeMode" VARCHAR(16) NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "task_executions"
      ADD COLUMN IF NOT EXISTS "isBroadcast" BOOLEAN NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "task_executions"
      DROP COLUMN IF EXISTS "executeMode"
    `);
    await queryRunner.query(`
      ALTER TABLE "task_executions"
      DROP COLUMN IF EXISTS "isBroadcast"
    `);
  }
}
