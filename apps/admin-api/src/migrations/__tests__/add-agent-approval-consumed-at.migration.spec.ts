import * as fs from "fs";
import * as path from "path";
import { AddAgentApprovalConsumedAt1790000000068 } from "../1790000000068-AddAgentApprovalConsumedAt";

/**
 * 实施轮 #15：迁移 1790000000068（agent_approvals.consumedAt）结构断言。
 *
 * 无真机 PG 的单测环境约定：SQL 文本逐段断言（先例
 * add-deployment-approval-columns.migration.spec）。时间戳唯一 / 类名一致性由
 * migrations.spec.ts 全目录覆盖。
 *
 * 这条迁移的判据不是「加了列」，而是**语义**：
 *   ① 可空列（存量行没有执行时刻，回填等于伪造审计事实）；
 *   ② 幂等（ADD COLUMN IF NOT EXISTS / DROP COLUMN IF EXISTS）；
 *   ③ 只加列——不得顺带改状态枚举或加默认值（默认值会把「未执行」伪装成
 *      「执行于建表时刻」，这正是本列要区分的东西）。
 */
const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000068-AddAgentApprovalConsumedAt.ts",
);

describe("AddAgentApprovalConsumedAt1790000000068（审批可追溯）", () => {
  let sql: string;
  let migration: AddAgentApprovalConsumedAt1790000000068;
  let upPart: string;
  let downPart: string;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddAgentApprovalConsumedAt1790000000068();
    upPart = sql.split("public async down")[0];
    downPart = sql.split("public async down")[1];
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("AddAgentApprovalConsumedAt1790000000068");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：agent_approvals 加 consumedAt TIMESTAMPTZ NULL（可空——不臆造历史执行时刻）", () => {
    expect(upPart).toContain('ALTER TABLE "agent_approvals"');
    expect(upPart).toMatch(
      /ADD COLUMN IF NOT EXISTS "consumedAt" TIMESTAMPTZ NULL/,
    );
  });

  it("up：列不得带 DEFAULT（默认值会把「未执行」伪装成「建表时刻已执行」）", () => {
    const colLine = upPart.split("\n").find((l) => l.includes('"consumedAt"'))!;
    expect(colLine).not.toMatch(/DEFAULT/i);
  });

  it("down：DROP COLUMN IF EXISTS（可重放）", () => {
    expect(downPart).toContain('DROP COLUMN IF EXISTS "consumedAt"');
    expect(downPart).not.toContain("DROP TABLE");
  });

  it("只加列：不动状态列/索引/其它表（迁移边界单一）", () => {
    expect(upPart).not.toContain("CREATE INDEX");
    expect(upPart).not.toContain("DROP INDEX");
    expect(upPart).not.toContain('ALTER COLUMN "status"');
    expect(upPart.match(/ALTER TABLE/g)?.length).toBe(1);
  });
});
