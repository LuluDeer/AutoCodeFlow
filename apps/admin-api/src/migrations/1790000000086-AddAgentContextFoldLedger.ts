import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * S2-A2（R5/R18）：会话行补**折叠派生账本**与**连续不收敛计数**。
 *
 * ## 缺陷（两个真问题）
 * ① 折叠此前**只有一条 debug 日志**（agent-runtime.service.ts 的折叠分支）：
 *    长会话反复折叠，没人知道是否收敛，也无法回答「第 N 轮模型看到什么」；
 * ② `planContextWindow` 在「可折的都在最近段内 / 只剩一组」时返回 unchanged
 *    （`agent-context.ts` 的 `start <= 0` 早退），此时 `tokensAfter > maxTokens`
 *    却照原样发请求 ⇒ provider 400 ⇒ 会话作废，而这条路径**没有任何痕迹**。
 *
 * ## 为什么是「会话行加两列」而不是新表
 * · 账本行只按 `sessionId` 归属、只服务「这一轮模型看到什么」，没有跨表查询
 *   需求（会话详情页读一行即可）；
 * · 新表必须有清理路径，而 agent 域的清理任务只在
 *   `agent-session-retention.service.ts`（B-10：steps / tool_calls / approvals）。
 *   账本若独立成表又没接进那条 cron，就是**永不清理的新表**（终态会话本身
 *   不删除，`ON DELETE CASCADE` 等于没有）；挂在会话行上，生命周期与会话
 *   完全一致：行在账本在，行删账本走；
 * · 无界增长由**写入侧**封顶（`AGENT_CONTEXT_FOLD_LEDGER_MAX`，只留最近 100
 *   条，见 AgentSessionService.recordContextFold）——单行体积有界。
 *
 * ## 两列各是什么
 * · `contextFoldStreak`（int NOT NULL DEFAULT 0）：连续「折了但不收敛」轮数。
 *   判据是纯函数（`nextContextFoldStreak`：`foldedMessages > 0 && tokensAfter >
 *   maxTokens` 时 +1，否则清零），**状态必须落库**——`agent-context.ts` 头注
 *   逐字禁止读上一轮状态（多副本 + 重启下进程内计数必然错误）。DEFAULT 0 让
 *   存量行语义不变（零回填、零猜测：历史上没记过折叠，就不该假装记过）。
 * · `contextFoldLedger`（jsonb NULL）：`AgentContextFoldLedgerEntry[]` 的有界
 *   数组，每次「本轮超窗」追加一行（`foldedMessages: 0` 的行就是问题 ② 的
 *   可观测形态）。**只落派生**：不参与 `rebuildMessages`，不改写
 *   `agent_steps.summary`（那会造成双重折叠）。
 *
 * ## 为什么 metadata-only（不 CONCURRENTLY、不分批）
 * PG 11+ 的 `ADD COLUMN ... DEFAULT <非易变常量>` 只改系统目录，不重写表、不
 * 长时间持锁；jsonb 列可空且不回填。故**没有** CONCURRENTLY 的必要，也不需要
 * 分批回填脚本。down 对称删两列（`IF EXISTS`，重复执行安全）。
 *
 * ## 回滚的代价（必须知道）
 * down 会丢掉账本与计数——这两者是**纯派生观测**：折叠本身、steps、tool_calls
 * 全不受影响，会话仍可完整重建与复盘；代价只是「折叠收敛性」重新变成不可观测。
 * 「连续不收敛 → 终态」的收敛判据在回滚后会退化为永不触发（streak 恒 0）——
 * 这是**安全方向**的退化（退回 S2-A2 之前的现状），不会误杀会话。
 */
export class AddAgentContextFoldLedger1790000000086 implements MigrationInterface {
  name = "AddAgentContextFoldLedger1790000000086";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // NOT NULL DEFAULT 0 在 PG 11+ 是 metadata-only（不重写表），存量行自动为 0。
    await queryRunner.query(
      `ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "contextFoldStreak" integer NOT NULL DEFAULT 0`,
    );
    // 可空 + 不回填：历史上没记过折叠，就不该伪造账本。
    await queryRunner.query(
      `ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "contextFoldLedger" jsonb NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_sessions" DROP COLUMN IF EXISTS "contextFoldLedger"`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_sessions" DROP COLUMN IF EXISTS "contextFoldStreak"`,
    );
  }
}
