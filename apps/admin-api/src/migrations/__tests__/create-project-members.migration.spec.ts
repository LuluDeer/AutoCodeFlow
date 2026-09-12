import * as fs from "fs";
import * as path from "path";
import { CreateProjectMembers1790000000015 } from "../1790000000015-CreateProjectMembers";

/**
 * AUTH-02: 迁移 1790000000015 结构断言（无真机 PG 的单测环境约定——SQL 文本
 * 逐段断言，先例 add-task-application-owner.migration.spec）。
 *
 * 重点断言三条设计约束：
 * ① (projectId, userId) 唯一——判定无歧义；
 * ② FK ON DELETE CASCADE——项目删除时成员行随之清理；
 * ③ **不回填任何成员行**——零破坏升级（放行面只增不减）。
 */
const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(MIGRATIONS_DIR, "1790000000015-CreateProjectMembers.ts");

describe("CreateProjectMembers1790000000015（AUTH-02）", () => {
  let sql: string;
  let migration: CreateProjectMembers1790000000015;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new CreateProjectMembers1790000000015();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("CreateProjectMembers1790000000015");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：建 project_members 表（幂等 IF NOT EXISTS）+ 唯一约束 + 级联 FK", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain('CREATE TABLE IF NOT EXISTS "project_members"');
    expect(upPart).toContain('"userId" integer NOT NULL');
    expect(upPart).toContain('"role" varchar(16) NOT NULL');
    expect(upPart).toContain(
      'CONSTRAINT "uq_project_members_project_user" UNIQUE ("projectId", "userId")',
    );
    expect(upPart).toContain('REFERENCES "projects"("id")');
    expect(upPart).toContain("ON DELETE CASCADE");
  });

  it("up：userId 建索引（按用户查成员关系是热路径）", () => {
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "IDX_project_members_userId"',
    );
  });

  it("③ 零破坏：up 不含任何 INSERT/UPDATE（绝不回填成员行）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).not.toMatch(/INSERT\s+INTO/i);
    expect(upPart).not.toMatch(/UPDATE\s+"project_members"/i);
  });

  it("down：删索引 + 删表，可完整回滚", () => {
    const downPart = sql.split("public async down")[1];
    expect(downPart).toContain(
      'DROP INDEX IF EXISTS "IDX_project_members_userId"',
    );
    expect(downPart).toContain('DROP TABLE IF EXISTS "project_members"');
  });

  it("userId 不加 FK（悬垂 id = 非成员，方向安全，与 tasks.ownerUserId 同姿态）", () => {
    expect(sql).not.toMatch(/FOREIGN KEY \("userId"\)/);
  });
});
