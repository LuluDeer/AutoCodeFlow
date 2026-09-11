import * as fs from "fs";
import * as path from "path";
import { AddTaskAffinityConstraints1790000000011 } from "../1790000000011-AddTaskAffinityConstraints";

/**
 * NF-04: 迁移 1790000000011 结构断言（无真机 PG 的单测环境约定——
 * SQL 文本逐段断言，先例 add-task-application-owner.migration.spec）。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000011-AddTaskAffinityConstraints.ts",
);

describe("AddTaskAffinityConstraints1790000000011（NF-04）", () => {
  let sql: string;
  let migration: AddTaskAffinityConstraints1790000000011;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddTaskAffinityConstraints1790000000011();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("AddTaskAffinityConstraints1790000000011");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：tasks 加 affinity/anti-affinity 两个可空 text 列（幂等 IF NOT EXISTS）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain('ALTER TABLE "tasks"');
    expect(upPart).toContain(
      'ADD COLUMN IF NOT EXISTS "executorAffinityTags" text NULL',
    );
    expect(upPart).toContain(
      'ADD COLUMN IF NOT EXISTS "executorAntiAffinityTags" text NULL',
    );
    // 只动 tasks 一张表——两列均落 tasks
    expect(upPart.match(/ALTER TABLE "tasks"/g)?.length).toBe(2);
  });

  it("列类型 text 对齐 executorTags 的 TypeORM simple-array 映射（首建迁移先例）", () => {
    const base = fs.readFileSync(
      path.join(MIGRATIONS_DIR, "1717473142684-AddApplicationAndTaskFields.ts"),
      "utf8",
    );
    expect(base).toContain('ADD COLUMN "executorTags" TEXT');
  });

  it("不加 FK / 不建索引（过滤在内存候选集上做，无需索引面）", () => {
    expect(sql).not.toContain("FOREIGN KEY");
    expect(sql).not.toContain("REFERENCES");
    expect(sql).not.toContain("CREATE INDEX");
  });

  it("不回填存量行（NULL = 无约束，默认行为零变化）", () => {
    expect(sql).not.toContain("UPDATE");
  });

  it("down 对称：两列 DROP COLUMN IF EXISTS", () => {
    const downPart = sql.split("public async down")[1];
    expect(downPart).toContain('ALTER TABLE "tasks"');
    expect(downPart).toContain('DROP COLUMN IF EXISTS "executorAffinityTags"');
    expect(downPart).toContain(
      'DROP COLUMN IF EXISTS "executorAntiAffinityTags"',
    );
  });

  it("ARCH-29：时间戳 1790000000011 已在分配表登记（归属 NF-04）", () => {
    const registry = fs.readFileSync(
      path.join(__dirname, "../../../../../docs/PLAN-CLAIMS.md"),
      "utf8",
    );
    expect(registry).toContain("| 1790000000011 |");
  });
});
