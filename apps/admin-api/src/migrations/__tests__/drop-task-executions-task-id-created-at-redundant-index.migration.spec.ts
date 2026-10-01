import * as fs from "fs";
import * as path from "path";
import { DropTaskExecutionsTaskIdCreatedAtRedundantIndex1790000000051 } from "../1790000000051-DropTaskExecutionsTaskIdCreatedAtRedundantIndex";

/**
 * 技术债 A 组（2026-10-01）：迁移 1790000000051 结构断言（无真机 PG 的单测
 * 环境约定——SQL 文本逐段断言，先例 add-execution-task-created-at-index
 * .migration.spec）。migrations.spec.ts 已覆盖时间戳唯一/类名一致性全目录约束。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000051-DropTaskExecutionsTaskIdCreatedAtRedundantIndex.ts",
);

describe("DropTaskExecutionsTaskIdCreatedAtRedundantIndex1790000000051（技术债 A 组）", () => {
  let sql: string;
  let migration: DropTaskExecutionsTaskIdCreatedAtRedundantIndex1790000000051;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration =
      new DropTaskExecutionsTaskIdCreatedAtRedundantIndex1790000000051();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe(
      "DropTaskExecutionsTaskIdCreatedAtRedundantIndex1790000000051",
    );
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("CONCURRENTLY 删索引必须 transaction = false（PG 硬约束，同 1790000000049 口径）", () => {
    expect(migration.transaction).toBe(false);
    expect(sql).toMatch(/transaction\s*=\s*false/);
  });

  it("up：DROP INDEX CONCURRENTLY IF EXISTS 旧两列索引（幂等；只删两列索引，不碰 0049 三列索引）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS "idx_task_executions_task_id_created_at"',
    );
    expect(upPart.match(/DROP INDEX CONCURRENTLY IF EXISTS/g)?.length).toBe(1);
    // 0049 的三列索引是覆盖者，必须保留
    expect(upPart).not.toContain('idx_task_executions_task_id_created_at_id"');
  });

  it("down：恢复两列索引原始形态（普通 CREATE INDEX，幂等）", () => {
    const downPart = sql.split("public async down")[1];
    expect(downPart).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_task_executions_task_id_created_at"',
    );
    expect(downPart).toContain(
      'ON "task_executions" ("taskId", "createdAt" DESC)',
    );
  });

  it("实体声明不漂移：旧两列索引无 @Index 声明，三列索引保留（check-index-drift 口径）", () => {
    const entitySql = fs.readFileSync(
      path.join(
        MIGRATIONS_DIR,
        "..",
        "modules",
        "task",
        "entities",
        "task-execution.entity.ts",
      ),
      "utf8",
    );
    // 三列覆盖索引仍在实体上
    expect(entitySql).toContain('"idx_task_executions_task_id_created_at_id"');
    // 旧两列索引不得有命名 @Index 声明（否则删后 check-index-drift 报漂移）
    expect(entitySql).not.toMatch(
      /@Index\(\s*"idx_task_executions_task_id_created_at"/,
    );
  });
});
