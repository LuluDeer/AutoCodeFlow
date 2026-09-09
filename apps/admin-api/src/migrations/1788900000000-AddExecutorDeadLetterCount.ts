import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * U16: executors.deadLetterCount（nullable integer）。
 * executor-node（ab4971f 起）/ executor-python（001 起）心跳上报 dead-letter
 * 积压数，admin 侧经心跳白名单采纳落库（非负整数 0..100000，非法/缺失不改
 * DB 值，与 maxConcurrentTasks 采纳同模式），GET /executors、GET /executors/:id
 * 随实体自然透出。语义：NULL = 旧版执行器未上报该字段。
 * 幂等：IF NOT EXISTS / IF EXISTS，重复执行与 revert 重放均无副作用。
 */
export class AddExecutorDeadLetterCount1788900000000 implements MigrationInterface {
  name = "AddExecutorDeadLetterCount1788900000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "executors"
      ADD COLUMN IF NOT EXISTS "deadLetterCount" INTEGER NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "executors" DROP COLUMN IF EXISTS "deadLetterCount"
    `);
  }
}
