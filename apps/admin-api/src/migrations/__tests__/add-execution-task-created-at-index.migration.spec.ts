import * as fs from "fs";
import * as path from "path";
import { AddExecutionTaskCreatedAtIndex1790000000049 } from "../1790000000049-AddExecutionTaskCreatedAtIndex";

/**
 * A4（第三轮审计·低）：迁移 1790000000049 结构断言（无真机 PG 的单测环境
 * 约定——SQL 文本逐段断言，先例 drop-executor-interpreters-gin-index
 * .migration.spec）。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000049-AddExecutionTaskCreatedAtIndex.ts",
);

describe("AddExecutionTaskCreatedAtIndex1790000000049（A4）", () => {
  let sql: string;
  let migration: AddExecutionTaskCreatedAtIndex1790000000049;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddExecutionTaskCreatedAtIndex1790000000049();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("AddExecutionTaskCreatedAtIndex1790000000049");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("CONCURRENTLY 建索引必须 transaction = false（PG 硬约束，同 1790000000022 口径）", () => {
    expect(migration.transaction).toBe(false);
    expect(sql).toMatch(/transaction\s*=\s*false/);
  });

  it("up：CONCURRENTLY IF NOT EXISTS 建 (taskId, createdAt DESC, id DESC) 复合索引（幂等）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS");
    expect(upPart).toContain('"idx_task_executions_task_id_created_at_id"');
    expect(upPart).toContain(
      'ON "task_executions" ("taskId", "createdAt" DESC, "id" DESC)',
    );
  });

  it("down：仅 DROP 新索引（幂等、CONCURRENTLY 回滚不锁表，旧索引 idx_task_executions_task_id_created_at 保留不触碰）", () => {
    const downPart = sql.split("public async down")[1];
    expect(downPart).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS "idx_task_executions_task_id_created_at_id"',
    );
    // 守卫 check-migration-symmetry：up 的 CONCURRENTLY 与 down 必须一致，
    // 普通 DROP INDEX 会取 ACCESS EXCLUSIVE 锁（回滚锁表）
    // 只匹配真正带引号索引名的语句（注释里的散文中出现 DROP INDEX 不算）
    expect(downPart).not.toMatch(/DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?\s*"/);
    // 保守并存决策：旧索引不在本迁移的任何语句里（不被误删）。
    expect(downPart).not.toContain('idx_task_executions_task_id_created_at"');
    expect(downPart).not.toMatch(
      /DROP INDEX[^;]*idx_task_executions_task_id_created_at"$/,
    );
  });

  it("down：与 up 同一套超时豁免（会话级 SET + finally RESET）", () => {
    const downPart = sql.split("public async down")[1];
    expect(downPart).toContain("SET statement_timeout = 0");
    expect(downPart).toContain("RESET statement_timeout");
    expect(downPart.indexOf("SET statement_timeout")).toBeLessThan(
      downPart.indexOf("DROP INDEX CONCURRENTLY"),
    );
  });

  it("实体 @Index 与迁移对齐（列集一致；方向按迁移 DDL）", () => {
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
    // 列集断言（方向不支持实体声明，见迁移注释）；行尾不敏感（Windows CRLF）。
    expect(entitySql).toContain('"idx_task_executions_task_id_created_at_id"');
    expect(entitySql).toMatch(
      /@Index\("idx_task_executions_task_id_created_at_id",\s*\[\s*"taskId",\s*"createdAt",\s*"id",?\s*\]\)/,
    );
  });
});
