import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 推理质量轮（2026-10）：agent_tool_calls 补 `toolCallId`。
 *
 * ## 为什么需要这一列
 * `rebuildMessages()` 是「会话可中断可恢复」的实现本身：每次进入循环都从
 * `agent_steps` + `agent_tool_calls` 重建 messages。此前工具结果只能按
 * `(stepId, toolName)` 关联——而一个 assistant 步可以带**多个同名**调用
 * （模型并行查两次 `get_execution` 是常见形态），于是：
 *
 *   · 两个调用的重放会命中**同一行**记录；
 *   · 模型看到的是"两次查询得到了相同的答案"，而第二次的真实结果从未被读。
 *
 * 恢复路径（审批 grant、admin-api 重启、重复入队）是主路径而非边角，
 * 所以这不是展示瑕疵，而是**上下文事实被写错**。
 *
 * ## 为什么存量行不回填
 * 迁移前写入的行里没有任何信息能可靠地把「哪一行属于哪个 tool_call」倒推
 * 出来（同 step 同名调用恰恰是歧义所在）。按 stepId 顺序硬映射等于伪造
 * 关联，与 1790000000055/0061/0068 的结论一致：**不猜映射**。
 * 读面对 NULL 退回 `(stepId, toolName)` 兜底并保证一行只消费一次——
 * 存量会话仍能重建（不会 400），只是同名多调用仍无法区分（如实的历史局限）。
 *
 * 索引：不建。查询面固定是 `WHERE sessionId = ?`（已有
 * `idx_agent_tool_calls_sessionId`），单会话行数在几十量级，无索引必要；
 * 给一张写多读少的审计表多加索引只是拖慢写入。
 *
 * down：DROP COLUMN IF EXISTS（新增可空列，回收无数据损失）。
 */
export class AddAgentToolCallToolCallId1790000000069 implements MigrationInterface {
  name = "AddAgentToolCallToolCallId1790000000069";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_tool_calls" ADD COLUMN IF NOT EXISTS "toolCallId" VARCHAR(128) NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_tool_calls" DROP COLUMN IF EXISTS "toolCallId"`,
    );
  }
}
