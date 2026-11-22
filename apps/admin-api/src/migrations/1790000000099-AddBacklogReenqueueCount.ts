import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * R216：给 **「积压」自动补入队** 一个持久化计数列。
 *
 * ## 为什么需要这一列（判据 §3.2 / §3.1）
 *
 * 「积压」= 会话 `pending` 但队列里**没有任何指向它的 job** ⇒ 它**永远不会被执行**。
 * 自动补入队是本仓**唯一**一条自动处置的判据（其余五条都只告警），所以副作用必须被封顶。
 *
 * **为什么落在库而不是进程内 `Set`**（与 `autoResumeCount` 同款理由）：
 * 本仓支持多副本且 admin-api 会重启 —— 进程内计数在 N 个副本上就是 **N 次补**，
 * 重启后清零就是**无限补**。条件写
 * `"backlogReenqueueCount" < 1 AND status = 'pending'` 让「每会话最多自动补一次」
 * 在**多实例下也成立**。
 *
 * **为什么不能只看队列**（这是本列存在的**核心**理由）：
 * 「补了但队列里查不到」有两种成因 ——
 *   ① `queue.add` 失败（**该**重试）；
 *   ② add 成功但 job 已被消费/清理（**不该**再补）。
 * 队列本身**分不开**这两者；落库的计数**记得**「我试过」。
 *
 * **为什么不复用 `autoResumeCount`**：两者语义完全不同 ——
 * 前者是「`pending` 且无 job」（永远不跑），后者是「LLM 瞬时错误导致 `waiting_input`」（会跑）。
 * 共用一个计数会让「自动续跑用掉了额度」把自动补也一起禁掉（或反之）。
 *
 * ## 形状（为什么可空 + 默认 0）
 *
 * `integer NULL DEFAULT 0` ⇒ PG 11+ **catalog-only**（不重写表、**零回填**）；
 * 存量行 = `0` = 「从未自动补过」，语义天然正确，与引入本列前**逐字节一致**。
 * 读取侧一律按 `?? 0` 处理（`null` 与 `0` 等价）。
 *
 * ## 不建索引
 *
 * 唯一访问形态是按主键 `WHERE id = :id` 的条件写（CAS），不需要额外索引；
 * 加索引只会给会话行的高频写面增加维护成本。
 *
 * ## 回滚
 *
 * `down()` = `DROP COLUMN IF EXISTS`。回滚**不需要数据修补**：本列的值可由
 * 「该会话是否已被自动补过」重建，最坏从 0 重新累计 ⇒ 短时**多补一次**（`jobId = session.id`
 * 幂等 ⇒ 无害）。⚠️ 这与「少补优于多补」的总纪律**方向相反**，但影响被幂等性兜住，
 * 如实登记在此。
 */
export class AddBacklogReenqueueCount1790000000099 implements MigrationInterface {
  name = "AddBacklogReenqueueCount1790000000099";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ① 载体列：可空 + 默认 0 ⇒ metadata-only、存量零回填。
    await queryRunner.query(`
      ALTER TABLE "agent_sessions"
        ADD COLUMN IF NOT EXISTS "backlogReenqueueCount" INTEGER NULL DEFAULT 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "agent_sessions"
        DROP COLUMN IF EXISTS "backlogReenqueueCount"
    `);
  }
}
