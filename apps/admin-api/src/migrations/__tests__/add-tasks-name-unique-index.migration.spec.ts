import * as fs from "fs";
import * as path from "path";
import { AddTasksNameUniqueIndex1790000000050 } from "../1790000000050-AddTasksNameUniqueIndex";

/**
 * 技术债 A 组（2026-10-01）：迁移 1790000000050 结构断言（无真机 PG 的单测
 * 环境约定——SQL 文本逐段断言，先例 add-task-versions-unique-index
 * .migration.spec 的去重断言 + add-execution-task-created-at-index
 * .migration.spec 的 CONCURRENTLY/transaction=false 断言）。
 * migrations.spec.ts 已覆盖时间戳唯一/类名一致性全目录约束。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(MIGRATIONS_DIR, "1790000000050-AddTasksNameUniqueIndex.ts");

describe("AddTasksNameUniqueIndex1790000000050（技术债 A 组）", () => {
  let sql: string;
  let migration: AddTasksNameUniqueIndex1790000000050;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddTasksNameUniqueIndex1790000000050();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("AddTasksNameUniqueIndex1790000000050");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("CONCURRENTLY 建索引必须 transaction = false（PG 硬约束，同 1790000000049 口径）", () => {
    expect(migration.transaction).toBe(false);
    expect(sql).toMatch(/transaction\s*=\s*false/);
  });

  it("up：存量重名去重——ROW_NUMBER 按 name 分区、(createdAt, id) 决胜保留最早一行，其余改名加 uuid 前 8 位后缀", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain("ROW_NUMBER() OVER (");
    // 分区键仅 name（任务名全局唯一，含软删除行——deletedAt 不在分区里）
    expect(upPart).toContain('PARTITION BY "name"');
    // 决胜键：先创建的保留，后到的视为重复（与 R6 预检查语义一致）
    expect(upPart).toContain('ORDER BY "createdAt" ASC, id ASC');
    expect(upPart).toContain("AS rn");
    expect(upPart).toContain("rn > 1");
    // 改名而非删行：保留全部行（软删除/执行历史以 taskId 关联，删行会悬挂）
    expect(upPart).toContain("|| ' (' || substr(t.id::text, 1, 8) || ')'");
    expect(upPart).not.toContain("DELETE");
  });

  it("up：去重先于建索引（先清脏数据再上唯一约束），且 UPDATE 不带 WHERE 过滤软删除行", () => {
    const upPart = sql.split("public async down")[0];
    // 用完整 DDL 短语定位——类注释里也有「CREATE UNIQUE INDEX CONCURRENTLY」
    // 散文，不能作为锚点；「…CONCURRENTLY IF NOT EXISTS」只出现在真实 SQL。
    expect(upPart.indexOf("ROW_NUMBER")).toBeLessThan(
      upPart.indexOf("CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS"),
    );
    // 全行谓词唯一索引：软删除行同样占名，去重组必须包含它们
    expect(upPart).not.toMatch(/WHERE[^;]*deletedAt/);
  });

  it("up：CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_name_unique（幂等）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "idx_tasks_name_unique"',
    );
    expect(upPart).toContain('ON "tasks" ("name")');
    expect(upPart.match(/CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS/g)?.length).toBe(
      1,
    );
  });

  it("down：仅 DROP 唯一索引（幂等；被去重改名的行不可复原，不做数据逆操作）", () => {
    const downPart = sql.split("public async down")[1];
    expect(downPart).toContain('DROP INDEX IF EXISTS "idx_tasks_name_unique"');
    expect(downPart).not.toContain("UPDATE");
    expect(downPart).not.toContain("DELETE");
  });

  it("实体 @Index 与迁移对齐（命名唯一索引 idx_tasks_name_unique(name)）", () => {
    const entitySql = fs.readFileSync(
      path.join(
        MIGRATIONS_DIR,
        "..",
        "modules",
        "task",
        "entities",
        "task.entity.ts",
      ),
      "utf8",
    );
    expect(entitySql).toContain(
      '@Index("idx_tasks_name_unique", ["name"], { unique: true })',
    );
  });
});
