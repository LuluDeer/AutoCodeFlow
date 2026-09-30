import * as fs from "fs";
import * as path from "path";
import { AddTaskDeploymentPolicy1790000000047 } from "../1790000000047-AddTaskDeploymentPolicy";

/**
 * FEAT-22 方案 A v2: 迁移 1790000000047 结构断言（无真机 PG 的单测环境约定——
 * SQL 文本逐段断言，先例 add-task-webhook-secret.migration.spec）。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000047-AddTaskDeploymentPolicy.ts",
);

describe("AddTaskDeploymentPolicy1790000000047（FEAT-22 v2）", () => {
  let sql: string;
  let migration: AddTaskDeploymentPolicy1790000000047;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddTaskDeploymentPolicy1790000000047();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("AddTaskDeploymentPolicy1790000000047");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：tasks 加 deploymentPolicy varchar 可空列（NULL=跟随全局）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain('ALTER TABLE "tasks"');
    expect(upPart).toContain(
      'ADD COLUMN IF NOT EXISTS "deploymentPolicy" VARCHAR NULL',
    );
    expect(upPart).not.toContain("NOT NULL\n");
  });

  it("幂等：ADD/DROP COLUMN IF NOT EXISTS / IF EXISTS（各一次）", () => {
    expect(sql.match(/ADD COLUMN IF NOT EXISTS/g)?.length).toBe(1);
    expect(sql.match(/DROP COLUMN IF EXISTS/g)?.length).toBe(1);
  });

  it("ARCH-29：时间戳 1790000000047 已在分配表登记（归属 FEAT-22 v2）", () => {
    const registry = fs.readFileSync(
      path.join(__dirname, "../../../../../docs/PLAN-CLAIMS.md"),
      "utf8",
    );
    expect(registry).toContain("| 1790000000047 |");
  });
});
