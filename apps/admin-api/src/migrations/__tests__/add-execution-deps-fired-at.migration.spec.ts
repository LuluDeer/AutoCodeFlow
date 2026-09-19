import * as fs from "fs";
import * as path from "path";
import { AddExecutionDepsFiredAt1790000000030 } from "../1790000000030-AddExecutionDepsFiredAt";

/**
 * NETOPT-3②: 迁移 1790000000030 结构断言（无真机 PG 的单测环境约定——
 * SQL 文本逐段断言，先例 add-executor-dispatch-mode.migration.spec）。
 * migrations.spec.ts 已覆盖时间戳唯一/类名一致性全目录约束。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000030-AddExecutionDepsFiredAt.ts",
);
const ENTITY_FILE = path.join(
  MIGRATIONS_DIR,
  "..",
  "modules",
  "task",
  "entities",
  "task-execution.entity.ts",
);

describe("AddExecutionDepsFiredAt1790000000030（NETOPT-3②）", () => {
  let sql: string;
  let migration: AddExecutionDepsFiredAt1790000000030;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddExecutionDepsFiredAt1790000000030();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("AddExecutionDepsFiredAt1790000000030");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：task_executions 增可空 timestamptz 列 depsFiredAt（幂等 ADD COLUMN IF NOT EXISTS）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain('ALTER TABLE "task_executions"');
    expect(upPart).toContain('ADD COLUMN IF NOT EXISTS "depsFiredAt"');
    expect(upPart).toContain("timestamptz");
    // 可空：NULL = 扇出未确认完成（重放判据），无 NOT NULL / DEFAULT
    expect(upPart).not.toMatch(/"depsFiredAt"[^,]*NOT NULL/);
    expect(upPart).not.toMatch(/"depsFiredAt"[^,]*DEFAULT/);
  });

  it("down：幂等回收列（DROP COLUMN IF EXISTS）", () => {
    const downPart = sql.split("public async down")[1];
    expect(downPart).toContain('ALTER TABLE "task_executions"');
    expect(downPart).toContain('DROP COLUMN IF EXISTS "depsFiredAt"');
  });

  it("实体侧：depsFiredAt 声明为可空 timestamptz（与迁移 DDL 对齐）", () => {
    const entity = fs.readFileSync(ENTITY_FILE, "utf8");
    expect(entity).toContain('type: "timestamptz"');
    expect(entity).toMatch(/depsFiredAt: Date \| null/);
  });
});
