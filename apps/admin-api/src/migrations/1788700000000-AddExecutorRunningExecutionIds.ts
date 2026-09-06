import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * CONSISTENCY-02: 执行器活性探测——executors.runningExecutionIds（nullable jsonb）。
 * executor-node 心跳上报当前正在执行的 executionId 列表（≤200），stale 扫描据此
 * 判断 RUNNING 行是否仍在真实执行：执行器在线且集合命中则跳过本轮误判恢复，避免
 * 把回调退避重试 / 同任务多执行排队导致超阈值的正常执行误杀。
 * 语义：NULL = 旧版执行器未上报（区别于 []：[] 表示已上报且当前空闲）。
 * 幂等：IF NOT EXISTS / IF EXISTS，重复执行与 revert 重放均无副作用。
 */
export class AddExecutorRunningExecutionIds1788700000000
  implements MigrationInterface
{
  name = "AddExecutorRunningExecutionIds1788700000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "executors"
      ADD COLUMN IF NOT EXISTS "runningExecutionIds" JSONB NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "executors" DROP COLUMN IF EXISTS "runningExecutionIds"
    `);
  }
}
