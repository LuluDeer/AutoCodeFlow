import * as fs from "fs";
import * as path from "path";
import { CreateNotificationChannelConfigs1790000000014 } from "../1790000000014-CreateNotificationChannelConfigs";

/**
 * ARCH-31: 迁移 1790000000014 结构断言（无真机 PG 的单测环境约定——SQL 文本
 * 逐段断言，先例 add-deployment-rollout-columns.migration.spec）。
 * migrations.spec.ts 已覆盖时间戳唯一/类名一致性全目录约束。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000014-CreateNotificationChannelConfigs.ts",
);

describe("CreateNotificationChannelConfigs1790000000014（ARCH-31）", () => {
  let sql: string;
  let migration: CreateNotificationChannelConfigs1790000000014;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new CreateNotificationChannelConfigs1790000000014();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe(
      "CreateNotificationChannelConfigs1790000000014",
    );
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：建 notification_channel_configs（key 主键 / config jsonb / enabled bool / updatedAt）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      'CREATE TABLE IF NOT EXISTS "notification_channel_configs"',
    );
    expect(upPart).toContain('"key" varchar(32) NOT NULL');
    expect(upPart).toContain('"config" jsonb NOT NULL');
    expect(upPart).toContain('"enabled" boolean NOT NULL DEFAULT false');
    expect(upPart).toContain('"updatedAt" timestamptz NOT NULL DEFAULT now()');
    expect(upPart).toContain(
      'CONSTRAINT "pk_notification_channel_configs" PRIMARY KEY ("key")',
    );
  });

  it("幂等：CREATE TABLE/INDEX IF NOT EXISTS 与 down 的 IF EXISTS 成对", () => {
    expect(sql.match(/CREATE TABLE IF NOT EXISTS/g)?.length).toBe(1);
    expect(sql.match(/CREATE INDEX IF NOT EXISTS/g)?.length).toBe(1);
    expect(sql.match(/DROP INDEX IF EXISTS/g)?.length).toBe(1);
    expect(sql.match(/DROP TABLE IF EXISTS/g)?.length).toBe(1);
  });

  it("down 先删索引再删表（逆序回收）", () => {
    const downPart = sql.split("public async down")[1];
    expect(downPart.indexOf("DROP INDEX")).toBeLessThan(
      downPart.indexOf("DROP TABLE"),
    );
  });
});
