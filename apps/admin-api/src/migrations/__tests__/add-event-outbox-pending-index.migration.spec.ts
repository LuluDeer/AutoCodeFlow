import * as fs from "fs";
import * as path from "path";

import { AddEventOutboxPendingIndex1790000000076 } from "../1790000000076-AddEventOutboxPendingIndex";

/**
 * db-3：outbox claim 的 partial index 迁移结构断言。
 *
 * 判据核心是**谓词与 claim SQL 逐字对应**：死信行（dispatchedAt 仍 NULL）
 * 必须被排除在索引之外，否则扫描成本仍与历史失败量成正比。
 */
const FILE = path.join(
  __dirname,
  "..",
  "1790000000076-AddEventOutboxPendingIndex.ts",
);

describe("AddEventOutboxPendingIndex1790000000076（db-3）", () => {
  let sql: string;
  let migration: AddEventOutboxPendingIndex1790000000076;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddEventOutboxPendingIndex1790000000076();
  });

  it("TypeORM 契约 + CONCURRENTLY 必须 transaction=false", () => {
    expect(migration.name).toBe("AddEventOutboxPendingIndex1790000000076");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
    expect(sql).toContain("transaction = false");
  });

  it("up：partial index 谓词与 claim 完全一致（dispatchedAt IS NULL AND deadLettered=false）", () => {
    const up = sql.split("public async down")[0];
    expect(up).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_event_outbox_pending"',
    );
    expect(up).toContain('ON "event_outbox" ("createdAt")');
    expect(up).toContain('WHERE "dispatchedAt" IS NULL');
    expect(up).toContain('"deadLettered" = false');
  });

  it("幂等与超时豁免：IF NOT EXISTS + SET/RESET statement_timeout", () => {
    const up = sql.split("public async down")[0];
    expect(up).toContain("IF NOT EXISTS");
    expect(up).toContain("SET statement_timeout = 0");
    expect(up).toContain("RESET statement_timeout");
    expect(up).toContain("finally");
  });

  it("down：DROP CONCURRENTLY IF EXISTS（可重复 revert）", () => {
    const down = sql.split("public async down")[1];
    expect(down).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS "idx_event_outbox_pending"',
    );
    expect(down).toContain("SET statement_timeout = 0");
    expect(down).toContain("RESET statement_timeout");
  });
});
