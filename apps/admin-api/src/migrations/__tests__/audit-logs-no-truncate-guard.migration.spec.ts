import * as fs from "fs";
import * as path from "path";
import { AuditLogsNoTruncateGuard1790000000057 } from "../1790000000057-AuditLogsNoTruncateGuard";

/**
 * SEC-10: 迁移 1790000000057 结构断言（无真机 PG 的单测环境约定——SQL 文本
 * 逐段断言，先例 audit-logs-append-only-guard.migration.spec /
 * create-event-outbox.migration.spec）。
 *
 * 真机行为已实测（PG 16.13，临时库跑完整 TypeORM 迁移链后验证）：
 *   TRUNCATE audit_logs           -> DENIED  (P0001, 'TRUNCATE denied')
 *   TRUNCATE + bypass GUC=on      -> DENIED  (无逃生门，刻意)
 *   UPDATE / DELETE（无 GUC）      -> DENIED  (1790000000006 行为不变)
 *   DELETE + SET LOCAL bypass=on  -> ALLOWED (Q7 保留期清理通道仍通)
 *   up() ×3 / down() ×2           -> 幂等，终态一致
 * migrations.spec.ts 已覆盖时间戳唯一/类名一致性全目录约束。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000057-AuditLogsNoTruncateGuard.ts",
);

/**
 * 只提取**真正下发给 PG 的 SQL**（`queryRunner.query(\`...\`)` 的模板字面量），
 * 不扫注释。本文件的类注释里带反引号（`TRUNCATE audit_logs` / `FOR EACH ROW`
 * 等），用「全文反引号配对」的粗提取会把注释文字当 SQL 断言，产生假失败。
 */
const sqlQueriesOf = (source: string): string =>
  Array.from(source.matchAll(/queryRunner\.query\(\s*`([\s\S]*?)`\s*\)/g))
    .map((m) => m[1])
    .join("\n");

describe("AuditLogsNoTruncateGuard1790000000057（SEC-10 / BEFORE TRUNCATE）", () => {
  let sql: string;
  let migration: AuditLogsNoTruncateGuard1790000000057;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AuditLogsNoTruncateGuard1790000000057();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("AuditLogsNoTruncateGuard1790000000057");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("时间戳晚于既有守卫迁移 1790000000006（增量叠加，不改旧迁移）", () => {
    const stamp = Number(migration.name.slice(-13));
    expect(stamp).toBe(1790000000057);
    expect(stamp).toBeGreaterThan(1790000000006);
  });

  it("up：建守卫函数 audit_logs_truncate_guard（CREATE OR REPLACE，plpgsql）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      "CREATE OR REPLACE FUNCTION audit_logs_truncate_guard() RETURNS trigger AS $$",
    );
    expect(upPart).toContain("$$ LANGUAGE plpgsql;");
  });

  it("up：守卫函数无条件拒绝 TRUNCATE，ERRCODE 与既有守卫一致（P0001）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain("'audit_logs is append-only: TRUNCATE denied'");
    expect(upPart).toMatch(/USING ERRCODE = 'P0001';/);
  });

  it("up：TRUNCATE 不给逃生门——函数体不读 bypass GUC（与 DELETE 的逃生门刻意不同）", () => {
    const upPart = sql.split("public async down")[0];
    const upQueries = sqlQueriesOf(upPart);
    // 保留期清理走分批 DELETE，全仓无 TRUNCATE audit_logs 调用点，
    // 逃生门没有合法调用方 —— 因此在 SQL 里绝不出现 bypass GUC。
    expect(upQueries).not.toContain("bypass_audit_guard");
    expect(upQueries).not.toContain("current_setting");
    // 也不允许 leakproof/allow 之类的放行分支（语句级触发器无 RETURN OLD）
    expect(upQueries).not.toMatch(/\bRETURN\s+(NULL|OLD|NEW)\b/);
  });

  it("up：BEFORE TRUNCATE 语句级触发器挂到 audit_logs（幂等：DROP IF EXISTS + CREATE）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      'DROP TRIGGER IF EXISTS trg_audit_logs_no_truncate ON "audit_logs"',
    );
    expect(upPart).toContain(
      'CREATE TRIGGER trg_audit_logs_no_truncate\n      BEFORE TRUNCATE ON "audit_logs"\n      FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_truncate_guard()',
    );
  });

  it("up：必须是 FOR EACH STATEMENT——TRUNCATE 触发器不支持 FOR EACH ROW", () => {
    const upPart = sql.split("public async down")[0];
    const upQueries = sqlQueriesOf(upPart);
    expect(upQueries).toContain("FOR EACH STATEMENT");
    // PG 会直接报 "TRUNCATE FOR EACH ROW triggers are not supported"
    expect(upQueries).not.toMatch(/FOR EACH ROW/);
  });

  it("不触碰既有迁移 1790000000006 的触发器/函数（只增量叠加）", () => {
    const upPart = sql.split("public async down")[0];
    const upQueries = sqlQueriesOf(upPart);
    // 不得 DROP/替换旧触发器与旧函数
    expect(upQueries).not.toMatch(
      /DROP\s+(TRIGGER|FUNCTION)[\s\S]*trg_audit_logs_append_only/,
    );
    expect(upQueries).not.toMatch(
      /DROP\s+(TRIGGER|FUNCTION)[\s\S]*audit_logs_append_only_guard/,
    );
    expect(upQueries).not.toMatch(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+audit_logs_append_only_guard/,
    );
  });

  it("幂等：up 重放无副作用（DROP IF EXISTS / CREATE OR REPLACE 收敛同一终态）", () => {
    const upPart = sql.split("public async down")[0];
    const upQueries = sqlQueriesOf(upPart);
    expect(upQueries.match(/DROP TRIGGER IF EXISTS/g)?.length).toBe(1);
    expect(upQueries.match(/CREATE OR REPLACE FUNCTION/g)?.length).toBe(1);
    // 只建一条触发器（TRUNCATE 守卫），不重复定义 UPDATE/DELETE 触发器
    expect(upQueries.match(/CREATE TRIGGER/g)?.length).toBe(1);
    expect(upQueries).not.toContain("CREATE TRIGGER IF NOT EXISTS"); // PG 语法本就不支持，防止误写
  });

  it("幂等：down 亦为 IF EXISTS（重复 revert 无副作用）", () => {
    const downQueries = sqlQueriesOf(sql.split("public async down")[1]);
    expect(downQueries.match(/DROP TRIGGER IF EXISTS/g)?.length).toBe(1);
    expect(downQueries.match(/DROP FUNCTION IF EXISTS/g)?.length).toBe(1);
  });

  it("down：先摘触发器再删函数（逆序回收，均为 IF EXISTS 幂等）", () => {
    const downPart = sql.split("public async down")[1];
    const trgIdx = downPart.indexOf("DROP TRIGGER IF EXISTS");
    const fnIdx = downPart.indexOf("DROP FUNCTION IF EXISTS");
    expect(trgIdx).toBeGreaterThanOrEqual(0);
    expect(trgIdx).toBeLessThan(fnIdx);
    // 只回收本迁移新建的对象，不得动旧守卫
    expect(downPart).not.toContain("trg_audit_logs_append_only");
    expect(downPart).not.toContain("audit_logs_append_only_guard");
  });
});
