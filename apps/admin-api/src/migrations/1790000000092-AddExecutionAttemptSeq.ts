import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * G3（P2）：给执行加**「尝试世代」维度**——`task_executions.attemptSeq`。
 *
 * ## 这只列解决的是什么（为什么纯状态门不够）
 *
 * 终态门（`execution-terminal.ts` 的 `WHERE "id" IN (:...ids) AND "status" IN (:...gate)`）
 * 是**纯状态**的：它只回答「这行现在还开着吗」，不回答「这是**第几回合**的开着」。
 * 而一条执行**可以经历多个「打开态 → 终态」回合**（`execution-finalization.entity.ts`
 * 的注释已逐字承认这一点），本仓至少有两条路径会让**同一个 `executionId`** 重新变成
 * RUNNING：
 *
 *   ① `task.processor.ts` 的 claim 把 `FAILED` 也算作可 claim（BullMQ 重试复用同一个
 *      job，payload 只有 `{executionId}`）；三条入队点（`task.service.trigger` /
 *      `task.service` 回滚重放 / `scheduler`）都给同一个 job 配了 `attempts`；
 *   ② 互斥/部署约束的 WAITING 唤醒（`scheduler` 的条件翻回 PENDING 后重新入队）。
 *
 * 于是「上一回合派出去、到现在才回来的回调」与「本回合的正常回调」在 SQL 上**完全
 * 同形**（同 executionId、同 executorAddress、同 status=RUNNING），纯状态门只能
 * 两者都放行——上一回合的结果会把本回合的行**提前终态化**，本回合的真实结果随后
 * 落到 `affected=0` 的「重复回调」分支被丢掉。
 * （跨执行器的迟到回调已被 `task.service.handleCallback` 的回调地址/行身份三级校验
 * 挡住；**残留风险恰好只在同一执行器上**。）
 *
 * `attemptSeq` 把「第几回合」变成一个**单调递增的列**，让终态写入可以带上
 * `AND "attemptSeq" = :expected`：写入只在自己认领的那一回合仍然成立时命中。
 *
 * ## 为什么 `NOT NULL DEFAULT 0` 而不是可空
 *
 * 语义上 `attemptSeq` 是「这行被 claim 过的次数」的单调计数器，没有「不知道」这一态：
 * 迁移前不存在本列，**存量行的第一回合就是 0**，故 `DEFAULT 0` 让零回填即天然正确。
 * 顺带一个必要条件：`NOT NULL` + **非易失默认值**在 PG 11+ 是 **metadata-only**
 * （只改 catalog、不重写表），大表上可直接执行——与 1790000000091（synthetic）同口径。
 *
 * ## 增量语义（谁写它）
 *
 * **只有 claim 写它**，且用 `SET "attemptSeq" = "attemptSeq" + 1` 的 DB 侧自增
 * （`task.processor.ts` 的 TypeORM 函数式赋值），**不是读改写**：两个 worker 并发
 * claim 同一行时，claim 自己的 `status IN (pending, failed, waiting)` 谓词保证只有一个
 * 命中（RUNNING 不可 claim），命中者恰自增一次。读改写在并发下会两次都读到 0、都写 1。
 *
 * 幂等：`IF NOT EXISTS` / `IF EXISTS`，重复执行与 revert 重放均无副作用。
 */
export class AddExecutionAttemptSeq1790000000092 implements MigrationInterface {
  name = "AddExecutionAttemptSeq1790000000092";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 存量行 = 0 = 第一次尝试（迁移前不存在「同一行第二回合」的计数事实，0 是唯一
    // 不说谎的取值）；NOT NULL + 常量默认 = metadata-only，零回填、不重写表。
    await queryRunner.query(`
      ALTER TABLE "task_executions"
      ADD COLUMN IF NOT EXISTS "attemptSeq" INTEGER NOT NULL DEFAULT 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "task_executions" DROP COLUMN IF EXISTS "attemptSeq"
    `);
  }
}
