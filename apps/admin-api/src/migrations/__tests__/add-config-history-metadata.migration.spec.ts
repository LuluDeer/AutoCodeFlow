import * as fs from "fs";
import * as path from "path";
import { AddConfigHistoryMetadata1790000000018 } from "../1790000000018-AddConfigHistoryMetadata";

/**
 * WIKI-OPT-2: 迁移 1790000000018 结构断言（无真机 PG 的单测环境约定——
 * SQL 文本逐段断言，先例 add-deployment-rollout-columns.migration.spec）。
 * migrations.spec.ts 已覆盖时间戳唯一/类名一致性全目录约束。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000018-AddConfigHistoryMetadata.ts",
);

describe("AddConfigHistoryMetadata1790000000018（WIKI-OPT-2）", () => {
  let sql: string;
  let migration: AddConfigHistoryMetadata1790000000018;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddConfigHistoryMetadata1790000000018();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("AddConfigHistoryMetadata1790000000018");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：config_history 加 valueType varchar 可空 + isSecret boolean 可空", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain('ALTER TABLE "config_history"');
    expect(upPart).toContain(
      'ADD COLUMN IF NOT EXISTS "valueType" VARCHAR NULL',
    );
    expect(upPart).toContain(
      'ADD COLUMN IF NOT EXISTS "isSecret" BOOLEAN NULL',
    );
    // 不应有 NOT NULL（存量行零破坏：NULL = 元数据不可知）
    expect(upPart).not.toContain("NOT NULL");
  });

  it("幂等：ADD/DROP COLUMN IF NOT EXISTS / IF EXISTS（重复执行与 revert 重放无副作用）", () => {
    expect(sql.match(/ADD COLUMN IF NOT EXISTS/g)?.length).toBe(2);
    expect(sql.match(/DROP COLUMN IF EXISTS/g)?.length).toBe(2);
  });

  it("down 先清 isSecret 再清 valueType（逆序回收）", () => {
    const downPart = sql.split("public async down")[1];
    expect(downPart.indexOf('"isSecret"')).toBeLessThan(
      downPart.indexOf('"valueType"'),
    );
  });
});
