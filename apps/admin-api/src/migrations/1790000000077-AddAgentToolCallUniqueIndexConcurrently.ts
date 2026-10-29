import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * db-5（第 3 轮并行审计，P2）+ GAP-5：`agent_tool_calls` 的 partial unique
 * index 改用 `CREATE INDEX CONCURRENTLY` 建。
 *
 * ## 为什么拆到这里
 * 原 0073 在同一条迁移里「全表自连接 DELETE + 普通 CREATE UNIQUE INDEX」。
 * 普通建索引持 SHARE 锁阻塞整表写入直到建完——`agent_tool_calls` 每个工具
 * 调用一行（agent 循环的每一步都写），升级窗口内可能远超连接池 30s
 * statement_timeout，且失败会挡 boot。
 *
 * 0073 现在只负责**去重**（幂等、可重复执行）；本迁移负责建索引：
 *   · `transaction = false`：CONCURRENTLY 不能在事务块内；
 *   · 会话级 `SET statement_timeout = 0` + finally `RESET`：连接池 30s 超时
 *     会取消建索引并留下 `indisvalid=false` 的同名索引——而 `IF NOT EXISTS`
 *     重跑会命中它直接跳过，索引永远建不起来（db-1 纪律与启动自检兜底）；
 *   · partial 谓词与本表语义一致：`toolCallId` 可空，NULL 行不进索引。
 *
 * 幂等：既有库若 0073 已建过同名索引，本迁移的 `IF NOT EXISTS` 是 no-op。
 */
export class AddAgentToolCallUniqueIndexConcurrently1790000000077 implements MigrationInterface {
  name = "AddAgentToolCallUniqueIndexConcurrently1790000000077";

  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET statement_timeout = 0`);
    try {
      await queryRunner.query(`
        CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "uq_agent_tool_calls_session_toolCallId"
        ON "agent_tool_calls" ("sessionId", "toolCallId")
        WHERE "toolCallId" IS NOT NULL
      `);
    } finally {
      await queryRunner.query(`RESET statement_timeout`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET statement_timeout = 0`);
    try {
      await queryRunner.query(
        `DROP INDEX CONCURRENTLY IF EXISTS "uq_agent_tool_calls_session_toolCallId"`,
      );
    } finally {
      await queryRunner.query(`RESET statement_timeout`);
    }
  }
}
