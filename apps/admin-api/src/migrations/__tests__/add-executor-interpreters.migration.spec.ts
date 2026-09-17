import * as fs from "fs";
import * as path from "path";
import { AddExecutorInterpreters1790000000025 } from "../1790000000025-AddExecutorInterpreters";

/**
 * python_task_multiversion（WS2）：迁移 1790000000025 结构断言
 * （无真机 PG 的单测环境约定——SQL 文本逐段断言，先例
 * add-executor-dispatch-mode.migration.spec）。
 * migrations.spec.ts 已覆盖时间戳唯一/类名一致性全目录约束。
 *
 * 注意：断言前先**剥除注释**——本迁移的注释里为说明取舍刻意写了
 * "NOT NULL"/"DEFAULT" 字样，若直接对全文断言会自己把自己判红。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000025-AddExecutorInterpreters.ts",
);

/** 剥除块注释与行注释，只留可执行代码（断言必须打在 SQL 本体上）。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("AddExecutorInterpreters1790000000025（python_task_multiversion）", () => {
  let sql: string;
  let code: string;
  let migration: AddExecutorInterpreters1790000000025;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    code = stripComments(sql);
    migration = new AddExecutorInterpreters1790000000025();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("AddExecutorInterpreters1790000000025");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：executors 加 interpreters JSONB NULL", () => {
    const upPart = code.split("public async down")[0];
    expect(upPart).toContain('ALTER TABLE "executors"');
    expect(upPart).toContain(
      'ADD COLUMN IF NOT EXISTS "interpreters" JSONB NULL',
    );
  });

  it("**不得**加 NOT NULL / DEFAULT（null=未上报 与 []=池空 语义必须可区分）", () => {
    const upPart = code.split("public async down")[0];
    expect(upPart).not.toMatch(/NOT NULL/i);
    expect(upPart).not.toMatch(/DEFAULT/i);
  });

  it("幂等：ADD/DROP COLUMN IF [NOT] EXISTS（重复执行与 revert 重放无副作用）", () => {
    expect(code.match(/ADD COLUMN IF NOT EXISTS/g)?.length).toBe(1);
    expect(code.match(/DROP COLUMN IF EXISTS/g)?.length).toBe(1);
  });

  it("down 删列 interpreters", () => {
    const downPart = code.split("public async down")[1];
    expect(downPart).toContain('DROP COLUMN IF EXISTS "interpreters"');
  });

  it("up 恰好一条语句、down 恰好一条语句（无隐藏副作用）", () => {
    expect(code.match(/queryRunner\.query\(/g)?.length).toBe(2);
  });
});
