import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * db-2 残差：`audit_logs` 补 `("createdAt" DESC, "id" DESC)` 复合索引。
 *
 * ## 缺陷
 * `GET /audit/logs` 的两条分页路径（keyset 与 OFFSET）排序都是
 * `ORDER BY createdAt DESC, id DESC`（`findAllByKeyset` / `findAll` /
 * `exportCsv` 三处同形，见 audit.service），而 `audit_logs` 上只有
 *   · `idx_audit_logs_created_at`（单列 createdAt，迁移 1717473142683）；
 *   · `idx_audit_logs_action_created_at`（`action` + createdAt，迁移
 *     1790000000022，仅在按 action 过滤时才可能被选中）。
 * 于是「不按 action 过滤」的列表/导出只能走单列 createdAt 索引做范围扫描，
 * 再对**同一微秒内的多行**逐行回表 filter 才能定出 `id` 方向的区间；同刻行
 * 越多，这层过滤越贵（同事务批量写审计是常态）。审计日志只增不减，深翻页的
 * 成本随历史行数一起长。
 *
 * ## 为什么是 DESC 双键
 * 排序固定倒序（最新在前）。B-tree 可以反向扫描，但 `id DESC` 作为**并列决胜
 * 键**必须与第一列同向，否则 keyset 的元组比较
 * （`(createdAt, id) < (:createdAt, :id)`）无法用同一个索引序满足——两列同向
 * 时整个 WHERE 谓词就是索引上的一个位置，一次 index scan 直接命中续页起点，
 * 不需要 Sort、也不需要按 id 再过滤。列序同样是 keyset 形状（createdAt 在前、
 * id 在后），反过来（id, createdAt）吃不到「等值/范围前缀 + 有序后缀」。
 *
 * ## 为什么 CONCURRENTLY
 * `audit_logs` 是 append-only 高频写表（每个管理动作一行，且与业务事务同提交）。
 * 普通 `CREATE INDEX` 持 SHARE 锁，构建期间该表的每一次 INSERT 都被挡住——对
 * 在线审计表这等于把治理面拖停。CONCURRENTLY 只取短锁，构建期间读写继续。
 *
 * ## 为什么 down 也必须 CONCURRENTLY
 * 回滚发生在「升级出问题」的时刻，此时流量正在跑；普通 `DROP INDEX` 要
 * ACCESS EXCLUSIVE 锁，会排空整表写流量（大表上是升级事故的反向重演）。
 * 与 up 对称地用 `DROP INDEX CONCURRENTLY`，回滚同样不锁表。
 *
 * ## 事务与超时（db-1 纪律，与 1790000000075 同款）
 * CONCURRENTLY **不能在事务块内**执行 → 类级 `transaction = false`。
 * 连接池带 `statement_timeout=30s`，而 CONCURRENTLY 是单条语句：超时被取消会
 * 留下 `indisvalid=false` 的同名索引，重跑时 `IF NOT EXISTS` 命中它直接跳过，
 * 迁移记为已应用而索引**永远建不起来**。故 up/down 两侧都用**会话级**
 * `SET statement_timeout = 0` + `finally RESET`（`SET LOCAL` 在无事务时无效；
 * 连接归还池后不复位会污染后续查询）。
 */
export class AddAuditLogsCreatedAtIdIndex1790000000082 implements MigrationInterface {
  name = "AddAuditLogsCreatedAtIdIndex1790000000082";

  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET statement_timeout = 0`);
    try {
      await queryRunner.query(`
        CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_audit_logs_created_at_id"
        ON "audit_logs" ("createdAt" DESC, "id" DESC)
      `);
    } finally {
      await queryRunner.query(`RESET statement_timeout`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET statement_timeout = 0`);
    try {
      await queryRunner.query(
        `DROP INDEX CONCURRENTLY IF EXISTS "idx_audit_logs_created_at_id"`,
      );
    } finally {
      await queryRunner.query(`RESET statement_timeout`);
    }
  }
}
