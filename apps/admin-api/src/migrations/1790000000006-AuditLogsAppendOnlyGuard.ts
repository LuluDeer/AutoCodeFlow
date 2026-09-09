import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * SEC-10「审计防篡改纵深（append-only 拍板）」：给 audit_logs 表加行级
 * 防改触发器——BEFORE UPDATE OR DELETE 时 RAISE EXCEPTION（SQLSTATE
 * P0001, errcode=ACFAUDIT），把「审计行不可改删」从应用层约定升级为
 * DB 层硬约束。
 *
 * 拍板论证（append-only vs hash-chain）：audit_logs 已有 admin 写面唯一
 * 入口（AuditService.log；findAll/exportCsv 只读），哈希链在 PG 侧
 * UPDATE 权限模型下收益/成本比差——链头要另存受保护位置、重算链要全表
 * 扫描、且防不住持 DBA 权限的攻击者改链头；append-only 触发器把最常见的
 * 篡改路径（UPDATE 改写/DELETE 灭迹）直接堵死，纵深收益即达成本下限。
 * 真正的越权 INSERT/直连 DB 篡改由 DB 账号权限模型兜底（不在应用面）。
 *
 * 合法 UPDATE 场景核查（结论：无）：
 * - AuditService 只暴露 log（INSERT save）与查询面（findAll/exportCsv，
 *   只读 QB），grep 全仓库无 audit_logs 的 UPDATE/DELETE 调用点；
 * - retention 清理（Q7 cleanupOldAuditLogs，180 天）目前是 service 内
 *   repo.delete——本迁移会使其抛错！这是刻意的：清理属于合法 DELETE，
 *   由 SECURITY_INVOKER 权限切分不现实（同一连接串），因此 cleanup 改为
 *   用 `SET LOCAL app.bypass_audit_guard = on`（见 AuditService）。
 *   触发器对 session GUC bypass=on 时放行——直连 psql 默认无此 GUC，
 *   仍被拦截；bypass 只能被能连 DB 的进程显式开启，纵深语义保持
 *   （应用内唯一放行点是 cleanup 定时任务）。
 *
 * 幂等：DROP TRIGGER IF EXISTS + CREATE TRIGGER（PG 无 CREATE OR REPLACE
 * TRIGGER）；重放/重复 up 均收敛到同一终态。函数 CREATE OR REPLACE。
 * 列名驼峰加引号对齐 TypeORM 默认命名策略。
 */
export class AuditLogsAppendOnlyGuard1790000000006 implements MigrationInterface {
  name = "AuditLogsAppendOnlyGuard1790000000006";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 防篡改守卫函数：UPDATE/DELETE 一律拒绝；仅当会话显式
    // SET LOCAL app.bypass_audit_guard = 'on'（retention 清理任务专用）
    // 时放行 DELETE。TG_OP 判别当前操作。
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION audit_logs_append_only_guard() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF current_setting('app.bypass_audit_guard', true) = 'on' THEN
            RETURN OLD;
          END IF;
          RAISE EXCEPTION 'audit_logs is append-only: DELETE denied (use retention cleanup job)'
            USING ERRCODE = 'P0001';
        END IF;
        RAISE EXCEPTION 'audit_logs is append-only: UPDATE denied'
          USING ERRCODE = 'P0001';
      END;
      $$ LANGUAGE plpgsql;
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_audit_logs_append_only ON "audit_logs"
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_audit_logs_append_only
      BEFORE UPDATE OR DELETE ON "audit_logs"
      FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only_guard()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_audit_logs_append_only ON "audit_logs"
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS audit_logs_append_only_guard()
    `);
  }
}
