import * as fs from "fs";
import * as path from "path";
import { AddAppDeploymentEvents1790000000062 } from "../1790000000062-AddAppDeploymentEvents";

/**
 * R4（§4.1A）：迁移 1790000000062 结构断言（无真机 PG 的单测环境约定——SQL
 * 文本逐段断言，先例 add-deployment-approval-columns.migration.spec）。
 * migrations.spec.ts 已覆盖时间戳唯一/类名一致性全目录约束。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000062-AddAppDeploymentEvents.ts",
);

describe("AddAppDeploymentEvents1790000000062（R4 §4.1A）", () => {
  let sql: string;
  let migration: AddAppDeploymentEvents1790000000062;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddAppDeploymentEvents1790000000062();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("AddAppDeploymentEvents1790000000062");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：CREATE TABLE app_deployment_events（append-only 事件表）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      'CREATE TABLE IF NOT EXISTS "app_deployment_events"',
    );
    expect(upPart).toContain('"eventType" VARCHAR NOT NULL');
    expect(upPart).toContain('"applicationId" UUID NOT NULL');
    // 短事实快照 jsonb + 动作事实列
    expect(upPart).toContain('"deployedVersion" VARCHAR');
    expect(upPart).toContain('"triggerType" VARCHAR');
    expect(upPart).toContain('"operator" VARCHAR');
    expect(upPart).toContain('"detail" JSONB');
    expect(upPart).toContain('"createdAt" TIMESTAMP NOT NULL DEFAULT now()');
  });

  it("up：deploymentId 无外键（事件比部署行活得久——remove 后事件保留）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain('"deploymentId" UUID');
    // 唯一的外键是 applicationId → applications；deploymentId 刻意不建
    expect(upPart.match(/FOREIGN KEY/g)?.length).toBe(1);
    expect(upPart).toContain(
      'REFERENCES "applications"("id") ON DELETE CASCADE',
    );
  });

  it("up：两个读面索引（时间序 / 按动作类型聚合）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_app_deployment_events_application_created"',
    );
    expect(upPart).toContain('("applicationId", "createdAt")');
    expect(upPart).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_app_deployment_events_application_type"',
    );
    expect(upPart).toContain('("applicationId", "eventType")');
  });

  it("up：不触碰 app_deployments（纯旁路记录——不改行/索引/状态机）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).not.toContain("app_deployments");
    expect(upPart).not.toContain("ALTER TABLE");
  });

  it("幂等：CREATE ... IF NOT EXISTS 全覆盖（重复执行与 revert 重放无副作用）", () => {
    expect(sql.match(/CREATE TABLE IF NOT EXISTS/g)?.length).toBe(1);
    expect(sql.match(/CREATE INDEX IF NOT EXISTS/g)?.length).toBe(2);
    expect(sql.match(/DROP INDEX IF EXISTS/g)?.length).toBe(2);
    expect(sql.match(/DROP TABLE IF EXISTS/g)?.length).toBe(1);
  });

  it("down 逆序回收：索引 → 表", () => {
    const downPart = sql.split("public async down")[1];
    const typeIdx = downPart.indexOf(
      "idx_app_deployment_events_application_type",
    );
    const createdIdx = downPart.indexOf(
      "idx_app_deployment_events_application_created",
    );
    const tableIdx = downPart.indexOf("DROP TABLE IF EXISTS");
    expect(typeIdx).toBeLessThan(createdIdx);
    expect(createdIdx).toBeLessThan(tableIdx);
  });
});
