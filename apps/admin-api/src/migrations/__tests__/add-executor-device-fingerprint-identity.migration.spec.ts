import * as fs from "fs";
import * as path from "path";
import { AddExecutorDeviceFingerprintIdentity1790000000054 } from "../1790000000054-AddExecutorDeviceFingerprintIdentity";

/**
 * ADR-017 阶段 3：迁移 1790000000054 结构断言（无真机 PG 的单测环境约定——
 * SQL 文本逐段断言，先例 add-executor-heartbeat-misses.migration.spec）。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000054-AddExecutorDeviceFingerprintIdentity.ts",
);

describe("AddExecutorDeviceFingerprintIdentity1790000000054（ADR-017 阶段 3）", () => {
  let sql: string;
  let migration: AddExecutorDeviceFingerprintIdentity1790000000054;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddExecutorDeviceFingerprintIdentity1790000000054();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe(
      "AddExecutorDeviceFingerprintIdentity1790000000054",
    );
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up 第 1 步：加宽列为 VARCHAR(80)（legacy-h 形态 73 字符必须装得下）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      'ALTER TABLE "executors" ALTER COLUMN "deviceFingerprint" TYPE VARCHAR(80)',
    );
  });

  it("up 第 2 步：回填走 legacyExecutorIdentity（与 register 创建路径同形，杜绝同形漂移）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      'import { legacyExecutorIdentity } from "../modules/executor/executor-fingerprint.util";',
    );
    expect(upPart).toContain("legacyExecutorIdentity(row.address)");
    expect(upPart).toContain('WHERE "deviceFingerprint" IS NULL');
  });

  it("up 第 3 步：SET NOT NULL（回填后每行都有身份键）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      'ALTER TABLE "executors" ALTER COLUMN "deviceFingerprint" SET NOT NULL',
    );
  });

  it("up 第 4 步：地址唯一收窄为 push 模式行（partial unique index，ADR-017 §5）", () => {
    const upPart = sql.split("public async down")[0];
    // 卸掉旧唯一性走 dropAddressUniqueIndex 辅助方法（索引/约束两形态都覆盖）
    // ——故断言该方法内的两条语句（DROP INDEX 卸不掉唯一约束）。
    expect(sql).toContain(
      'ALTER TABLE "executors" DROP CONSTRAINT IF EXISTS "uq_executors_address"',
    );
    expect(sql).toContain('DROP INDEX IF EXISTS "uq_executors_address"');
    expect(upPart).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "uq_executors_address" ON "executors" ("address") WHERE "dispatchMode" = \'push\'',
    );
  });

  it("up 第 4 步：重建前显式探测重复 address（有重复时抛可读错误，而非泛泛的 PG 报错）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain("HAVING COUNT(*) > 1");
    expect(upPart).toContain("无法将 uq_executors_address 收窄为仅 push 模式");
  });

  it("down 的失败姿态与事务范围均已如实注释（回滚前需先收敛并存 pull 行）", () => {
    // down 失败后表上没有任何 address 唯一性且不可自愈 —— 这一姿态必须在源码
    // 里写明（而非只存在于提交信息里）。
    expect(sql).toContain("零 address 唯一性");
    expect(sql).toContain("不可自愈");
    // 事务范围：未声明 transaction=false，故由 migrationsTransactionMode 决定
    // （up 失败整体回滚，不存在半成品中间态）。
    expect(sql).not.toContain("transaction = false");
  });

  it("down 逆序回收：全局唯一 → DROP NOT NULL → 清 legacy 键 → 列宽还原", () => {
    const downPart = sql.split("public async down")[1];
    expect(downPart).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "uq_executors_address" ON "executors" ("address")',
    );
    expect(downPart).toContain(
      'ALTER TABLE "executors" ALTER COLUMN "deviceFingerprint" DROP NOT NULL',
    );
    expect(downPart).toContain("LIKE 'legacy%'");
    expect(downPart).toContain(
      'ALTER TABLE "executors" ALTER COLUMN "deviceFingerprint" TYPE VARCHAR(64)',
    );
  });
});
