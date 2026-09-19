import * as fs from "fs";
import * as path from "path";
import { AddUserLastTotpCounter1790000000031 } from "../1790000000031-AddUserLastTotpCounter";

/**
 * NETOPT-5⑤: 迁移 1790000000031 结构断言（无真机 PG 的单测环境约定——
 * SQL 文本逐段断言，先例 add-user-session-version.migration.spec）。
 * migrations.spec.ts 已覆盖时间戳唯一/类名一致性全目录约束。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000031-AddUserLastTotpCounter.ts",
);

describe("AddUserLastTotpCounter1790000000031（NETOPT-5⑤）", () => {
  let sql: string;
  let migration: AddUserLastTotpCounter1790000000031;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddUserLastTotpCounter1790000000031();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("AddUserLastTotpCounter1790000000031");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：users 加 lastTotpCounter INTEGER（可空无默认，NULL=未消费）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain('ALTER TABLE "users"');
    expect(upPart).toContain(
      'ADD COLUMN IF NOT EXISTS "lastTotpCounter" INTEGER',
    );
    // 可空列：不得带 NOT NULL / DEFAULT（无 TOTP 用户保持 NULL）
    expect(upPart).toMatch(/"lastTotpCounter" INTEGER\s*\n?\s*`/);
    expect(upPart).not.toContain("NOT NULL");
  });

  it("幂等：ADD/DROP COLUMN IF NOT EXISTS / IF EXISTS（重复执行与 revert 重放无副作用）", () => {
    expect(sql.match(/ADD COLUMN IF NOT EXISTS/g)?.length).toBe(1);
    expect(sql.match(/DROP COLUMN IF EXISTS/g)?.length).toBe(1);
  });

  it("down 删列 lastTotpCounter", () => {
    const downPart = sql.split("public async down")[1];
    expect(downPart).toContain('DROP COLUMN IF EXISTS "lastTotpCounter"');
  });
});
