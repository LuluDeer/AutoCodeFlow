import * as fs from "fs";
import * as path from "path";
import { AddTaskProjectId1790000000008 } from "../1790000000008-AddTaskProjectId";

/**
 * AUTH-01: 迁移 1790000000008 结构断言（无真机 PG 的单测环境约定——
 * SQL 文本逐段断言，先例 add-api-key-task-trigger-scope.migration.spec）。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(MIGRATIONS_DIR, "1790000000008-AddTaskProjectId.ts");

const DEFAULT_UUID = "00000000-0000-0000-0000-000000000001";

describe("AddTaskProjectId1790000000008（AUTH-01）", () => {
  let sql: string;
  let migration: AddTaskProjectId1790000000008;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddTaskProjectId1790000000008();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("AddTaskProjectId1790000000008");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：tasks 加 projectId uuid 可空列（幂等 IF NOT EXISTS）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain('ALTER TABLE "tasks"');
    expect(upPart).toContain('ADD COLUMN IF NOT EXISTS "projectId" uuid NULL');
  });

  it("FK REFERENCES projects(id) ON DELETE SET NULL（存在性探测幂等）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain('"FK_tasks_project"');
    expect(upPart).toContain('FOREIGN KEY ("projectId")');
    expect(upPart).toContain('REFERENCES "projects"("id")');
    expect(upPart).toContain("ON DELETE SET NULL");
  });

  it("CREATE INDEX IF NOT EXISTS idx_tasks_project_id", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_tasks_project_id" ON "tasks" ("projectId")',
    );
  });

  it("存量回填：UPDATE tasks SET projectId=默认项目 WHERE projectId IS NULL", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain('UPDATE "tasks" SET "projectId" = $1');
    expect(upPart).toContain('WHERE "projectId" IS NULL');
    expect(upPart).toContain(DEFAULT_UUID);
  });

  it("down 对称：DROP INDEX / CONSTRAINT / COLUMN IF EXISTS", () => {
    expect(sql).toContain('DROP INDEX IF EXISTS "idx_tasks_project_id"');
    expect(sql).toContain(
      'ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "FK_tasks_project"',
    );
    expect(sql).toContain(
      'ALTER TABLE "tasks" DROP COLUMN IF EXISTS "projectId"',
    );
  });

  it("ARCH-29：时间戳 1790000000008 已在分配表登记（归属 AUTH-01）", () => {
    const registry = fs.readFileSync(
      path.join(__dirname, "../../../../../docs/PLAN-CLAIMS.md"),
      "utf8",
    );
    expect(registry).toContain("| 1790000000008 |");
  });
});
