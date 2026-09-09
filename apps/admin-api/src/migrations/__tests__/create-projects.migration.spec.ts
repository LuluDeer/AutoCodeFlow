import * as fs from "fs";
import * as path from "path";
import { CreateProjects1790000000007 } from "../1790000000007-CreateProjects";

/**
 * AUTH-01: 迁移 1790000000007 结构断言（无真机 PG 的单测环境约定——
 * SQL 文本逐段断言，先例 add-api-key-task-trigger-scope.migration.spec）。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(MIGRATIONS_DIR, "1790000000007-CreateProjects.ts");

describe("CreateProjects1790000000007（AUTH-01）", () => {
  let sql: string;
  let migration: CreateProjects1790000000007;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new CreateProjects1790000000007();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("CreateProjects1790000000007");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：建 projects 表（uuid PK / name / description / 时间戳）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain('CREATE TABLE IF NOT EXISTS "projects"');
    expect(upPart).toContain('"id" uuid NOT NULL DEFAULT uuid_generate_v4()');
    expect(upPart).toContain('"name" varchar NOT NULL');
    expect(upPart).toContain('"description" varchar NULL');
    expect(upPart).toContain('"createdAt" TIMESTAMP NOT NULL DEFAULT now()');
    expect(upPart).toContain('"updatedAt" TIMESTAMP NOT NULL DEFAULT now()');
    expect(upPart).toContain('CONSTRAINT "PK_projects_id" PRIMARY KEY');
  });

  it("name 唯一索引（幂等 IF NOT EXISTS）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "UQ_projects_name" ON "projects" ("name")',
    );
  });

  it("种子默认项目：固定 uuid + name='Default' + ON CONFLICT DO NOTHING", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain('INSERT INTO "projects"');
    expect(upPart).toContain("00000000-0000-0000-0000-000000000001");
    expect(upPart).toContain("ON CONFLICT");
    expect(upPart).toContain("DO NOTHING");
  });

  it("down 对称：DROP INDEX + DROP TABLE IF EXISTS", () => {
    expect(sql).toContain('DROP INDEX IF EXISTS "UQ_projects_name"');
    expect(sql).toContain('DROP TABLE IF EXISTS "projects"');
  });

  it("ARCH-29：时间戳 1790000000007 已在分配表登记（归属 AUTH-01）", () => {
    const registry = fs.readFileSync(
      path.join(__dirname, "../../../../../docs/PLAN-CLAIMS.md"),
      "utf8",
    );
    expect(registry).toContain("| 1790000000007 |");
  });
});
