import * as fs from "fs";
import * as path from "path";
import { PartitionExecutionLogLines1789900000002 } from "../1789900000002-PartitionExecutionLogLines";

/**
 * ARCH-22: 分区迁移的结构性断言（无真机 PG 的单测环境约定——SQL 文本
 * 逐段断言，DDL 语义真机演练步骤见 docs/operations.md「分区表运维」段）。
 * migrations.spec.ts 已覆盖时间戳唯一/类名一致性等全目录通用约束，
 * 本 spec 只针对 ARCH-22 迁移自身的幂等/回退/搬迁语义。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1789900000002-PartitionExecutionLogLines.ts",
);

describe("PartitionExecutionLogLines1789900000002（ARCH-22）", () => {
  let sql: string;
  let migration: PartitionExecutionLogLines1789900000002;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new PartitionExecutionLogLines1789900000002();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("PartitionExecutionLogLines1789900000002");
    expect(migration.name).toBe(
      (PartitionExecutionLogLines1789900000002 as any).name,
    );
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("分区父表 DDL：PARTITION BY RANGE (createdAt) + 联合主键 (id, createdAt)", () => {
    expect(sql.includes('PARTITION BY RANGE ("createdAt")')).toBe(true);
    // PK 必须含分区键——PG 硬约束（分区表唯一约束必须包含分区键）
    expect(sql.includes('PRIMARY KEY ("id", "createdAt")')).toBe(true);
    // up 建两次（存量搬迁路径 + 新库直建路径），down 不重建分区表
    const upPart = sql.split("public async down")[0];
    expect(upPart.match(/PARTITION BY RANGE/g)?.length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it("列结构对齐实体（level 列 + createdAt 默认 now()）", () => {
    expect(sql.includes('"level" VARCHAR(8)')).toBe(true);
    expect(sql.includes('"createdAt" TIMESTAMP NOT NULL DEFAULT now()')).toBe(
      true,
    );
    expect(sql.includes('"content" TEXT NOT NULL')).toBe(true);
    expect(sql.includes('"executionId" VARCHAR NOT NULL')).toBe(true);
    expect(sql.includes('"lineNumber" INTEGER NOT NULL')).toBe(true);
  });

  it("存量搬迁三步：RENAME legacy → 建分区父表 → INSERT..SELECT 搬数据", () => {
    expect(
      sql.includes(
        'ALTER TABLE "execution_log_lines" RENAME TO "execution_log_lines_legacy"',
      ),
    ).toBe(true);
    expect(
      sql.includes(
        'INSERT INTO "execution_log_lines" ("id", "executionId", "lineNumber", "content", "level", "createdAt")',
      ),
    ).toBe(true);
    expect(sql.includes('FROM "execution_log_lines_legacy"')).toBe(true);
    // ON CONFLICT DO NOTHING：中断续跑天然幂等
    expect(sql.includes("ON CONFLICT DO NOTHING")).toBe(true);
    // 序列对齐（rename 不改序列名，setval 推进防发号冲突）
    expect(sql.includes("setval('execution_log_lines_id_seq'")).toBe(true);
  });

  it("legacy 表保留不删（人工回退源），清理步骤文档化于 operations.md", () => {
    // up 路径绝不出现 DROP legacy
    const upPart = sql.split("public async down")[0];
    expect(
      upPart.includes('DROP TABLE IF EXISTS "execution_log_lines_legacy"'),
    ).toBe(false);
    expect(upPart.includes('DROP TABLE "execution_log_lines_legacy"')).toBe(
      false,
    );
    expect(upPart.includes("不 DROP legacy")).toBe(true);
  });

  it("幂等推进：relkind='p' 无操作 / relkind='r' 搬迁 / 不存在直建", () => {
    // 三态判定基于 pg_class.relkind
    expect(sql.includes("v_relkind = 'p'")).toBe(true);
    expect(sql.includes("v_relkind = 'r' AND NOT v_legacy_exists")).toBe(true);
    expect(sql.includes("CREATE TABLE IF NOT EXISTS")).toBe(true);
    // 中断续跑：legacy 存在的中间态补搬迁
    expect(sql.includes("IF v_legacy_exists THEN")).toBe(true);
  });

  it("索引策略：只建读取路径消费的三索引", () => {
    expect(sql.includes('"IDX_execution_log_lines_execId_lineNumber"')).toBe(
      true,
    );
    expect(
      sql.includes('"IDX_execution_log_lines_execId_level_lineNumber"'),
    ).toBe(true);
    expect(sql.includes('"idx_execution_log_lines_createdAt"')).toBe(true);
    // 不搬 legacy 上的冗余单列索引
    expect(sql.includes('"idx_execution_log_lines_execution_id"')).toBe(false);
    expect(sql.includes('"idx_execution_log_lines_line_number"')).toBe(false);
  });

  it("预建分区窗口 today-1 ~ today+7（九个偏移量）", () => {
    expect(sql.includes("[-1, 0, 1, 2, 3, 4, 5, 6, 7]")).toBe(true);
    // 预建走 CREATE TABLE IF NOT EXISTS（幂等）
    expect(sql.includes("CREATE TABLE IF NOT EXISTS")).toBe(true);
    // 分区名由共享 util 生成（与清理服务预建/清理同源防漂移）
    expect(sql.includes("log-partition.util")).toBe(true);
    expect(sql.includes("partitionNameFor")).toBe(true);
    expect(sql.includes("partitionRangeFor")).toBe(true);
  });

  it("down：分区数据回流 legacy 后 DROP 父表，不丢数据", () => {
    const downPart = sql.split("public async down")[1] ?? "";
    expect(downPart.includes('INSERT INTO "execution_log_lines_legacy"')).toBe(
      true,
    );
    expect(downPart.includes('DROP TABLE "execution_log_lines"')).toBe(true);
  });

  it("双跑安全：up 的全部 SQL 均守卫式（无裸 ALTER/CREATE 破坏幂等）", () => {
    // up 部分：除 rename 外不应有裸 ALTER TABLE（rename 在守卫块内仅进一次）
    const upPart = sql.split("public async down")[0];
    const bareAlters = upPart.match(/ALTER TABLE "execution_log_lines" [^R]/g);
    // 允许的形态只有 RENAME（守卫内）
    expect(bareAlters).toBeNull();
    expect(upPart.includes('ALTER TABLE "execution_log_lines" RENAME TO')).toBe(
      true,
    );
  });
});
