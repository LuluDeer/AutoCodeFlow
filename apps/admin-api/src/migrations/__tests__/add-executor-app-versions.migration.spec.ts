import * as fs from "fs";
import * as path from "path";
import { AddExecutorAppVersions1790000000063 } from "../1790000000063-AddExecutorAppVersions";

/**
 * R3-A（部署模型评审 2026-10-23 §4.3）：迁移 1790000000063 结构断言
 * （无真机 PG 的单测环境约定——SQL 文本逐段断言，先例
 * create-event-outbox.migration.spec）。migrations.spec.ts 已覆盖时间戳唯一/
 * 类名一致性全目录约束。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000063-AddExecutorAppVersions.ts",
);

describe("AddExecutorAppVersions1790000000063（R3-A）", () => {
  let sql: string;
  let migration: AddExecutorAppVersions1790000000063;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddExecutorAppVersions1790000000063();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("AddExecutorAppVersions1790000000063");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：建 executor_app_versions 表，核心列齐全（事实列 jsonb retainedVersions / timestamptz 双时间列）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      'CREATE TABLE IF NOT EXISTS "executor_app_versions"',
    );
    expect(upPart).toContain('"id" UUID PRIMARY KEY DEFAULT gen_random_uuid()');
    expect(upPart).toContain('"executorId" UUID NOT NULL');
    expect(upPart).toContain('"applicationId" UUID NOT NULL');
    expect(upPart).toContain('"currentVersion" VARCHAR');
    expect(upPart).toContain('"currentReleaseKey" VARCHAR');
    expect(upPart).toContain('"retainedVersions" JSONB');
    expect(upPart).toContain('"runMode" VARCHAR');
    expect(upPart).toContain('"lastDeployedAt" TIMESTAMPTZ');
    expect(upPart).toContain(
      '"lastReportedAt" TIMESTAMPTZ NOT NULL DEFAULT now()',
    );
  });

  it("up：(executorId, applicationId) 唯一约束（一行 = 一份最新设备事实，整替语义的键）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      'CONSTRAINT "UQ_executor_app_versions_executor_application"',
    );
    expect(upPart).toContain('UNIQUE ("executorId", "applicationId")');
  });

  it("up：executorId/applicationId 双外键 ON DELETE CASCADE（行删除即事实清理，级联惯例）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      'FOREIGN KEY ("executorId") REFERENCES "executors"("id") ON DELETE CASCADE',
    );
    expect(upPart).toContain(
      'FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE',
    );
  });

  it("up：applicationId 索引（getReleases devices 聚合的取行路径）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_executor_app_versions_application"',
    );
    expect(upPart).toContain('ON "executor_app_versions" ("applicationId")');
  });

  it("up：executors 增 installedPackages 可空 jsonb 列（三态：NULL=未上报，无 DEFAULT）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      'ALTER TABLE "executors" ADD COLUMN IF NOT EXISTS "installedPackages" JSONB NULL',
    );
    // 刻意不写 NOT NULL / DEFAULT：存量旧执行器必须保持「未上报」而非「空清单」
    expect(upPart).not.toMatch(/"installedPackages" JSONB NOT NULL/);
    expect(upPart).not.toMatch(/"installedPackages" JSONB DEFAULT/);
  });

  it("down：逆序回滚（先列后表），全部 IF EXISTS 幂等", () => {
    const downPart = sql.split("public async down")[1];
    expect(downPart).toContain(
      'ALTER TABLE "executors" DROP COLUMN IF EXISTS "installedPackages"',
    );
    expect(downPart).toContain(
      'DROP INDEX IF EXISTS "idx_executor_app_versions_application"',
    );
    expect(downPart).toContain('DROP TABLE IF EXISTS "executor_app_versions"');
  });
});
