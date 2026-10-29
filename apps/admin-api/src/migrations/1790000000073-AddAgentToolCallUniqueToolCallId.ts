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
 *
 * ## db-5（第 3 轮并行审计，P2）：唯一索引拆到迁移 0077
 * 原实现在同一条迁移里「全表自连接 DELETE + 普通 CREATE UNIQUE INDEX」：
 * 后者持 SHARE 锁阻塞 agent_tool_calls 的每一次工具记账（= agent 循环的
 * 每一步）直到建完，且整条迁移受连接池 30s statement_timeout 约束。
 * `agent_tool_calls` 是随使用增长的宽表，升级窗口内可能远超 30s。
 *
 * 拆法：本迁移只做**去重**（可重复执行、无锁升级风险）；唯一索引由
 * `1790000000077` 用 `CREATE UNIQUE INDEX CONCURRENTLY` 建（transaction=false +
 * 会话级超时豁免）。顺序敏感：必须先删重再建唯一索引，所以不能合成一条
 * （CONCURRENTLY 不能在事务块内）。
 *
 * down 只做幂等空操作：被删的重复行**不可恢复**（头注不承诺数据回滚）。
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
  }

  public async down(): Promise<void> {
    // 重复行已删除，down 无法还原（也不应该伪造数据）；唯一索引由 0077 的
    // down 负责。这里保留空实现，避免 revert 时误以为能回滚数据。
  }
}
