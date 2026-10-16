import * as fs from "fs";
import * as path from "path";
import { AddTaskExecutionsExecutorId1790000000055 } from "../1790000000055-AddTaskExecutionsExecutorId";

/**
 * ADR-017 阶段 3（配套）：迁移 1790000000055 结构断言（无真机 PG 的单测环境
 * 约定——SQL 文本逐段断言，先例 add-executor-device-fingerprint-identity）。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000055-AddTaskExecutionsExecutorId.ts",
);

describe("AddTaskExecutionsExecutorId1790000000055（ADR-017 阶段 3 配套）", () => {
  let sql: string;
  let migration: AddTaskExecutionsExecutorId1790000000055;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddTaskExecutionsExecutorId1790000000055();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("AddTaskExecutionsExecutorId1790000000055");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：加可空 executorId 列（存量行不回填——理由见类注释）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      'ALTER TABLE "task_executions" ADD COLUMN IF NOT EXISTS "executorId" uuid NULL',
    );
    // 刻意**没有**回填语句：地址→行映射在 pull 同址多行下有歧义，猜错行比留
    // NULL（回落地址匹配、与引入前一致）更糟。
    expect(upPart).not.toContain('SET "executorId" =');
  });

  it("up：重启恢复形态的部分索引（CONCURRENTLY + 单行 SQL 供漂移扫描器识别）", () => {
    expect(sql).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_task_executions_executor_id_running" ON "task_executions" ("executorId", "startTime") WHERE "status" = \'running\'',
    );
  });

  it("大表纪律：声明 transaction = false（CONCURRENTLY 不能在事务块内执行）", () => {
    // task_executions 是仓库最高频写入的表，普通 CREATE INDEX 会持写锁阻塞派发。
    expect(sql).toContain("transaction = false");
  });

  it("down 逆序回收：先索引后列，且都幂等", () => {
    const downPart = sql.split("public async down")[1];
    expect(downPart).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS "idx_task_executions_executor_id_running"',
    );
    expect(downPart).toContain(
      'ALTER TABLE "task_executions" DROP COLUMN IF EXISTS "executorId"',
    );
    // 逆序：DROP INDEX 必须先于 DROP COLUMN（列被索引引用）。
    expect(downPart.indexOf("DROP INDEX")).toBeLessThan(
      downPart.indexOf("DROP COLUMN"),
    );
  });

  it("不加 FK（执行器行可被清理，而执行历史必须留痕）", () => {
    expect(sql).not.toContain("ADD CONSTRAINT");
    expect(sql).not.toContain("FOREIGN KEY");
  });
});
