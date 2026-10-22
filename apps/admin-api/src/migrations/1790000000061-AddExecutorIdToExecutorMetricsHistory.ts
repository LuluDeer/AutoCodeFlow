import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * ADR-017 阶段 3 复查补口（「相关轨道」第 3 条）：给 `executor_metrics_history`
 * 补**行身份**列 `executorId`。
 *
 * ## 为什么需要
 *
 * 该表此前只有 `executorAddress`。ADR-017 §5 明确允许 pull 模式**同址多行**
 * （两台机器同网段同 IP 各自成行 / 地址漂移后新旧地址并存），于是同址多行的
 * 24h 趋势曲线（CPU / 内存 / 在跑数）在物理上无法拆分到行——这不是查询面少写
 * 一个谓词，而是数据面缺一列（生产实证 2026-10-22：6 台全 pull 机队里有 2 个
 * 地址发生过指纹变更 / DHCP 复用，趋势图把两台的数据混画）。
 *
 * ## 为什么不回填（NULL 的历史行保留）
 *
 * 回填需要把「地址」映射到「行」，而同址多行下这个映射**本来就有歧义**——
 * 猜一个 id 就是数据污染（与迁移 1790000000055 不给 `task_executions` 回填
 * `executorId` 的结论同源）。读面因此采用
 * `executorId = :id OR (executorId IS NULL AND executorAddress = :address)`
 * 的谓词：新行按行身份、历史行按地址回落，曲线不断档。
 *
 * ## 形态
 *
 * 加列 + 复合索引（`executorId, createdAt`）与查询面
 * `WHERE executorId = ? AND createdAt > ?` 对齐；既有
 * `(executorAddress, createdAt)` 索引保持不变（历史行仍走它）。
 * 幂等：`ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`。
 */
export class AddExecutorIdToExecutorMetricsHistory1790000000061 implements MigrationInterface {
  name = "AddExecutorIdToExecutorMetricsHistory1790000000061";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "executor_metrics_history" ADD COLUMN IF NOT EXISTS "executorId" uuid`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_executor_metrics_history_executor_created" ` +
        `ON "executor_metrics_history" ("executorId", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_executor_metrics_history_executor_created"`,
    );
    await queryRunner.query(
      `ALTER TABLE "executor_metrics_history" DROP COLUMN IF EXISTS "executorId"`,
    );
  }
}
