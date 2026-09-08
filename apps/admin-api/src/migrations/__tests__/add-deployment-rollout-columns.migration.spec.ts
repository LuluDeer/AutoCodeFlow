import * as fs from "fs";
import * as path from "path";
import { AddDeploymentRolloutColumns1790000000001 } from "../1790000000001-AddDeploymentRolloutColumns";

/**
 * DEP-02/DEP-03: 迁移 1790000000001 结构断言（无真机 PG 的单测环境约定——
 * SQL 文本逐段断言，先例 partition-execution-log-lines.migration.spec）。
 * migrations.spec.ts 已覆盖时间戳唯一/类名一致性全目录约束。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000001-AddDeploymentRolloutColumns.ts",
);

describe("AddDeploymentRolloutColumns1790000000001（DEP-02/03）", () => {
  let sql: string;
  let migration: AddDeploymentRolloutColumns1790000000001;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddDeploymentRolloutColumns1790000000001();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("AddDeploymentRolloutColumns1790000000001");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：app_deployments 加 rolloutState varchar 可空 + rolloutMeta jsonb 可空", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain('ALTER TABLE "app_deployments"');
    expect(upPart).toContain(
      'ADD COLUMN IF NOT EXISTS "rolloutState" VARCHAR(32) NULL',
    );
    expect(upPart).toContain(
      'ADD COLUMN IF NOT EXISTS "rolloutMeta" JSONB NULL',
    );
    // 不应有 NOT NULL（存量行零破坏）
    expect(upPart).not.toContain("NOT NULL");
  });

  it("幂等：ADD/DROP COLUMN IF NOT EXISTS / IF EXISTS（重复执行与 revert 重放无副作用）", () => {
    expect(sql.match(/ADD COLUMN IF NOT EXISTS/g)?.length).toBe(2);
    expect(sql.match(/DROP COLUMN IF EXISTS/g)?.length).toBe(2);
  });

  it("down 先清 jsonb 再清 varchar（逆序回收）", () => {
    const downPart = sql.split("public async down")[1];
    expect(downPart.indexOf('"rolloutMeta"')).toBeLessThan(
      downPart.indexOf('"rolloutState"'),
    );
  });
});
