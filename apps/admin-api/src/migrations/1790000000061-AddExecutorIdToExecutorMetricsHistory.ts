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
 *
 * ## db-5（第 3 轮并行审计，P2）：为什么改成 CONCURRENTLY
 * 该表每执行器每 30s 一行、30 天保留——多机队下是**百万行级**。普通
 * `CREATE INDEX` 会持 SHARE 锁阻塞整表 INSERT/UPDATE/DELETE 直到建完：升级
 * 窗口内心跳落库排队 → 执行器被判离线。故：
 *   · `transaction = false`（CONCURRENTLY 不能在事务块内）；
 *   · 会话级 `SET statement_timeout = 0` + finally RESET（连接池 30s 会取消
 *     建索引并留下 indisvalid=false 的同名索引，`IF NOT EXISTS` 重跑永不修复）；
 *   · `ADD COLUMN`（可空无默认）仍是瞬时元数据操作，保留在同一迁移里。
 *
 * down 用 `DROP INDEX CONCURRENTLY` + 同一套超时豁免；列删除是瞬时元数据操作。
 */
export class AddExecutorIdToExecutorMetricsHistory1790000000061 implements MigrationInterface {
  name = "AddExecutorIdToExecutorMetricsHistory1790000000061";

  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET statement_timeout = 0`);
    try {
      await queryRunner.query(
        `ALTER TABLE "executor_metrics_history" ADD COLUMN IF NOT EXISTS "executorId" uuid`,
      );
      // 刻意写成**单个**模板字面量（不拆成字符串拼接）：check-index-drift 的
      // 判据按「一条 CREATE INDEX … ON … (cols)」整体匹配迁移文本，拼接会让它
      // 读不到（NETOPT-3 守卫，CI 会红）。
      await queryRunner.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_executor_metrics_history_executor_created" ON "executor_metrics_history" ("executorId", "createdAt")`,
      );
    } finally {
      await queryRunner.query(`RESET statement_timeout`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET statement_timeout = 0`);
    try {
      await queryRunner.query(
        `DROP INDEX CONCURRENTLY IF EXISTS "IDX_executor_metrics_history_executor_created"`,
      );
      await queryRunner.query(
        `ALTER TABLE "executor_metrics_history" DROP COLUMN IF EXISTS "executorId"`,
      );
    } finally {
      await queryRunner.query(`RESET statement_timeout`);
    }
  }
}
