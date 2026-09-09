import * as fs from "fs";
import * as path from "path";
import { AddApplicationExecutorProjectId1790000000009 } from "../1790000000009-AddApplicationExecutorProjectId";

/**
 * AUTH-01: 迁移 1790000000009 结构断言（无真机 PG 的单测环境约定——
 * SQL 文本逐段断言，先例 add-api-key-task-trigger-scope.migration.spec）。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000009-AddApplicationExecutorProjectId.ts",
);

describe("AddApplicationExecutorProjectId1790000000009（AUTH-01）", () => {
  let sql: string;
  let migration: AddApplicationExecutorProjectId1790000000009;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddApplicationExecutorProjectId1790000000009();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("AddApplicationExecutorProjectId1790000000009");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：三表各加 projectId uuid 可空列（幂等 IF NOT EXISTS）", () => {
    const upPart = sql.split("public async down")[0];
    expect(
      upPart.match(/ADD COLUMN IF NOT EXISTS "projectId" uuid NULL/g),
    ).toHaveLength(3);
    expect(upPart).toContain('ALTER TABLE "applications"');
    expect(upPart).toContain('ALTER TABLE "executors"');
    expect(upPart).toContain('ALTER TABLE "executor_packages"');
  });

  it("三表 FK REFERENCES projects(id) ON DELETE SET NULL", () => {
    const upPart = sql.split("public async down")[0];
    // 去掉头注释行（注释里也提到了 ON DELETE SET NULL 语义），只数 SQL 本体
    const code = upPart
      .split("\n")
      .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
      .join("\n");
    expect(code.match(/REFERENCES "projects"\("id"\)/g)).toHaveLength(3);
    expect(code.match(/ON DELETE SET NULL/g)).toHaveLength(3);
    expect(upPart).toContain('"FK_applications_project"');
    expect(upPart).toContain('"FK_executors_project"');
    expect(upPart).toContain('"FK_executor_packages_project"');
  });

  it("三表 CREATE INDEX IF NOT EXISTS", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_applications_project_id"',
    );
    expect(upPart).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_executors_project_id"',
    );
    expect(upPart).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_executor_packages_project_id"',
    );
  });

  it("三表不回填（可空 = 未分配，归默认项目视图）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).not.toContain("UPDATE");
  });

  it("down 对称：三表 DROP INDEX / CONSTRAINT / COLUMN IF EXISTS", () => {
    expect(
      sql.match(/DROP INDEX IF EXISTS "idx_\w+_project_id"/g),
    ).toHaveLength(3);
    expect(
      sql.match(/DROP CONSTRAINT IF EXISTS "FK_\w+_project"/g),
    ).toHaveLength(3);
    expect(sql.match(/DROP COLUMN IF EXISTS "projectId"/g)).toHaveLength(3);
  });

  it("ARCH-29：时间戳 1790000000009 已在分配表登记（归属 AUTH-01）", () => {
    const registry = fs.readFileSync(
      path.join(__dirname, "../../../../../docs/PLAN-CLAIMS.md"),
      "utf8",
    );
    expect(registry).toContain("| 1790000000009 |");
  });
});
