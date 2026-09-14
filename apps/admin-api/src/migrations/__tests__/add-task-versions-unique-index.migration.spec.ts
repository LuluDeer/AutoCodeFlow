import * as fs from "fs";
import * as path from "path";
import { AddTaskVersionsUniqueIndex1790000000021 } from "../1790000000021-AddTaskVersionsUniqueIndex";

/**
 * PK-11: 迁移 1790000000021 结构断言（无真机 PG 的单测环境约定——
 * SQL 文本逐段断言，先例 add-executor-dispatch-mode.migration.spec）。
 * migrations.spec.ts 已覆盖时间戳唯一/类名一致性全目录约束。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000021-AddTaskVersionsUniqueIndex.ts",
);

describe("AddTaskVersionsUniqueIndex1790000000021（PK-11）", () => {
  let sql: string;
  let migration: AddTaskVersionsUniqueIndex1790000000021;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddTaskVersionsUniqueIndex1790000000021();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("AddTaskVersionsUniqueIndex1790000000021");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：先确定性去重（ROW_NUMBER 按 taskId,version 分区，保留最早一行）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain("ROW_NUMBER() OVER (");
    expect(upPart).toContain('PARTITION BY "taskId", "version"');
    expect(upPart).toContain('ORDER BY "createdAt" ASC, id ASC');
    expect(upPart).toContain("AS rn");
    expect(upPart).toContain("r.rn > 1");
    // 去重先于建索引出现（先清脏数据再上唯一约束）
    expect(upPart.indexOf("ROW_NUMBER")).toBeLessThan(
      upPart.indexOf("CREATE UNIQUE INDEX"),
    );
  });

  it("up：建唯一索引 ux_task_versions_taskId_version(taskId,version) 并回收旧非唯一索引", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "ux_task_versions_taskId_version"',
    );
    expect(upPart).toContain('ON "task_versions" ("taskId", "version")');
    expect(upPart).toContain(
      'DROP INDEX IF EXISTS "idx_task_versions_taskId_version"',
    );
  });

  it("幂等：DELETE rn>1 天然幂等 + CREATE/DROP INDEX IF [NOT] EXISTS", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart.match(/CREATE UNIQUE INDEX IF NOT EXISTS/g)?.length).toBe(1);
    expect(upPart.match(/DROP INDEX IF EXISTS/g)?.length).toBe(1);
    const downPart = sql.split("public async down")[1];
    expect(downPart.match(/DROP INDEX IF EXISTS/g)?.length).toBe(1);
    expect(downPart.match(/CREATE INDEX IF NOT EXISTS/g)?.length).toBe(1);
  });

  it("down：摘唯一索引并恢复非唯一索引形态（不试图复原被删除的重复行）", () => {
    const downPart = sql.split("public async down")[1];
    expect(downPart).toContain(
      'DROP INDEX IF EXISTS "ux_task_versions_taskId_version"',
    );
    expect(downPart).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_task_versions_taskId_version"',
    );
  });
});
