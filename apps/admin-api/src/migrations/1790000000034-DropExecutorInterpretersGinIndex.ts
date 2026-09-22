import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * E-P2-R1：DROP 死索引 `idx_executors_interpreters`（executors.interpreters
 * jsonb 列的 GIN 索引，由 1790000000027 创建）。
 *
 * 证据：全仓（apps/packages/scripts，排除 node_modules/dist/generated）grep
 * `@>` 命中仅来自注释——调度侧解释器匹配走内存纯函数 interpreterSatisfies，
 * 心跳整列重写，生产零 GIN 包含查询。该索引只付写入维护成本、从不被计划器使用。
 *
 * 幂等：up = DROP INDEX IF EXISTS；down = 重建 IF NOT EXISTS USING GIN
 * （与 1790000000027 对齐，供 revert 重放）。
 */
export class DropExecutorInterpretersGinIndex1790000000034 implements MigrationInterface {
  name = "DropExecutorInterpretersGinIndex1790000000034";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_executors_interpreters"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_executors_interpreters" ON "executors" USING GIN ("interpreters")`,
    );
  }
}
