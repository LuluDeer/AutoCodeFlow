import * as fs from "fs";
import * as path from "path";
import { AddTaskExecutionDeclaredIndexes1790000000029 } from "../1790000000029-AddTaskExecutionDeclaredIndexes";

/**
 * NETOPT-3①: 迁移 1790000000029 结构断言（无真机 PG 的单测环境约定——
 * SQL 文本逐段断言，先例 add-audit-and-refresh-token-query-indexes.migration.spec）。
 * migrations.spec.ts 已覆盖时间戳唯一/类名一致性全目录约束。
 *
 * 反证有牙：把迁移里任一 CREATE INDEX 换名/删列 → 对应用例红；把实体上的
 * 命名 @Index 撤掉 → 实体对齐用例红。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000029-AddTaskExecutionDeclaredIndexes.ts",
);
const ENTITY_FILE = path.join(
  MIGRATIONS_DIR,
  "..",
  "modules",
  "task",
  "entities",
  "task-execution.entity.ts",
);

describe("AddTaskExecutionDeclaredIndexes1790000000029（NETOPT-3①）", () => {
  let sql: string;
  let migration: AddTaskExecutionDeclaredIndexes1790000000029;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddTaskExecutionDeclaredIndexes1790000000029();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("AddTaskExecutionDeclaredIndexes1790000000029");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：补 task_executions(taskId,status) 复合索引（等值对查询面）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_task_executions_task_id_status"',
    );
    expect(upPart).toContain('ON "task_executions" ("taskId", "status")');
  });

  it("up：补 task_executions(status,createdAt) 复合索引（PENDING 清扫等值+范围 / FAILED 排序）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_task_executions_status_created_at"',
    );
    expect(upPart).toContain('ON "task_executions" ("status", "createdAt")');
  });

  it("up：补 config_history(createdAt)（getHistory 无 key 全量历史排序缺索引）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_config_history_created_at"',
    );
    expect(upPart).toContain('ON "config_history" ("createdAt")');
  });

  it("全部为普通索引（非 UNIQUE——不触碰数据行，只加查询面）", () => {
    expect(sql).not.toContain("CREATE UNIQUE INDEX");
    expect(sql.match(/CREATE INDEX IF NOT EXISTS/g)?.length).toBe(3);
  });

  it("down：逆序回收三个索引（幂等 DROP INDEX IF EXISTS）", () => {
    const downPart = sql.split("public async down")[1];
    expect(downPart.match(/DROP INDEX IF EXISTS/g)?.length).toBe(3);
    // 逆序：config_history → status_created_at → task_id_status
    expect(downPart.indexOf('"idx_config_history_created_at"')).toBeLessThan(
      downPart.indexOf('"idx_task_executions_status_created_at"'),
    );
    expect(
      downPart.indexOf('"idx_task_executions_status_created_at"'),
    ).toBeLessThan(downPart.indexOf('"idx_task_executions_task_id_status"'));
  });

  it("实体侧：@Index 命名声明与迁移 DDL 对齐（原未命名 ['status'] 声明已移除）", () => {
    const rawEntity = fs.readFileSync(ENTITY_FILE, "utf8");
    // 必须剥掉注释：实体头部注释引用了旧写法 `@Index(["status"])` 作为缺陷
    // 说明——不剥注释会把「解释缺陷的注释」当成缺陷本身（API-09 同款陷阱）。
    const entity = rawEntity
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // 与迁移同名的显式命名索引必须存在
    expect(entity).toContain(
      '@Index("idx_task_executions_task_id_status", ["taskId", "status"])',
    );
    expect(entity).toContain(
      '@Index("idx_task_executions_status_created_at", ["status", "createdAt"])',
    );
    // 误导性的未命名独立单列声明不再出现（复合索引左前缀已覆盖其消费面）
    expect(entity).not.toContain('@Index(["status"])');
  });
});
