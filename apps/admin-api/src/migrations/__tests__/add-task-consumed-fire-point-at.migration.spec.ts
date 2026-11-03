import * as fs from "fs";
import * as path from "path";

import { AddTaskConsumedFirePointAt1790000000096 } from "../1790000000096-AddTaskConsumedFirePointAt";

/**
 * A6b：迁移 1790000000096 结构断言（无真机 PG 的单测环境约定——SQL 文本逐段
 * 断言，先例 add-rollout-batch-claim.migration.spec）。
 *
 * `migrations.spec.ts` 已覆盖「时间戳唯一 / 类名后缀与文件名一致 / 严格递增」
 * 等全目录约束，本文件只管本迁移的**形状**与**幂等性**。
 */
const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000096-AddTaskConsumedFirePointAt.ts",
);

describe("AddTaskConsumedFirePointAt1790000000096（A6b）", () => {
  let sql: string;
  let migration: AddTaskConsumedFirePointAt1790000000096;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddTaskConsumedFirePointAt1790000000096();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("AddTaskConsumedFirePointAt1790000000096");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：tasks 加 consumedFirePointAt 可空时间列", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain('ALTER TABLE "tasks"');
    expect(upPart).toContain(
      'ADD COLUMN IF NOT EXISTS "consumedFirePointAt" TIMESTAMP NULL',
    );
  });

  it("存量零破坏：可空且无 DEFAULT ⇒ metadata-only、零回填", () => {
    // 只看 DDL 行（注释里会解释「为什么不用 NOT NULL / DEFAULT」，那是论证不是实现）
    const upDdl = sql
      .split("public async down")[0]
      .split("\n")
      .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
      .join("\n");
    // 可空 ⇒ 存量行全 NULL = 「没有未消耗登记」，语义天然正确
    expect(upDdl).toContain("NULL");
    // 无 DEFAULT ⇒ 不回填任何存量行（否则回填值会被误读成「已登记」）
    expect(upDdl).not.toMatch(/DEFAULT\s+/i);
    // 不该出现 NOT NULL（存量行必须仍可插入）
    expect(upDdl).not.toContain("NOT NULL");
  });

  it("幂等：ADD/DROP COLUMN IF (NOT) EXISTS（重放与 revert 无副作用）", () => {
    // 只数 **SQL 语句本体**（注释里的同一串文字不算——头注用它解释幂等性，
    // 数进注释会让这条断言随注释措辞漂移而假红）。
    const upSql = sql
      .split("public async down")[0]
      .split("\n")
      .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
      .join("\n");
    const downSql = sql
      .split("public async down")[1]
      .split("\n")
      .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
      .join("\n");
    expect(upSql.match(/ADD COLUMN IF NOT EXISTS/g)?.length).toBe(1);
    expect(downSql.match(/DROP COLUMN IF EXISTS/g)?.length).toBe(1);
  });

  it("down：回收该列（回滚即彻底撤销登记语义）", () => {
    const downPart = sql.split("public async down")[1];
    expect(downPart).toContain('ALTER TABLE "tasks"');
    expect(downPart).toContain('DROP COLUMN IF EXISTS "consumedFirePointAt"');
  });
});
