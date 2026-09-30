import * as fs from "fs";
import * as path from "path";
import { AddExecutionResolvedPackage1790000000046 } from "../1790000000046-AddExecutionResolvedPackage";

/**
 * FEAT-22 方案 A v1: 迁移 1790000000046 结构断言（无真机 PG 的单测环境约定——
 * SQL 文本逐段断言，先例 add-task-webhook-secret.migration.spec）。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000046-AddExecutionResolvedPackage.ts",
);

describe("AddExecutionResolvedPackage1790000000046（FEAT-22）", () => {
  let sql: string;
  let migration: AddExecutionResolvedPackage1790000000046;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddExecutionResolvedPackage1790000000046();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("AddExecutionResolvedPackage1790000000046");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：task_executions 加两列 varchar 可空（resolvedPackageUrl/Version）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain('ALTER TABLE "task_executions"');
    expect(upPart).toContain(
      'ADD COLUMN IF NOT EXISTS "resolvedPackageUrl" VARCHAR NULL',
    );
    expect(upPart).toContain(
      'ADD COLUMN IF NOT EXISTS "resolvedPackageVersion" VARCHAR NULL',
    );
    expect(upPart).not.toContain("NOT NULL\n");
  });

  it("幂等：ADD/DROP COLUMN IF NOT EXISTS / IF EXISTS（两列各一次）", () => {
    expect(sql.match(/ADD COLUMN IF NOT EXISTS/g)?.length).toBe(2);
    expect(sql.match(/DROP COLUMN IF EXISTS/g)?.length).toBe(2);
    // down 逆序：先删 Version 再删 Url（与 up 的声明顺序相反）。
    const downPart = sql.split("public async down")[1] ?? "";
    expect(downPart.indexOf("resolvedPackageVersion")).toBeLessThan(
      downPart.indexOf("resolvedPackageUrl"),
    );
  });

  it("ARCH-29：时间戳 1790000000046 已在分配表登记（归属 FEAT-22）", () => {
    const registry = fs.readFileSync(
      path.join(__dirname, "../../../../../docs/PLAN-CLAIMS.md"),
      "utf8",
    );
    expect(registry).toContain("| 1790000000046 |");
  });
});
