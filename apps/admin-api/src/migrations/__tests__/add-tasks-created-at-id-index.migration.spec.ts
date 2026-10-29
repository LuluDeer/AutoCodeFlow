import * as fs from "fs";
import * as path from "path";

import { AddTasksCreatedAtIdIndex1790000000075 } from "../1790000000075-AddTasksCreatedAtIdIndex";

/**
 * db-2：`tasks` 列表排序索引的迁移结构断言（无真机 PG 的单测约定：
 * SQL 文本逐段断言，先例 add-task-versions-unique-index.migration.spec）。
 */
const FILE = path.join(
  __dirname,
  "..",
  "1790000000075-AddTasksCreatedAtIdIndex.ts",
);

describe("AddTasksCreatedAtIdIndex1790000000075（db-2）", () => {
  let sql: string;
  let migration: AddTasksCreatedAtIdIndex1790000000075;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddTasksCreatedAtIdIndex1790000000075();
  });

  it("TypeORM 契约：name/up/down；CONCURRENTLY 必须 transaction=false", () => {
    expect(migration.name).toBe("AddTasksCreatedAtIdIndex1790000000075");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
    expect(sql).toContain("transaction = false");
  });

  it("up：CONCURRENTLY 建 (createdAt DESC, id DESC)，与列表排序同形", () => {
    const up = sql.split("public async down")[0];
    expect(up).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_tasks_created_at_id"',
    );
    expect(up).toContain('ON "tasks" ("createdAt" DESC, "id" DESC)');
  });

  it("超时豁免：会话级 SET + finally RESET（db-1 纪律，SET LOCAL 无事务时无效）", () => {
    const up = sql.split("public async down")[0];
    expect(up).toContain("SET statement_timeout = 0");
    expect(up).toContain("RESET statement_timeout");
    expect(up.indexOf("SET statement_timeout")).toBeLessThan(
      up.indexOf("CREATE INDEX CONCURRENTLY"),
    );
    expect(up).toContain("finally");
  });

  it("down：DROP CONCURRENTLY + 同一套超时豁免（幂等）", () => {
    const down = sql.split("public async down")[1];
    expect(down).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS "idx_tasks_created_at_id"',
    );
    expect(down).toContain("SET statement_timeout = 0");
    expect(down).toContain("RESET statement_timeout");
  });
});
