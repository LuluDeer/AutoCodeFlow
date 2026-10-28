import * as fs from "fs";
import * as path from "path";
import {
  AddAgentToolCallUniqueToolCallId1790000000073,
} from "../1790000000073-AddAgentToolCallUniqueToolCallId";

/**
 * GAP-5: 迁移 1790000000073 结构断言（无真机 PG 的单测环境约定——
 * SQL 文本逐段断言，先例 add-audit-and-refresh-token-query-indexes）。
 * migrations.spec.ts 已覆盖时间戳唯一/类名一致性全目录约束。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000073-AddAgentToolCallUniqueToolCallId.ts",
);

describe("AddAgentToolCallUniqueToolCallId1790000000073（GAP-5）", () => {
  let sql: string;
  let migration: AddAgentToolCallUniqueToolCallId1790000000073;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddAgentToolCallUniqueToolCallId1790000000073();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe(
      "AddAgentToolCallUniqueToolCallId1790000000073",
    );
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：先去重（保留最早一行）再建唯一索引——顺序颠倒会在存量重复上直接失败", () => {
    const upPart = sql.split("public async down")[0];
    const dedupPos = upPart.indexOf("DELETE FROM");
    const indexPos = upPart.indexOf("CREATE UNIQUE INDEX");
    expect(dedupPos).toBeGreaterThan(-1);
    expect(indexPos).toBeGreaterThan(dedupPos);
    // 去重语义：同 (sessionId, toolCallId) 非空行，保留 (createdAt, id) 最小者
    expect(upPart).toContain('a."sessionId" = b."sessionId"');
    expect(upPart).toContain('a."toolCallId" = b."toolCallId"');
    expect(upPart).toContain('a."toolCallId" IS NOT NULL');
    expect(upPart).toContain('(b."createdAt", b."id") < (a."createdAt", a."id")');
  });

  it("up：partial unique index——NULL toolCallId 行不参与唯一性也不进索引", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "uq_agent_tool_calls_session_toolCallId"',
    );
    expect(upPart).toContain('ON "agent_tool_calls" ("sessionId", "toolCallId")');
    expect(upPart).toContain('WHERE "toolCallId" IS NOT NULL');
  });

  it("down：只删索引（不恢复被去重的重复行——它们是双跑伪证）", () => {
    const downPart = sql.split("public async down")[1] ?? "";
    expect(downPart).toContain(
      'DROP INDEX IF EXISTS "uq_agent_tool_calls_session_toolCallId"',
    );
    expect(downPart).not.toContain("INSERT INTO");
  });

  it("up 使用幂等形态（IF NOT EXISTS / 条件 DELETE）——CI 二次幂等守卫可重跑", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain("IF NOT EXISTS");
  });
});
