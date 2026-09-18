import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * F-12（本轮审计）: `executors.interpreters` jsonb 列的 GIN 索引。
 *
 * 现状：调度侧为"take 候选池读出后纯内存过滤（interpreterSatisfies）"，无索引
 * 不阻塞；本索引为未来"按解释器版本/缓存状态查询执行器"（如"列出所有缓存了
 * 3.7 的执行器"）的运维查询面铺路——jsonb 等值/包含查询走全表扫描在千级执行器
 * 上不可接受。
 *
 * 幂等：`IF NOT EXISTS`，可重复执行；down 为 `DROP INDEX IF EXISTS`。
 * 与实体装饰器 `@Index("idx_executors_interpreters", { using: "gin" })` 对齐
 * （synchronize: false，实际 DDL 以本迁移为准）。
 */
export class AddExecutorInterpretersGinIndex1790000000027 implements MigrationInterface {
  name = "AddExecutorInterpretersGinIndex1790000000027";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_executors_interpreters" ON "executors" USING GIN ("interpreters")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_executors_interpreters"`,
    );
  }
}
