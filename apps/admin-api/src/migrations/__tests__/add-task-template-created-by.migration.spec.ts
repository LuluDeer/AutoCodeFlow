import * as fs from "fs";
import * as path from "path";
import { AddTaskTemplateCreatedBy1790000000035 } from "../1790000000035-AddTaskTemplateCreatedBy";

/**
 * E-P2-S1：迁移 1790000000035 结构断言（无真机 PG 的单测环境约定——
 * SQL 文本逐段断言，先例 add-app-deployment-version.migration.spec）。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000035-AddTaskTemplateCreatedBy.ts",
);

describe("AddTaskTemplateCreatedBy1790000000035（E-P2-S1）", () => {
  let sql: string;
  let migration: AddTaskTemplateCreatedBy1790000000035;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddTaskTemplateCreatedBy1790000000035();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("AddTaskTemplateCreatedBy1790000000035");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：task_templates 加 createdBy varchar(100) 可空", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain('ALTER TABLE "task_templates"');
    expect(upPart).toContain(
      'ADD COLUMN IF NOT EXISTS "createdBy" varchar(100)',
    );
    // 可空列：不得带 NOT NULL / DEFAULT
    expect(upPart).not.toContain("NOT NULL");
  });

  it("幂等：ADD/DROP COLUMN IF NOT EXISTS（重复执行与 revert 重放无副作用）", () => {
    expect(sql.match(/ADD COLUMN IF NOT EXISTS/g)?.length).toBe(1);
    expect(sql.match(/DROP COLUMN IF EXISTS/g)?.length).toBe(1);
  });

  it("down 删列 createdBy", () => {
    const downPart = sql.split("public async down")[1];
    expect(downPart).toContain('DROP COLUMN IF EXISTS "createdBy"');
  });
});
