import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 技术债 A 组（2026-10-01）：tasks.name 缺唯一约束——任务重名的强保证落地。
 *
 * 背景：模板实例化（task-template.service.instantiate 的同名 409 预检查）与
 * R6（task.service.create 的主键查重）都只是 best-effort：预检查与落库之间
 * 存在并发窗口，同 name 双写此前畅通无阻（task-template.service 注释里
 * 「并发窗口下仍可能双写……可接受」是当时无索引下的妥协，非设计意图）。
 * 任务名是全仓面向人的主键位（前端跳转、通知文案、执行器日志、依赖链显示名
 * 快照），同名任务会让「这条日志属于哪个任务」不可判读。本迁移补上 DB 层
 * 的最终防线。
 *
 * 存量脏数据处理（去重先例：AddTaskVersionsUniqueIndex1790000000021 /
 * AddAppDeploymentsInFlightUniqueIndex1789000000000）：若库中已积累同 name
 * 多行，直接建唯一索引会失败并中断迁移。先做一次**确定性去重**：
 * - 每组同 name 保留 (createdAt ASC, id ASC) 排序下的**最早一行**——先创建
 *   的任务是同名语义的「原本」，后到的是本该被 409 挡住的重复（与 R6 预检查
 *   「已存在即拒绝」的语义一致）；
 * - 其余行**改名**为 `name (uuid前8位)` 而非删除：软删除（回收站）与执行
 *   历史都以 taskId 关联，删行会悬挂引用；改名保留全部行且解除重名；
 * - (createdAt, id) 双键排序保证结果确定（同毫秒批量创建时 id 决胜）；
 * - 残余边角：若恰有一行现存名字等于另一组某行的 `name (uuid前8位)` 拼接
 *   结果，UPDATE 仍会撞本迁移要建的索引——概率可忽略（要求人工预先造出
 *   「名字 + 另一任务 uuid 前 8 位」的字面同名列），不做二次消解。
 *
 * 注意去重组**包含软删除行**（deletedAt 非空）：唯一索引是全行谓词，软删除
 * 行同样占名——语义变化：同名任务进回收站后，新建同名任务此前（预检查只查
 * 未删行）可行、现在会 409。这是「名字全局唯一」的必然推论，写面 23505
 * 已转 409 可读报错。
 *
 * 并发建索引：tasks 是高频写表（调度器每 tick 读、触发链路写），走
 * CREATE UNIQUE INDEX CONCURRENTLY——PG 硬约束「CONCURRENTLY 不能在事务块内
 * 执行」，故声明 transaction = false（同 1790000000049 / 1790000000022 口径）。
 * 每条语句自身原子，IF NOT EXISTS 保证重跑可重入。down 为人工 revert 路径
 * （维护窗口执行），保持普通 DROP；被改名行的原名不可从索引回滚复原。
 */
export class AddTasksNameUniqueIndex1790000000050 implements MigrationInterface {
  name = "AddTasksNameUniqueIndex1790000000050";

  /** CONCURRENTLY 不能在事务内执行——本迁移不走外层事务（见类注释） */
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 存量去重：每组同 name 仅保留最早一行（(createdAt, id) 决胜），其余
    // 改名为 `name (uuid前8位)`——策略见类注释。
    await queryRunner.query(`
      UPDATE "tasks" t
      SET "name" = t."name" || ' (' || substr(t.id, 1, 8) || ')'
      FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY "name"
                 ORDER BY "createdAt" ASC, id ASC
               ) AS rn
        FROM "tasks"
      ) ranked
      WHERE ranked.id = t.id AND ranked.rn > 1
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "idx_tasks_name_unique"
      ON "tasks" ("name")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_tasks_name_unique"
    `);
    // 被去重改名的行不可复原（原名未留痕）；down 仅恢复无约束形态。
  }
}
