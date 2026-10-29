import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * B-3（调度域审计）：tasks.dependencies 值检索 GIN 表达式索引。
 *
 * 背景：依赖扇出（TaskService.triggerDependentTasks，挂在每次 SUCCESS 回调
 * 唯一赢家分支）此前对 `dependencies IS NOT NULL` 的全部任务做**无 take
 * 全表拉取**后内存过滤——有依赖的任务行数随业务线性增长，每次上游成功都
 * 物化一遍。现查询改为 JSONB containment 谓词下推 SQL。
 *
 * 索引形态推导（dependencies 契约 = {显示名: 上游任务id}，FIX-1.1 / 迁移
 * 1790000000048——**value 才是依赖任务 id**）：谓词「任一 value == <id>」
 * 对 object 形态没有直接的列级 @> 形态（键未知，`dependencies @> '{"?":"id"}'`
 * 不成立），故索引建在**值投影表达式**上：
 *
 *   jsonb_path_query_array("dependencies", '$.keyvalue().value')
 *
 * 查询用逐字相同的表达式把 values 投影成数组后做数组包含
 * `@> '["<id>"]'`——表达式与谓词左操作数对齐才能吃到索引（对齐关系由
 * add-tasks-dependencies-values-gin-index.migration.spec 断言，任何一侧
 * 漂移即红）。jsonb_path_query_array（非 _tz 变体）自 PG 13 起为 IMMUTABLE，
 * 可作表达式索引项（本仓 PG 基线 16，docker-compose postgres:16-alpine）；
 * opclass 选 jsonb_path_ops：本查询面只用 @>（jsonb_path_ops 的专长），
 * 换取更小的索引体积与更快的写入维护。task 写入是低频管理面操作，
 * CONCURRENTLY 建索引避开长事务锁表——PG 硬约束「CONCURRENTLY 不能在事务
 * 块内执行」，故声明 transaction = false（同 1790000000049 / 0051 口径）。
 * IF NOT EXISTS / IF EXISTS 保证重放可重入。
 */
export class AddTasksDependenciesValuesGinIndex1790000000053 implements MigrationInterface {
  name = "AddTasksDependenciesValuesGinIndex1790000000053";

  /** CONCURRENTLY 不能在事务内执行——本迁移不走外层事务（见类注释） */
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 连接池对每条语句设 statement_timeout=30s；CONCURRENTLY 是**单条**
    // 语句，大表构建可能超过 30s。本迁移 transaction=false，SET LOCAL
    // 没有事务块会退化成警告 + 无效（对照 0037 的写法不可照抄）——因此
    // 用会话级 SET 并在 finally 复位（连接会归还池，污染会波及后续查询）。
    // 超时的后果不是"重跑即可"：PG 会留下 indisvalid=false 的同名索引，
    // IF NOT EXISTS 会命中它并跳过，索引永远建不起来。
    await queryRunner.query(`SET statement_timeout = 0`);
    try {
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_tasks_dependencies_values_gin"
      ON "tasks" USING GIN ((jsonb_path_query_array("dependencies", '$.keyvalue().value')) jsonb_path_ops)
    `);
    } finally {
      await queryRunner.query(`RESET statement_timeout`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 人工 revert 路径（维护窗口执行）：CONCURRENTLY DROP 与 up 同约束
    // （transaction = false 已声明）。
    await queryRunner.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "idx_tasks_dependencies_values_gin"
    `);
  }
}
