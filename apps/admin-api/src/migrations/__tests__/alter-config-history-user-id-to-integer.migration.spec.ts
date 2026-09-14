import * as fs from "fs";
import * as path from "path";
import { AlterConfigHistoryUserIdToInteger1790000000023 } from "../1790000000023-AlterConfigHistoryUserIdToInteger";

/**
 * PK-21（DEEP_REVIEW 0ef3bbe）: 迁移 1790000000023 结构断言（无真机 PG 的
 * 单测环境约定——SQL 文本逐段断言，先例 add-config-history-metadata /
 * add-deployment-rollout-columns）。migrations.spec.ts 已覆盖时间戳唯一/
 * 类名一致性全目录约束。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000023-AlterConfigHistoryUserIdToInteger.ts",
);

describe("AlterConfigHistoryUserIdToInteger1790000000023（PK-21）", () => {
  let sql: string;
  let migration: AlterConfigHistoryUserIdToInteger1790000000023;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AlterConfigHistoryUserIdToInteger1790000000023();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe(
      "AlterConfigHistoryUserIdToInteger1790000000023",
    );
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：config_history.userId VARCHAR → INTEGER（USING 显式转换）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain('ALTER TABLE "config_history"');
    expect(upPart).toContain('ALTER COLUMN "userId" TYPE INTEGER');
    // 显式 USING 转换：非数字存量行 fail-fast（不静默吞脏数据）
    expect(upPart).toContain('USING "userId"::integer');
  });

  it("down：回退为 VARCHAR（::text 反向转换）", () => {
    const downPart = sql.split("public async down")[1];
    expect(downPart).toContain('ALTER COLUMN "userId" TYPE VARCHAR');
    expect(downPart).toContain('USING "userId"::text');
  });

  it("列保持可空：不引入 NOT NULL（存量 NULL 行零破坏）", () => {
    expect(sql).not.toContain("NOT NULL");
  });
});
