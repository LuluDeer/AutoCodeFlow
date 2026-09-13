import * as fs from "fs";
import * as path from "path";
import { AddUserSessionVersion1790000000017 } from "../1790000000017-AddUserSessionVersion";

/**
 * WIKI-AUTH-REVOC: 迁移 1790000000017 结构断言（无真机 PG 的单测环境约定——
 * SQL 文本逐段断言，先例 add-config-history-metadata.migration.spec）。
 * migrations.spec.ts 已覆盖时间戳唯一/类名一致性全目录约束。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000017-AddUserSessionVersion.ts",
);

describe("AddUserSessionVersion1790000000017（WIKI-AUTH-REVOC）", () => {
  let sql: string;
  let migration: AddUserSessionVersion1790000000017;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddUserSessionVersion1790000000017();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("AddUserSessionVersion1790000000017");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：users 加 sessionVersion INTEGER NOT NULL DEFAULT 0", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain('ALTER TABLE "users"');
    expect(upPart).toContain(
      'ADD COLUMN IF NOT EXISTS "sessionVersion" INTEGER NOT NULL DEFAULT 0',
    );
  });

  it("幂等：ADD/DROP COLUMN IF NOT EXISTS / IF EXISTS（重复执行与 revert 重放无副作用）", () => {
    expect(sql.match(/ADD COLUMN IF NOT EXISTS/g)?.length).toBe(1);
    expect(sql.match(/DROP COLUMN IF EXISTS/g)?.length).toBe(1);
  });

  it("down 删列 sessionVersion", () => {
    const downPart = sql.split("public async down")[1];
    expect(downPart).toContain('DROP COLUMN IF EXISTS "sessionVersion"');
  });
});
