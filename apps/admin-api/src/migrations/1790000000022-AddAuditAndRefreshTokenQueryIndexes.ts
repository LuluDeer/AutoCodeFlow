import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * PK-16（DEEP_REVIEW 0ef3bbe packages 批）：audit_logs / refresh_tokens
 * 实际查询面缺索引支撑。
 *
 * 背景：
 * - audit_logs 是 append-only 高频写入表（append-only 触发器已上），
 *   AuditService 列表查询按 action/resource/userId/username 过滤 +
 *   createdAt DESC 排序——单列 idx_audit_logs_action（1717473142683 建）
 *   只能过滤不能免排序，随数据量线性劣化；本迁移补
 *   (action, createdAt) 复合索引（过滤 + 排序一索两用）。
 * - refresh_tokens：AuthService 会话列表按 (userId, revoked) 查、
 *   定时清理按 expiresAt LessThan(now) DELETE——两个列都无索引，每轮
 *   清理全表扫描。补 userId / expiresAt 两个普通索引。
 *
 * 命名对齐 1717473142683（AddPerformanceIndexes）既有风格
 * （idx_<table>_<col>[_<col>]，camelCase 列名转 snake 段）。
 *
 * 幂等：CREATE/DROP INDEX IF [NOT] EXISTS，重复执行与 revert 重放均无
 * 副作用。全部为非唯一普通索引，不触碰数据行。
 *
 * 并发建索引（PK-16 补充）：audit_logs 是高频写入大表，非并发 CREATE INDEX
 * 会长时间阻塞写入。三个索引均走 CREATE INDEX CONCURRENTLY——PG 硬约束
 * "CONCURRENTLY 不能在事务块内执行"，故本迁移声明 transaction = false
 * （TypeORM MigrationExecutor 读取迁移实例属性 transaction，false 时不包
 * 外层事务）；两条必须同时成立，缺一即报
 * "CREATE INDEX CONCURRENTLY cannot run inside a transaction block"。
 * 每条语句自身原子（失败半成品索引由 PG 自动清理），IF NOT EXISTS 保证
 * 重跑可重入。
 *
 * 回滚对称（第 4 轮 T3 守卫 check-migration-symmetry 抓到的「回滚锁表」）：
 * down 曾是普通 `DROP INDEX`——audit_logs 是 append-only 高频写表，普通
 * DROP 取 ACCESS EXCLUSIVE 锁，回滚期间整表写入排队，「up 不锁写」的目标
 * 被 down 自己抵消。现改为 `DROP INDEX CONCURRENTLY IF EXISTS`：up 用
 * CONCURRENTLY 建，down 就必须同样 CONCURRENTLY 拆（守卫判据：两侧
 * CONCURRENTLY 必须一致，理由「回滚会锁表」）。DROP 也是单条语句、同样吃
 * 连接池 30s statement_timeout（被取消会中断回滚并留下半删索引），故 down
 * 复用 up 的会话级 SET + finally RESET 豁免（口径同 1790000000075）。
 */
export class AddAuditAndRefreshTokenQueryIndexes1790000000022 implements MigrationInterface {
  name = "AddAuditAndRefreshTokenQueryIndexes1790000000022";

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
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_audit_logs_action_created_at"
      ON "audit_logs" ("action", "createdAt")
    `);

      await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_refresh_tokens_user_id"
      ON "refresh_tokens" ("userId")
    `);

      await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_refresh_tokens_expires_at"
      ON "refresh_tokens" ("expiresAt")
    `);
    } finally {
      await queryRunner.query(`RESET statement_timeout`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 与 up 对称：普通 DROP INDEX 会锁表（ACCESS EXCLUSIVE），必须
    // CONCURRENTLY；超时豁免同 up（单条语句受 30s 限制，被取消则回滚半途
    // 中断、留下半删索引）。逆序回收与 up 相反。
    await queryRunner.query(`SET statement_timeout = 0`);
    try {
      await queryRunner.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "idx_refresh_tokens_expires_at"
    `);

      await queryRunner.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "idx_refresh_tokens_user_id"
    `);

      await queryRunner.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "idx_audit_logs_action_created_at"
    `);
    } finally {
      await queryRunner.query(`RESET statement_timeout`);
    }
  }
}
