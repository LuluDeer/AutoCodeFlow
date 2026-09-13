import * as fs from "fs";
import * as path from "path";
import { AddExecutorDispatchMode1790000000019 } from "../1790000000019-AddExecutorDispatchMode";

/**
 * ARCH-32: 迁移 1790000000019 结构断言（无真机 PG 的单测环境约定——
 * SQL 文本逐段断言，先例 add-user-session-version.migration.spec）。
 * migrations.spec.ts 已覆盖时间戳唯一/类名一致性全目录约束。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000019-AddExecutorDispatchMode.ts",
);

describe("AddExecutorDispatchMode1790000000019（ARCH-32）", () => {
  let sql: string;
  let migration: AddExecutorDispatchMode1790000000019;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddExecutorDispatchMode1790000000019();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("AddExecutorDispatchMode1790000000019");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：executors 加 dispatchMode VARCHAR(16) NOT NULL DEFAULT 'push'", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain('ALTER TABLE "executors"');
    expect(upPart).toContain(
      "ADD COLUMN IF NOT EXISTS \"dispatchMode\" VARCHAR(16) NOT NULL DEFAULT 'push'",
    );
  });

  it("幂等：ADD/DROP COLUMN IF [NOT] EXISTS（重复执行与 revert 重放无副作用）", () => {
    expect(sql.match(/ADD COLUMN IF NOT EXISTS/g)?.length).toBe(1);
    expect(sql.match(/DROP COLUMN IF EXISTS/g)?.length).toBe(1);
  });

  it("down 删列 dispatchMode", () => {
    const downPart = sql.split("public async down")[1];
    expect(downPart).toContain('DROP COLUMN IF EXISTS "dispatchMode"');
  });
});
