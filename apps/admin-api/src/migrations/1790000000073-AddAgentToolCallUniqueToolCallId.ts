import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * GAP-5（工具执行 DB 级幂等）：`agent_tool_calls` 补 partial unique index
 * `(session_id, tool_call_id) WHERE tool_call_id IS NOT NULL`。
 *
 * ## 为什么需要
 * toolCallId 是「模型给的 tool_call id」，重放/恢复路径唯一的可靠关联键
 * （迁移 069 的头注）。但写入侧 recordToolCall 是无条件 insert——一旦发生
 * 双跑（markRunning fence 之前的存量风险）或未来任何重放路径，同一
 * call.id 会重复记账；rebuildMessages 的 rowByCallId 索引在重复行下取到
 * 任意一行，模型看到的「工具结果」变成不确定的选择。DB 级唯一约束是
 * 应用层 fence 之外的第二道独立防线：即使应用层失效，同一 tool_call 的
 * 第二次记账也会被 DB 拒绝。
 *
 * ## 为什么是 partial index
 * toolCallId 可空（存量行/畸形调用为 NULL）——PostgreSQL 的唯一索引对
 * NULL 不去重，但 partial `WHERE tool_call_id IS NOT NULL` 语义更明确，
 * 且让 NULL 行完全不进入索引（体积更小）。
 *
 * ## 存量去重
 * 唯一约束建不上 = 存量已有重复（双跑遗留）。迁移先按 (session_id,
 * tool_call_id) 保留最早一行（CTE + row_number），删掉其余——工具调用
 * 台账是 Append-only 审计面，但同一 call.id 的重复行本身就是数据缺陷
 * （双跑伪证），保留首条与「首条台账为准」的应用语义一致。
 */
export class AddAgentToolCallUniqueToolCallId1790000000073 implements MigrationInterface {
  name = "AddAgentToolCallUniqueToolCallId1790000000073";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 存量去重：同 (session_id, tool_call_id) 保留 createdAt 最早（id 稳定
    // 排序兜底同刻），其余删除。索引建好后该形态不再可能。
    await queryRunner.query(`
      DELETE FROM "agent_tool_calls" a
      USING "agent_tool_calls" b
      WHERE a."sessionId" = b."sessionId"
        AND a."toolCallId" = b."toolCallId"
        AND a."toolCallId" IS NOT NULL
        AND (b."createdAt", b."id") < (a."createdAt", a."id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_agent_tool_calls_session_toolCallId"
      ON "agent_tool_calls" ("sessionId", "toolCallId")
      WHERE "toolCallId" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_agent_tool_calls_session_toolCallId"`,
    );
  }
}
