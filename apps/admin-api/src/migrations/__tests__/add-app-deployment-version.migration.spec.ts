import * as fs from "fs";
import * as path from "path";
import { AddAppDeploymentVersion1790000000033 } from "../1790000000033-AddAppDeploymentVersion";

/**
 * E-P1-R2：迁移 1790000000033 结构断言（无真机 PG 的单测环境约定——
 * SQL 文本逐段断言，先例 add-user-last-totp-counter.migration.spec）。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000033-AddAppDeploymentVersion.ts",
);

describe("AddAppDeploymentVersion1790000000033（E-P1-R2）", () => {
  let sql: string;
  let migration: AddAppDeploymentVersion1790000000033;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddAppDeploymentVersion1790000000033();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("AddAppDeploymentVersion1790000000033");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：app_deployments 加 version INTEGER NOT NULL DEFAULT 1", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain('ALTER TABLE "app_deployments"');
    expect(upPart).toContain(
      'ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1',
    );
  });

  it("幂等：ADD/DROP COLUMN IF NOT EXISTS（重复执行与 revert 重放无副作用）", () => {
    expect(sql.match(/ADD COLUMN IF NOT EXISTS/g)?.length).toBe(1);
    expect(sql.match(/DROP COLUMN IF EXISTS/g)?.length).toBe(1);
  });

  it("down 删列 version", () => {
    const downPart = sql.split("public async down")[1];
    expect(downPart).toContain('DROP COLUMN IF EXISTS "version"');
  });
});
