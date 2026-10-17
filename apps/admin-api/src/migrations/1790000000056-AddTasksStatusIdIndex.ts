import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * PERF-3（调度扫描的复合索引）：`tasks(status, id)`。
 *
 * ## 为什么必须加
 *
 * 调度器的三条热查询都是同一个形态——**按状态过滤 + 按 id keyset 翻页**：
 *
 *   SELECT ... FROM tasks WHERE status = 'active' [AND id > $cursor]
 *   ORDER BY id ASC LIMIT <page>
 *
 * （`scheduler.service.checkMisfiresBody` / `loadSchedulesFromDatabase`
 * 的 active 集合扫描，两处都是 `ACTIVE_TASK_PAGE_SIZE` 分页循环。）
 *
 * 既有索引帮不上忙：
 *  - `idx_tasks_status`（1717473142683）只覆盖 `status` 一列，命中后仍需按
 *    主键把该状态的全部行取出再排序——单状态占多数时等于全表扫 + 排序；
 *  - `idx_tasks_status_trigger_type`（同迁移）第二列是 `triggerType`，与
 *    `ORDER BY id` 不对齐，同样退化为排序。
 *
 * 复合 `(status, id)` 让「等值前缀 + 有序后缀」一次吃满：status 定界后 id
 * 天然有序，游标翻页变成索引区间扫描，`ORDER BY id` 的排序步骤整个消失。
 * 这也顺带覆盖所有 `WHERE status = $1 ORDER BY id` 的读面（调度 tick 每
 * 秒级触发，是 tasks 表最高频的读形态）。
 *
 * ## 为什么保留 `idx_tasks_status`
 *
 * 它是 `(status, id)` 的**严格左前缀**，理论上冗余。但删除索引是不可逆的
 * 决策（其它读面/统计可能依赖它，且删错了只能重建），本轮只做「加」——
 * 冗余索引的代价是每次写多维护一棵 B 树，而 tasks 是低频写表。收敛留给
 * 后续有实测依据的一轮（先例：1790000000051 删冗余索引前先由 1790000000049
 * 建好覆盖索引）。
 *
 * ## CONCURRENTLY / 事务
 *
 * `transaction = false` + `CREATE INDEX CONCURRENTLY`：tasks 行数可能上万
 * 且调度器持续在读，普通 CREATE INDEX 的写锁会让建索引期间的任务创建/
 * 更新阻塞（同 1790000000049 / 0053 / 0055 的大表纪律）。PG 硬约束
 * 「CONCURRENTLY 不能在事务块内执行」，故必须声明 transaction = false
 * （migrationsTransactionMode = "each" 下 per-migration 覆盖生效）。
 *
 * `IF NOT EXISTS` / `IF EXISTS` 保证重放可重入。
 */
export class AddTasksStatusIdIndex1790000000056 implements MigrationInterface {
  name = "AddTasksStatusIdIndex1790000000056";

  /** CONCURRENTLY 不能在事务内执行——本迁移不走外层事务（见类注释） */
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 单行字符串是刻意的：scripts/check-index-drift.mjs 的 DDL 扫描器按正则
    // 匹配**同一行内**的语句（先例 1790000000055 的同款注释）。
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_tasks_status_id" ON "tasks" ("status", "id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 人工 revert 路径：CONCURRENTLY DROP 与 up 同约束（transaction = false）。
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "idx_tasks_status_id"`,
    );
  }
}
