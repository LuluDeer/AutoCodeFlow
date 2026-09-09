import * as fs from "fs";
import * as path from "path";
import { AuditLogsAppendOnlyGuard1790000000006 } from "../1790000000006-AuditLogsAppendOnlyGuard";

/**
 * SEC-10: 迁移 1790000000006 结构断言（无真机 PG 的单测环境约定——SQL 文本
 * 逐段断言，先例 create-event-outbox.migration.spec）。真机行为（触发器
 * 拒 UPDATE/DELETE、bypass GUC 放行 retention DELETE）已由
 * scripts/audit-verify.mjs 连库验证（mutation-denied 探针）。
 * migrations.spec.ts 已覆盖时间戳唯一/类名一致性全目录约束。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000006-AuditLogsAppendOnlyGuard.ts",
);

describe("AuditLogsAppendOnlyGuard1790000000006（SEC-10）", () => {
  let sql: string;
  let migration: AuditLogsAppendOnlyGuard1790000000006;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AuditLogsAppendOnlyGuard1790000000006();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("AuditLogsAppendOnlyGuard1790000000006");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：建守卫函数 audit_logs_append_only_guard（CREATE OR REPLACE，plpgsql）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      "CREATE OR REPLACE FUNCTION audit_logs_append_only_guard() RETURNS trigger AS $$",
    );
    expect(upPart).toContain("$$ LANGUAGE plpgsql;");
  });

  it("up：守卫函数 UPDATE/DELETE 全拒绝，DELETE 仅在 bypass GUC=on 时放行（retention 清理唯一放行点）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain("IF TG_OP = 'DELETE' THEN");
    expect(upPart).toContain(
      "current_setting('app.bypass_audit_guard', true) = 'on'",
    );
    expect(upPart).toContain("RETURN OLD;");
    expect(upPart).toContain(
      "'audit_logs is append-only: DELETE denied (use retention cleanup job)'",
    );
    expect(upPart).toContain("'audit_logs is append-only: UPDATE denied'");
    // 拒绝走 PG 异常（ERRCODE P0001）——应用侧可按 errcode 识别防篡改拦截
    expect(upPart.match(/USING ERRCODE = 'P0001';/g)?.length).toBe(2);
  });

  it("up：BEFORE UPDATE OR DELETE 行级触发器挂到 audit_logs（幂等：DROP IF EXISTS + CREATE）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      'DROP TRIGGER IF EXISTS trg_audit_logs_append_only ON "audit_logs"',
    );
    expect(upPart).toContain(
      'CREATE TRIGGER trg_audit_logs_append_only\n      BEFORE UPDATE OR DELETE ON "audit_logs"\n      FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only_guard()',
    );
  });

  it("幂等：up 重放无副作用（DROP IF EXISTS / CREATE OR REPLACE 收敛同一终态）", () => {
    const upPart = sql.split("public async down")[0];
    // 头部 doc 注释也含该短语——只统计反引号 SQL 块内的出现次数
    const upQueries = upPart.match(/`[^`]+`/g)?.join("\n") ?? "";
    expect(upQueries.match(/DROP TRIGGER IF EXISTS/g)?.length).toBe(1);
    expect(upQueries.match(/CREATE OR REPLACE FUNCTION/g)?.length).toBe(1);
    expect(upQueries).not.toContain("CREATE TRIGGER IF NOT EXISTS"); // PG 语法本就不支持，防止误写
  });

  it("幂等：down 亦为 IF EXISTS（重复 revert 无副作用）", () => {
    const downQueries =
      sql
        .split("public async down")[1]
        .match(/`[^`]+`/g)
        ?.join("\n") ?? "";
    expect(downQueries.match(/DROP TRIGGER IF EXISTS/g)?.length).toBe(1);
    expect(downQueries.match(/DROP FUNCTION IF EXISTS/g)?.length).toBe(1);
  });

  it("down：先摘触发器再删函数（逆序回收，均为 IF EXISTS 幂等）", () => {
    const downPart = sql.split("public async down")[1];
    const trgIdx = downPart.indexOf("DROP TRIGGER IF EXISTS");
    const fnIdx = downPart.indexOf("DROP FUNCTION IF EXISTS");
    expect(trgIdx).toBeGreaterThanOrEqual(0);
    expect(trgIdx).toBeLessThan(fnIdx);
  });
});
