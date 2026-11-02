import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * G2-风险 1（S7 编排交叉分析 · §G2「风险 1」）：执行行的**合成**标记。
 *
 * ## 这一列解决的是什么
 *
 * G2 为「未声明失败边」的下游在上游失败时落了一条 `cancelled` 执行行——目的是让
 * `list_executions` 里能看到「它因为上游失败而**没跑**」（在此之前这种状态在库里
 * 完全不可见，运维只能靠推断）。
 *
 * 但 `areDependenciesSatisfied`（`modules/task/dependency-gate.util.ts`）判定依赖时
 * 看的是「依赖任务**最新**的一行执行」。于是那条 `cancelled` 行一旦成为该下游的
 * 最新行，**该下游的下游（孙节点）**读到的就是 `cancelled` 而不是它上次的
 * `SUCCESS`——在孙节点未声明失败边（`acceptFailure=false`，默认）时 `cancelled`
 * 不算满足 ⇒ **孙节点静默不触发**。为了「没跑」可见，反而让「本来会跑」的不跑，
 * 这与 Hatchet 的 cancelled 级联是同一副作用。
 *
 * ## 列语义
 *
 * | 值 | 含义 | 是否参与依赖判定 / 「最新执行」语义 |
 * |---|---|---|
 * | `false`（默认） | **一次真实尝试**（或至少是真实触发产生的行） | 是（与引入本列前**逐字节相同**） |
 * | `true` | 为**可见性合成**的行：没有进程跑过，只表达「它因上游失败而没跑」 | **否**——被依赖闸门当作不存在 |
 *
 * ## 为什么 `NOT NULL DEFAULT false` 而不是可空
 *
 * 可空 + NULL 会给出第三个真值状态，而这里只有两种事实（真实尝试 / 合成行），
 * 没有「不知道」：
 * - 存量行在语义上**确实都是真实尝试**（迁移前不存在合成行的建行路径）；
 * - 故 `DEFAULT false` 让存量行天然正确，**不需要回填**（回填一次全表 UPDATE 才是
 *   真正的写放大）。
 *
 * 顺带一个必要条件：`NOT NULL DEFAULT false` 在 PG 11+ 是 **metadata-only**
 * （默认值非易失，只改 catalog、不重写表），大表上可直接执行。
 *
 * ## 读面
 *
 * `list_executions`（`getExecutions` / `getAllExecutions`）的列投影是「实体列全集
 * − 重型文本列」（`execution-list-projection.ts` 的排除表），新列自动入选——**不在
 * 列表查询里过滤**，这正是合成行存在的全部价值。合成行只在依赖判定与「最新执行」
 * 语义里被跳过。
 *
 * 幂等：`IF NOT EXISTS` / `IF EXISTS`，重复执行与 revert 重放均无副作用。
 */
export class AddExecutionSynthetic1790000000091 implements MigrationInterface {
  name = "AddExecutionSynthetic1790000000091";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 为可见性合成的行（true）不参与依赖判定 / 最新执行语义；默认 false = 真实尝试。
    await queryRunner.query(`
      ALTER TABLE "task_executions"
      ADD COLUMN IF NOT EXISTS "synthetic" BOOLEAN NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "task_executions" DROP COLUMN IF EXISTS "synthetic"
    `);
  }
}
