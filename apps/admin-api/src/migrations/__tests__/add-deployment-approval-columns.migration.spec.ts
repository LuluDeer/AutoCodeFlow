import * as fs from "fs";
import * as path from "path";
import { AddDeploymentApprovalColumns1790000000002 } from "../1790000000002-AddDeploymentApprovalColumns";

/**
 * DEP-04: 迁移 1790000000002 结构断言（无真机 PG 的单测环境约定——SQL 文本
 * 逐段断言，先例 add-deployment-rollout-columns.migration.spec）。
 * migrations.spec.ts 已覆盖时间戳唯一/类名一致性全目录约束。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000002-AddDeploymentApprovalColumns.ts",
);

describe("AddDeploymentApprovalColumns1790000000002（DEP-04）", () => {
  let sql: string;
  let migration: AddDeploymentApprovalColumns1790000000002;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddDeploymentApprovalColumns1790000000002();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("AddDeploymentApprovalColumns1790000000002");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：app_deployments 加 approvalStatus varchar 可空 + approvalMeta jsonb 可空", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain('ALTER TABLE "app_deployments"');
    expect(upPart).toContain(
      'ADD COLUMN IF NOT EXISTS "approvalStatus" VARCHAR(32) NULL',
    );
    expect(upPart).toContain(
      'ADD COLUMN IF NOT EXISTS "approvalMeta" JSONB NULL',
    );
  });

  it("up：applications 加 approvalRequired BOOLEAN NOT NULL DEFAULT false（存量行零破坏）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain('ALTER TABLE "applications"');
    expect(upPart).toContain(
      'ADD COLUMN IF NOT EXISTS "approvalRequired" BOOLEAN NOT NULL DEFAULT false',
    );
  });

  it("up：审批待办部分索引（approvalStatus='pending_approval'）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_app_deployments_approval_pending"',
    );
    expect(upPart).toContain(`WHERE "approvalStatus" = 'pending_approval'`);
  });

  it("不改动 in-flight 部分唯一索引（待审批行复用 status=pending 天然受约束）", () => {
    // 断言作用域为 SQL 本体（头注释中的描述性提及不算数）。
    const upPart = sql.split("public async down")[0];
    const downPart = sql.split("public async down")[1];
    expect(upPart).not.toContain("DROP INDEX");
    expect(upPart).not.toContain("CREATE UNIQUE INDEX");
    expect(downPart).not.toContain("CREATE UNIQUE INDEX");
  });

  it("幂等：ADD COLUMN / CREATE INDEX / DROP IF EXISTS（重复执行与 revert 重放无副作用）", () => {
    expect(sql.match(/ADD COLUMN IF NOT EXISTS/g)?.length).toBe(3);
    expect(sql.match(/DROP COLUMN IF EXISTS/g)?.length).toBe(3);
    expect(sql.match(/DROP INDEX IF EXISTS/g)?.length).toBe(1);
  });

  it("down 逆序回收：索引 → applications 列 → jsonb → varchar", () => {
    const downPart = sql.split("public async down")[1];
    const idxIdx = downPart.indexOf("idx_app_deployments_approval_pending");
    const appIdx = downPart.indexOf('"approvalRequired"');
    const metaIdx = downPart.indexOf('"approvalMeta"');
    const statusIdx = downPart.indexOf('"approvalStatus"');
    expect(idxIdx).toBeLessThan(appIdx);
    expect(appIdx).toBeLessThan(metaIdx);
    expect(metaIdx).toBeLessThan(statusIdx);
  });
});
