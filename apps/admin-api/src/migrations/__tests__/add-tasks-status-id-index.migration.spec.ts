import * as fs from "fs";
import * as path from "path";
import { AddTasksStatusIdIndex1790000000056 } from "../1790000000056-AddTasksStatusIdIndex";

/**
 * PERF-3: 迁移 1790000000056 结构断言（无真机 PG 的单测环境约定——SQL 文本
 * 逐段断言，先例 add-tasks-dependencies-values-gin-index.migration.spec）。
 * migrations.spec.ts 已覆盖时间戳唯一/类名一致性全目录约束。
 *
 * 反证有牙：改索引名 / 改列序 / 去掉 CONCURRENTLY / 去掉 transaction=false /
 * 把 down 写成非幂等 DROP —— 对应用例各自转红。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000056-AddTasksStatusIdIndex.ts",
);
const INDEX_NAME = "idx_tasks_status_id";

describe("AddTasksStatusIdIndex1790000000056（PERF-3）", () => {
  let sql: string;
  let migration: AddTasksStatusIdIndex1790000000056;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddTasksStatusIdIndex1790000000056();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("AddTasksStatusIdIndex1790000000056");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：在 tasks 上建 (status, id) 复合索引——列序即调度查询形态", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${INDEX_NAME}" ON "tasks" ("status", "id")`,
    );
    // 列序反了（id, status）就吃不到「等值前缀 + 有序后缀」，必须显式钉住
    expect(upPart).not.toContain('("id", "status")');
  });

  it("transaction = false（CONCURRENTLY 不能在事务块内执行的硬约束）", () => {
    expect(sql).toMatch(/transaction\s*=\s*false/);
    expect(
      (migration as unknown as { transaction?: boolean }).transaction,
    ).toBe(false);
  });

  it("非 UNIQUE（只加查询面，不改数据约束）", () => {
    expect(sql).not.toContain("CREATE UNIQUE INDEX");
    expect(sql).not.toContain("UNIQUE INDEX");
  });

  it("down：回收索引（CONCURRENTLY DROP IF EXISTS，可重入）", () => {
    const downPart = sql.split("public async down")[1];
    expect(downPart).toContain(
      `DROP INDEX CONCURRENTLY IF EXISTS "${INDEX_NAME}"`,
    );
  });

  it("不触碰既有索引（本轮只加不删——idx_tasks_status 的收敛不在本迁移）", () => {
    expect(sql).not.toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS "idx_tasks_status"',
    );
    expect(sql).not.toContain('DROP INDEX IF EXISTS "idx_tasks_status"');
  });
});
