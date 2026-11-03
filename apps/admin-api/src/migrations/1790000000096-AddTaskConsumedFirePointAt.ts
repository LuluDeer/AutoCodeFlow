import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * A6b：显式「提前触发并消耗下一个计划点」入口的**登记载体**。
 *
 * ## 需求（产品 2026-11-03 拍板，原话）
 *
 * > 手动执行不算覆盖计划落点；**除非**给一个入口**提前触发**，去**消耗最近 1 次 cron**。
 *
 * ⇒ 本列登记「**下一个** cron 落点已被人工提前触发消费掉」，到该时刻调度器
 * **跳过一次**并清除登记（一次性，不是永久 mute）。
 *
 * ## 为什么是新列而不是复用 `lastTriggerTime`（丙方案的**证伪**）
 *
 * `lastTriggerTime` 有 **3 个写点**（CodeGraph `impact` + 全量 grep 核实）：
 *   ① `scheduler.claimTaskTrigger`（`scheduler.service.ts`）—— 条件 UPDATE 推进
 *      触发时刻（去重判决）；
 *   ② `task.claimDependencyTrigger`（`task.service.ts`）—— **依赖扇出**复用同列
 *      （A1 文档点名的路径）；
 *   ③ `task.rollbackDependencyClaim` —— ② 的 CAS 回滚。
 *
 * 若把「未来落点」写进 `lastTriggerTime`：
 *   · `now - lastTriggerTime` 变**负** ⇒ `checkMisfiresBody` 的
 *     `gap > threshold` 恒不成立 ⇒ **misfire 永久失明**；
 *   · ① 的条件 UPDATE 谓词 `"lastTriggerTime" IS NULL OR "lastTriggerTime" <
 *     :windowStart` 永不命中 ⇒ 该任务**再也无法被任何路径触发**（永久死任务）；
 *   · ③ 的 CAS 回滚会把它回滚到未来值。
 * ⇒ 丙是**破坏性**方案，已否。
 *
 * ## 为什么不是新表（乙方案）
 *
 * 本需求的登记**恒为「每任务至多一条」**（重复勾选按 409 拒绝，见
 * `TaskService.registerConsumedFirePoint`）⇒ 不需要历史流水、不需要 join、
 * 不需要清理策略 ⇒ 新表属**过度建模**。单列 + 条件 UPDATE 天然满足
 * 「至多一条 + 原子」。
 *
 * ## 形状与幂等
 *
 * · 列可空、**无 DEFAULT** ⇒ metadata-only、**零回填**；存量行全 NULL =
 *   「没有未消耗登记」，语义天然正确。
 * · `ADD COLUMN IF NOT EXISTS` ⇒ 重放无副作用；`down` 逆序 `DROP COLUMN IF
 *   EXISTS`。
 * · 不用 CONCURRENTLY：`tasks` 是每租户几十~几千行的表（非执行记录那种
 *   百万级表），且 CONCURRENTLY 不能在迁移事务里跑。
 */
export class AddTaskConsumedFirePointAt1790000000096 implements MigrationInterface {
  name = "AddTaskConsumedFirePointAt1790000000096";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 登记列：可空、无默认 ⇒ metadata-only，存量零回填。
    await queryRunner.query(`
      ALTER TABLE "tasks"
        ADD COLUMN IF NOT EXISTS "consumedFirePointAt" TIMESTAMP NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tasks"
        DROP COLUMN IF EXISTS "consumedFirePointAt"
    `);
  }
}
