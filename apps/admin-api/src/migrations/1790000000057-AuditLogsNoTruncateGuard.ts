import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * SEC-10 收口：给 audit_logs 补**语句级** `BEFORE TRUNCATE` 守卫。
 *
 * 已有 `trg_audit_logs_append_only`（迁移 1790000000006，本迁移不改它）是
 * `BEFORE UPDATE OR DELETE ... FOR EACH ROW`——`TRUNCATE` 是**语句级**操作，
 * 不逐行走行触发器，所以那条守卫对 `TRUNCATE audit_logs` **完全不生效**：
 * 一条语句即可清空全部审计记录。ADR-025 已把该缺口列为待收敛项（真机实测
 * `TRUNCATE` ALLOWED），本迁移把它补上。
 *
 * PG 固有限制（决定了本迁移的形态）：
 * - `TRUNCATE` 触发器**必须**是 `FOR EACH STATEMENT`；写成 `FOR EACH ROW`
 *   直接报错 `TRUNCATE FOR EACH ROW triggers are not supported`。因此这是
 *   独立的一条触发器 + 独立函数（`audit_logs_truncate_guard`），不能塞进
 *   1790000000006 的 FOR EACH ROW 函数里（那条靠 `RETURN OLD` 放行 DELETE，
 *   而语句级触发器没有行可返回）。
 * - 既有迁移**不可变**，故以 1790000000057 增量叠加；两条触发器共存互不干扰。
 *
 * 为什么 TRUNCATE **不给逃生门**（与 DELETE 的 `app.bypass_audit_guard` 不同）：
 * - 保留期清理（Q7，`AuditService.retentionDelete`）走的是**分批 DELETE**，
 *   不是 TRUNCATE：`SET LOCAL app.bypass_audit_guard = 'on'` + `repo.delete`。
 *   全仓检索（apps/**、packages/**、interpreters/**、scripts/** 及
 *   *.ts/*.js/*.mjs/*.sql/*.yml/*.json）对 `TRUNCATE ... audit_logs`
 *   **零命中**——没有任何代码路径需要 TRUNCATE 这张表，逃生门没有合法调用方。
 * - TRUNCATE 的语义是「清空整表」，与「按保留期删旧行」正交；给一个没有
 *   调用方的动作开逃生门，只会在未来把「一条语句抹掉全部痕迹」重新变成
 *   一个 GUC 开关就能做到的事。缺省拒绝才是这里的正确缺省。
 * - 若将来真出现合法全表重建需求（例如分区化改造），正确做法是**新增一条
 *   显式迁移**临时摘触发器，而不是在触发器里留常开的后门——那样重建动作
 *   在迁移历史里留痕，而不是变成运行期任意进程可打开的开关。
 *
 * 本迁移**不假装挡住**的两类（PG 固有语义，属主/超管本就能绕过，见
 * ADR-025 与 docs/operations.md 边界表）：表属主 `ALTER TABLE ... DISABLE
 * TRIGGER` 后再 TRUNCATE；超级用户 `SET session_replication_role = replica`
 * 后 TRUNCATE。触发器只能挡住「拿到 TRUNCATE 权限的普通路径」。
 *
 * 幂等：`CREATE OR REPLACE FUNCTION` + `DROP TRIGGER IF EXISTS` +
 * `CREATE TRIGGER`（PG 无 `CREATE OR REPLACE TRIGGER`）；重放/重复 up 收敛
 * 到同一终态。函数无参数、名字唯一，DROP/INIT 期间无歧义。
 */
export class AuditLogsNoTruncateGuard1790000000057 implements MigrationInterface {
  name = "AuditLogsNoTruncateGuard1790000000057";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 语句级 TRUNCATE 守卫函数：无条件拒绝，不读任何 GUC（无逃生门，
    // 见类注释的论证）。ERRCODE 沿用既有守卫的 P0001，应用侧可按同一
    // errcode 识别「防篡改拦截」。
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION audit_logs_truncate_guard() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'audit_logs is append-only: TRUNCATE denied'
          USING ERRCODE = 'P0001';
      END;
      $$ LANGUAGE plpgsql;
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_audit_logs_no_truncate ON "audit_logs"
    `);
    // 必须 FOR EACH STATEMENT：TRUNCATE 触发器不支持 FOR EACH ROW。
    await queryRunner.query(`
      CREATE TRIGGER trg_audit_logs_no_truncate
      BEFORE TRUNCATE ON "audit_logs"
      FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_truncate_guard()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 逆序回收：先摘触发器再删函数，均 IF EXISTS（重复 revert 无副作用）。
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_audit_logs_no_truncate ON "audit_logs"
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS audit_logs_truncate_guard()
    `);
  }
}
