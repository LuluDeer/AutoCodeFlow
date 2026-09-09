import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * OBS-03: execution_log_lines 增加可空 level 列（varchar(8)），值域
 * ERROR/WARN/INFO/DEBUG，null = 未知级别（存量行 + 文本推断不到的行）。
 * 写入路径 TaskService.storeLogLines 用 log-level.util.ts 的 levelOfLine
 * 为每行推断级别；查询路径 getExecutionLogs 支持 ?level= 过滤（SQL 层等值）。
 *
 * 索引：(executionId, level, lineNumber)。读取形态固定为 executionId 等值
 * +（可选）level 等值 + ORDER BY lineNumber 分页，三列复合让 level 过滤
 * 分页无需排序节点；未过滤路径仍走既有 (executionId, lineNumber) 索引。
 *
 * 幂等：IF NOT EXISTS / IF EXISTS；存量行 level 保持 NULL（不回填——历史
 * 行可安全重推的只有文本本身，回填收益低且大表 UPDATE 代价高，文档注明
 * null = 未知级别）。
 */
export class AddExecutionLogLineLevel1789300000000 implements MigrationInterface {
  name = "AddExecutionLogLineLevel1789300000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "execution_log_lines"
        ADD COLUMN IF NOT EXISTS "level" VARCHAR(8)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_execution_log_lines_execId_level_lineNumber"
      ON "execution_log_lines" ("executionId", "level", "lineNumber")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_execution_log_lines_execId_level_lineNumber"
    `);
    await queryRunner.query(`
      ALTER TABLE "execution_log_lines" DROP COLUMN IF EXISTS "level"
    `);
  }
}
