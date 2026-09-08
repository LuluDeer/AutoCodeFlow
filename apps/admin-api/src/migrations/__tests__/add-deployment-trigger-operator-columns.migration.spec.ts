import * as fs from "fs";
import * as path from "path";
import { AddDeploymentTriggerOperatorColumns1790000000004 } from "../1790000000004-AddDeploymentTriggerOperatorColumns";

/**
 * FEAT-20: 迁移 1790000000004 结构断言（无真机 PG 的单测环境约定——
 * SQL 文本逐段断言，先例 add-deployment-rollout-columns.migration.spec）。
 * migrations.spec.ts 已覆盖时间戳唯一/类名一致性全目录约束。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000004-AddDeploymentTriggerOperatorColumns.ts",
);

describe("AddDeploymentTriggerOperatorColumns1790000000004（FEAT-20）", () => {
  let sql: string;
  let migration: AddDeploymentTriggerOperatorColumns1790000000004;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddDeploymentTriggerOperatorColumns1790000000004();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe(
      "AddDeploymentTriggerOperatorColumns1790000000004",
    );
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：app_deployments 加 triggerType varchar(32) 可空 + operator varchar(100) 可空", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain('ALTER TABLE "app_deployments"');
    expect(upPart).toContain(
      'ADD COLUMN IF NOT EXISTS "triggerType" VARCHAR(32) NULL',
    );
    expect(upPart).toContain(
      'ADD COLUMN IF NOT EXISTS "operator" VARCHAR(100) NULL',
    );
    // 不应有 NOT NULL（存量行零破坏）
    expect(upPart).not.toContain("NOT NULL");
  });

  it("幂等：ADD/DROP COLUMN IF NOT EXISTS / IF EXISTS（重复执行与 revert 重放无副作用）", () => {
    expect(sql.match(/ADD COLUMN IF NOT EXISTS/g)?.length).toBe(2);
    expect(sql.match(/DROP COLUMN IF EXISTS/g)?.length).toBe(2);
  });

  it("down 先清 operator 再清 triggerType（逆序回收）", () => {
    const downPart = sql.split("public async down")[1];
    expect(downPart.indexOf('"operator"')).toBeLessThan(
      downPart.indexOf('"triggerType"'),
    );
  });

  it("ARCH-29：时间戳 1790000000004 已在分配表登记（归属 FEAT-20）", () => {
    const registry = fs.readFileSync(
      path.join(__dirname, "../../../../../docs/PLAN-CLAIMS.md"),
      "utf8",
    );
    expect(registry).toContain("| 1790000000004 |");
  });
});
