import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * db-2（第 3 轮并行审计，P2）：`tasks` 补 `(createdAt DESC, id DESC)` 索引。
 *
 * ## 缺陷
 * `GET /tasks` 的两条分页路径（keyset 与 OFFSET）默认排序都是
 * `createdAt DESC, id DESC`，而 `tasks` 表上**没有任何以 createdAt 开头的
 * 索引**——实体里的 `@Index(["createdAt"])` 是未命名声明（TypeORM 会生成哈希
 * 名），而本仓 `synchronize=false` + 迁移是 schema 唯一来源，这句声明从未落库。
 * 于是每个列表请求都是「全表读 + Sort(top-N) + 一次全表 COUNT」；keyset 分页
 * 只省掉了 OFFSET 的跳过成本，没省掉排序与扫描。
 *
 * ## 为什么 DESC
 * 排序固定倒序（最新在前）。B-tree 可以反向扫描，但 `id DESC` 作为**并列
 * 决胜键**必须与第一列同向，否则 (createdAt, id) 的 keyset 条件
 * （`(createdAt, id) < (:c, :i)`）无法用同一个索引序满足。
 *
 * ## 并发与超时
 * 与 db-1 同一纪律：`transaction = false`（CONCURRENTLY 不能在事务块内），
 * 连接池的 statement_timeout=30s 必须用**会话级** SET 临时关闭并在 finally
 * RESET——超时被取消会留下 indisvalid=false 的同名索引，而 `IF NOT EXISTS`
 * 重跑时会命中它并直接跳过（索引永远建不起来）。
 */
export class AddTasksCreatedAtIdIndex1790000000075 implements MigrationInterface {
  name = "AddTasksCreatedAtIdIndex1790000000075";

  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET statement_timeout = 0`);
    try {
      await queryRunner.query(`
        CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_tasks_created_at_id"
        ON "tasks" ("createdAt" DESC, "id" DESC)
      `);
    } finally {
      await queryRunner.query(`RESET statement_timeout`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET statement_timeout = 0`);
    try {
      await queryRunner.query(
        `DROP INDEX CONCURRENTLY IF EXISTS "idx_tasks_created_at_id"`,
      );
    } finally {
      await queryRunner.query(`RESET statement_timeout`);
    }
  }
}
