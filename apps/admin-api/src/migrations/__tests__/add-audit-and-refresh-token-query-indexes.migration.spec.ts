import * as fs from "fs";
import * as path from "path";
import { AddAuditAndRefreshTokenQueryIndexes1790000000022 } from "../1790000000022-AddAuditAndRefreshTokenQueryIndexes";

/**
 * PK-16: 迁移 1790000000022 结构断言（无真机 PG 的单测环境约定——
 * SQL 文本逐段断言，先例 add-executor-dispatch-mode.migration.spec）。
 * migrations.spec.ts 已覆盖时间戳唯一/类名一致性全目录约束。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000022-AddAuditAndRefreshTokenQueryIndexes.ts",
);

describe("AddAuditAndRefreshTokenQueryIndexes1790000000022（PK-16）", () => {
  let sql: string;
  let migration: AddAuditAndRefreshTokenQueryIndexes1790000000022;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddAuditAndRefreshTokenQueryIndexes1790000000022();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe(
      "AddAuditAndRefreshTokenQueryIndexes1790000000022",
    );
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：补 audit_logs(action,createdAt) 复合索引", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_audit_logs_action_created_at"',
    );
    expect(upPart).toContain('ON "audit_logs" ("action", "createdAt")');
  });

  it("up：补 refresh_tokens(userId) 与 refresh_tokens(expiresAt) 两个普通索引", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_refresh_tokens_user_id"',
    );
    expect(upPart).toContain('ON "refresh_tokens" ("userId")');
    expect(upPart).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_refresh_tokens_expires_at"',
    );
    expect(upPart).toContain('ON "refresh_tokens" ("expiresAt")');
  });

  it("全部为普通索引（非 UNIQUE——不触碰数据行，只加查询面）", () => {
    expect(sql).not.toContain("CREATE UNIQUE INDEX");
    expect(sql.match(/CREATE INDEX IF NOT EXISTS/g)?.length).toBe(3);
  });

  it("down：逆序回收三个索引（幂等 DROP INDEX IF EXISTS）", () => {
    const downPart = sql.split("public async down")[1];
    expect(downPart.match(/DROP INDEX IF EXISTS/g)?.length).toBe(3);
    // 逆序：expires_at → user_id → action_created_at
    expect(downPart.indexOf('"idx_refresh_tokens_expires_at"')).toBeLessThan(
      downPart.indexOf('"idx_refresh_tokens_user_id"'),
    );
    expect(downPart.indexOf('"idx_refresh_tokens_user_id"')).toBeLessThan(
      downPart.indexOf('"idx_audit_logs_action_created_at"'),
    );
  });
});
