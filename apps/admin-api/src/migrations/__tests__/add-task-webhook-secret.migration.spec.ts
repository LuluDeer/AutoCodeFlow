import * as fs from "fs";
import * as path from "path";
import { AddTaskWebhookSecret1790000000045 } from "../1790000000045-AddTaskWebhookSecret";

/**
 * FEAT-21: 迁移 1790000000045 结构断言（无真机 PG 的单测环境约定——
 * SQL 文本逐段断言，先例 add-api-key-task-trigger-scope.migration.spec）。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(MIGRATIONS_DIR, "1790000000045-AddTaskWebhookSecret.ts");

describe("AddTaskWebhookSecret1790000000045（FEAT-21）", () => {
  let sql: string;
  let migration: AddTaskWebhookSecret1790000000045;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddTaskWebhookSecret1790000000045();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("AddTaskWebhookSecret1790000000045");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：tasks 加 webhookSecret varchar 可空列（select:false 由实体侧保证）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain('ALTER TABLE "tasks"');
    expect(upPart).toContain(
      'ADD COLUMN IF NOT EXISTS "webhookSecret" VARCHAR NULL',
    );
    expect(upPart).not.toContain("NOT NULL");
  });

  it("幂等：ADD/DROP COLUMN IF NOT EXISTS / IF EXISTS", () => {
    expect(sql.match(/ADD COLUMN IF NOT EXISTS/g)?.length).toBe(1);
    expect(sql.match(/DROP COLUMN IF EXISTS/g)?.length).toBe(1);
  });

  it("ARCH-29：时间戳 1790000000045 已在分配表登记（归属 FEAT-21）", () => {
    const registry = fs.readFileSync(
      path.join(__dirname, "../../../../../docs/PLAN-CLAIMS.md"),
      "utf8",
    );
    expect(registry).toContain("| 1790000000045 |");
  });
});
