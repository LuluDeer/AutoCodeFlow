import * as fs from "fs";
import * as path from "path";
import { AddApiKeyTaskTriggerScope1790000000005 } from "../1790000000005-AddApiKeyTaskTriggerScope";

/**
 * NF-01: 迁移 1790000000005 结构断言（无真机 PG 的单测环境约定——
 * SQL 文本逐段断言，先例 add-deployment-trigger-operator-columns.migration.spec）。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000005-AddApiKeyTaskTriggerScope.ts",
);

describe("AddApiKeyTaskTriggerScope1790000000005（NF-01）", () => {
  let sql: string;
  let migration: AddApiKeyTaskTriggerScope1790000000005;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddApiKeyTaskTriggerScope1790000000005();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("AddApiKeyTaskTriggerScope1790000000005");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：api_keys 加 scopes varchar(128) 可空词表列", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain('ALTER TABLE "api_keys"');
    expect(upPart).toContain(
      'ADD COLUMN IF NOT EXISTS "scopes" VARCHAR(128) NULL',
    );
    expect(upPart).not.toContain("NOT NULL");
  });

  it("幂等：ADD/DROP COLUMN IF NOT EXISTS / IF EXISTS", () => {
    expect(sql.match(/ADD COLUMN IF NOT EXISTS/g)?.length).toBe(1);
    expect(sql.match(/DROP COLUMN IF EXISTS/g)?.length).toBe(1);
  });

  it("ARCH-29：时间戳 1790000000005 已在分配表登记（归属 NF-01）", () => {
    const registry = fs.readFileSync(
      path.join(__dirname, "../../../../../docs/PLAN-CLAIMS.md"),
      "utf8",
    );
    expect(registry).toContain("| 1790000000005 |");
  });
});
