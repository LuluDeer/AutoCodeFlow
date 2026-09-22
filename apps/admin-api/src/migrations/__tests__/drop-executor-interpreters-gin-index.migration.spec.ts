import * as fs from "fs";
import * as path from "path";
import { DropExecutorInterpretersGinIndex1790000000034 } from "../1790000000034-DropExecutorInterpretersGinIndex";

/**
 * E-P2-R1：迁移 1790000000034 结构断言（无真机 PG 的单测环境约定——
 * SQL 文本逐段断言，先例 add-app-deployment-version.migration.spec）。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000034-DropExecutorInterpretersGinIndex.ts",
);

describe("DropExecutorInterpretersGinIndex1790000000034（E-P2-R1）", () => {
  let sql: string;
  let migration: DropExecutorInterpretersGinIndex1790000000034;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new DropExecutorInterpretersGinIndex1790000000034();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("DropExecutorInterpretersGinIndex1790000000034");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：DROP INDEX IF EXISTS idx_executors_interpreters（幂等）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      'DROP INDEX IF EXISTS "idx_executors_interpreters"',
    );
  });

  it("down：重建 GIN 索引（与 1790000000027 对齐，供 revert）", () => {
    const downPart = sql.split("public async down")[1];
    expect(downPart).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_executors_interpreters" ON "executors" USING GIN ("interpreters")',
    );
  });
});
