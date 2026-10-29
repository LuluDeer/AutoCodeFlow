import * as fs from "fs";
import * as path from "path";

import { AddAgentToolCallUniqueIndexConcurrently1790000000077 } from "../1790000000077-AddAgentToolCallUniqueIndexConcurrently";

/** db-5：从 0073 拆出的唯一索引迁移（CONCURRENTLY）结构断言。 */
const FILE = path.join(
  __dirname,
  "..",
  "1790000000077-AddAgentToolCallUniqueIndexConcurrently.ts",
);

describe("AddAgentToolCallUniqueIndexConcurrently1790000000077（db-5）", () => {
  let sql: string;
  let migration: AddAgentToolCallUniqueIndexConcurrently1790000000077;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddAgentToolCallUniqueIndexConcurrently1790000000077();
  });

  it("TypeORM 契约 + CONCURRENTLY 必须 transaction=false", () => {
    expect(migration.name).toBe(
      "AddAgentToolCallUniqueIndexConcurrently1790000000077",
    );
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
    expect(sql).toContain("transaction = false");
  });

  it("up：partial unique index CONCURRENTLY（NULL toolCallId 不进索引）", () => {
    const up = sql.split("public async down")[0];
    expect(up).toContain(
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "uq_agent_tool_calls_session_toolCallId"',
    );
    expect(up).toContain('ON "agent_tool_calls" ("sessionId", "toolCallId")');
    expect(up).toContain('WHERE "toolCallId" IS NOT NULL');
  });

  it("超时豁免 + finally RESET（db-1 纪律：超时会留下 indisvalid 索引）", () => {
    const up = sql.split("public async down")[0];
    expect(up).toContain("SET statement_timeout = 0");
    expect(up).toContain("RESET statement_timeout");
    expect(up).toContain("finally");
  });

  it("down：DROP CONCURRENTLY + 超时豁免（可重复 revert）", () => {
    const down = sql.split("public async down")[1];
    expect(down).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS "uq_agent_tool_calls_session_toolCallId"',
    );
    expect(down).toContain("SET statement_timeout = 0");
    expect(down).toContain("RESET statement_timeout");
  });
});
