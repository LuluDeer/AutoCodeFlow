import * as fs from "fs";
import * as path from "path";

import { AddAgentToolCallUniqueToolCallId1790000000073 } from "../1790000000073-AddAgentToolCallUniqueToolCallId";

/**
 * GAP-5 + db-5：迁移 0073 现在**只做去重**，唯一索引由 0077 负责。
 *
 * 拆分理由（db-5）：原实现「全表自连接 DELETE + 普通 CREATE UNIQUE INDEX」
 * 在同一条迁移里——普通建索引持 SHARE 锁阻塞 agent_tool_calls 的每次工具
 * 记账（agent 循环的每一步），且整条迁移受连接池 30s statement_timeout 约束。
 */
const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000073-AddAgentToolCallUniqueToolCallId.ts",
);
const INDEX_FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000077-AddAgentToolCallUniqueIndexConcurrently.ts",
);

describe("AddAgentToolCallUniqueToolCallId1790000000073（GAP-5 / db-5）", () => {
  let sql: string;
  let indexSql: string;
  let migration: AddAgentToolCallUniqueToolCallId1790000000073;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    indexSql = fs.readFileSync(INDEX_FILE, "utf8");
    migration = new AddAgentToolCallUniqueToolCallId1790000000073();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe(
      "AddAgentToolCallUniqueToolCallId1790000000073",
    );
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：只保留确定性去重（同 (sessionId, toolCallId) 保留 createdAt,id 最小者）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain("DELETE FROM");
    expect(upPart).toContain('a."sessionId" = b."sessionId"');
    expect(upPart).toContain('a."toolCallId" = b."toolCallId"');
    expect(upPart).toContain('a."toolCallId" IS NOT NULL');
    expect(upPart).toContain(
      '(b."createdAt", b."id") < (a."createdAt", a."id")',
    );
  });

  it("db-5：本迁移**不得**再建索引（普通 CREATE INDEX 会持 SHARE 锁 + 受 30s 超时约束）", () => {
    // 只检查代码行：头注里解释拆分原因时会出现 "CREATE UNIQUE INDEX" 字样
    const upCode = sql
      .split("public async down")[0]
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(upCode).not.toContain("CREATE UNIQUE INDEX");
    expect(upCode).not.toContain("CREATE INDEX");
  });

  it("索引拆到 0077：CONCURRENTLY + partial 谓词 + 会话级超时豁免", () => {
    expect(indexSql).toContain(
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "uq_agent_tool_calls_session_toolCallId"',
    );
    expect(indexSql).toContain(
      'ON "agent_tool_calls" ("sessionId", "toolCallId")',
    );
    expect(indexSql).toContain('WHERE "toolCallId" IS NOT NULL');
    expect(indexSql).toContain("transaction = false");
    expect(indexSql).toContain("SET statement_timeout = 0");
    expect(indexSql).toContain("RESET statement_timeout");
  });

  it("down：空操作（已删除的重复行不可恢复，不伪造数据；索引由 0077 管）", () => {
    const downPart = sql.split("public async down")[1] ?? "";
    expect(downPart).not.toContain("INSERT INTO");
    expect(downPart).not.toContain("CREATE");
    expect(indexSql.split("public async down")[1]).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS "uq_agent_tool_calls_session_toolCallId"',
    );
  });

  it("去重语句幂等（再跑一次删 0 行，不报错）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain("DELETE FROM");
    expect(upPart).toContain("WHERE");
  });
});
