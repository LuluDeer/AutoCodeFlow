import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * DATAOPS（产物列表可读性）：`execution_artifacts` 补两条分页排序复合索引。
 *
 * ## 为什么需要
 *
 * `GET /artifacts` 的主过滤维度是 `taskId` 或 `applicationId`，分页排序为
 * `(维度, createdAt DESC, id DESC)`（见 ArtifactsService.listArtifactRows）。
 * 迁移 1790000000065 只建了两条单列索引，命中过滤后仍需把该维度下的全部行
 * 取出再排序；同刻终态回调批量落产物时 createdAt 会打平，id 作为决胜键
 * 也走不到索引里，深翻页成本随该任务/应用的历史产物数线性增长。
 *
 * ## 列序与方向
 *
 * - `("taskId", "createdAt" DESC, "id" DESC)`：按任务查产物的分页路径；
 * - `("applicationId", "createdAt" DESC, "id" DESC)`：按应用聚合查产物的分页路径。
 *
 * 单列索引是这两条的严格左前缀，保留不动（删除是不可逆决策，先例见
 * 1790000000056/0051）；实体 @Index 与本迁移 DDL 同步，方向只落在 DDL
 * （TypeORM IndexOptions 不表达列方向，与 task-execution 的 0049 同款）。
 *
 * ## 并发与超时
 *
 * `execution_artifacts` 由终态回调持续写入，普通 CREATE INDEX 的写锁会挡住
 * 产物落库；沿用 1790000000055/0075 的大表纪律：`transaction = false` +
 * `CREATE INDEX CONCURRENTLY`，会话级 `statement_timeout = 0` 并在 finally
 * RESET（SET LOCAL 在无事务块时无效；连接归还池后不复位会污染后续查询）。
 * `IF NOT EXISTS` / `IF EXISTS` 保证 up/down 重放幂等。
 */
export class AddExecutionArtifactsListIndexes1790000000109 implements MigrationInterface {
  name = "AddExecutionArtifactsListIndexes1790000000109";

  /** CONCURRENTLY 不能在事务块内执行——本迁移不走外层事务。 */
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET statement_timeout = 0`);
    try {
      // 单行 DDL：scripts/check-index-drift.mjs 按同一行正则扫描索引声明。
      await queryRunner.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_execution_artifacts_task_created_at_id" ON "execution_artifacts" ("taskId", "createdAt" DESC, "id" DESC)`,
      );
      await queryRunner.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_execution_artifacts_application_created_at_id" ON "execution_artifacts" ("applicationId", "createdAt" DESC, "id" DESC)`,
      );
    } finally {
      await queryRunner.query(`RESET statement_timeout`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET statement_timeout = 0`);
    try {
      // 逆序回收；回滚同样发生在有流量的时刻，CONCURRENTLY 避免锁写。
      await queryRunner.query(
        `DROP INDEX CONCURRENTLY IF EXISTS "idx_execution_artifacts_application_created_at_id"`,
      );
      await queryRunner.query(
        `DROP INDEX CONCURRENTLY IF EXISTS "idx_execution_artifacts_task_created_at_id"`,
      );
    } finally {
      await queryRunner.query(`RESET statement_timeout`);
    }
  }
}
