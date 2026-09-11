import * as fs from "fs";
import * as path from "path";
import { AddTaskApplicationOwner1790000000010 } from "../1790000000010-AddTaskApplicationOwner";

/**
 * NF-03: 迁移 1790000000010 结构断言（无真机 PG 的单测环境约定——
 * SQL 文本逐段断言，先例 add-task-project-id.migration.spec）。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000010-AddTaskApplicationOwner.ts",
);

describe("AddTaskApplicationOwner1790000000010（NF-03）", () => {
  let sql: string;
  let migration: AddTaskApplicationOwner1790000000010;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddTaskApplicationOwner1790000000010();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("AddTaskApplicationOwner1790000000010");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：tasks/applications 各加 ownerUserId integer 可空列（幂等 IF NOT EXISTS）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain('ALTER TABLE "tasks"');
    expect(upPart).toContain(
      'ADD COLUMN IF NOT EXISTS "ownerUserId" integer NULL',
    );
    expect(upPart).toContain('ALTER TABLE "applications"');
    expect(
      upPart.match(/ADD COLUMN IF NOT EXISTS "ownerUserId" integer NULL/g)
        ?.length,
    ).toBe(2);
  });

  it("不加 FK（轻量预研裁定：悬垂 id=非本人 → 403 方向安全）", () => {
    expect(sql).not.toContain("FOREIGN KEY");
    expect(sql).not.toContain("REFERENCES");
  });

  it("不回填存量行（NULL=无主仅 ADMIN 可改，与 AUTH-01 projectId 回填相反）", () => {
    expect(sql).not.toContain("UPDATE");
  });

  it("down 对称：两表 DROP COLUMN IF EXISTS", () => {
    const downPart = sql.split("public async down")[1];
    expect(downPart).toContain('ALTER TABLE "tasks"');
    expect(downPart).toContain('ALTER TABLE "applications"');
    expect(downPart.match(/DROP COLUMN IF EXISTS "ownerUserId"/g)?.length).toBe(
      2,
    );
  });

  it("ARCH-29：时间戳 1790000000010 已在分配表登记（归属 NF-03）", () => {
    const registry = fs.readFileSync(
      path.join(__dirname, "../../../../../docs/PLAN-CLAIMS.md"),
      "utf8",
    );
    expect(registry).toContain("| 1790000000010 |");
  });
});
