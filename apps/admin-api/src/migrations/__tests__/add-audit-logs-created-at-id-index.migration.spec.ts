import * as fs from "fs";
import * as path from "path";

import { AddAuditLogsCreatedAtIdIndex1790000000082 } from "../1790000000082-AddAuditLogsCreatedAtIdIndex";

/**
 * db-2 残差：`audit_logs` keyset 翻页复合索引的迁移结构断言。
 *
 * 无真机 PG 的单测约定（本仓先例 add-tasks-created-at-id-index /
 * add-tasks-status-id-index.migration.spec）：SQL 文本逐段断言，不连库。
 * migrations.spec.ts 已覆盖「时间戳唯一 / 类名后缀与文件名一致 / 严格递增」等
 * 全目录约束，这里只管本迁移的形状。
 *
 * 有牙（每条对应用例可单独转红）：
 *   · 去掉 `CONCURRENTLY`（up 或 down）→「并发建/并发拆」与「down 对称」转红；
 *   · 去掉 `transaction = false`（或改成 true）→ transaction 用例转红；
 *   · 去掉任一侧的 `SET statement_timeout = 0` / `finally RESET` → 超时豁免用例转红；
 *   · 索引名/表名/列序/DESC 写错 → up 形状用例转红；
 *   · 加 UNIQUE（本迁移只加查询面，不是数据约束）→ 非 UNIQUE 用例转红；
 *   · 顺手动既有索引 → 「不触碰既有索引」用例转红。
 */
const FILE = path.join(
  __dirname,
  "..",
  "1790000000082-AddAuditLogsCreatedAtIdIndex.ts",
);
const INDEX_NAME = "idx_audit_logs_created_at_id";

describe("AddAuditLogsCreatedAtIdIndex1790000000082（db-2 残差）", () => {
  let sql: string;
  let migration: AddAuditLogsCreatedAtIdIndex1790000000082;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddAuditLogsCreatedAtIdIndex1790000000082();
  });

  it("TypeORM 契约：name/up/down 与类名后缀一致", () => {
    expect(migration.name).toBe("AddAuditLogsCreatedAtIdIndex1790000000082");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("transaction = false（CONCURRENTLY 不能在事务块内，硬约束）", () => {
    // 文本 + 实例属性双钉：只断言文本时，把 transaction 挪进 up() 局部变量
    // 也能骗过正则；只断言实例时，`transaction: boolean` 的可选类型会遮住撤销。
    expect(sql).toMatch(/transaction\s*=\s*false/);
    expect(
      (migration as unknown as { transaction?: boolean }).transaction,
    ).toBe(false);
  });

  it("up：CONCURRENTLY 建 (createdAt DESC, id DESC)，与 keyset 排序同形", () => {
    const up = sql.split("public async down")[0];
    expect(up).toContain(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${INDEX_NAME}"`,
    );
    expect(up).toContain('ON "audit_logs" ("createdAt" DESC, "id" DESC)');
    // 列序反了（id, createdAt）就满足不了 `(createdAt, id) < (…)` 的元组比较
    expect(up).not.toContain('("id" DESC, "createdAt" DESC)');
    // 方向反了（ASC）等于让索引序与 ORDER BY 反向，MultiColumn 决胜键失效
    expect(up).not.toContain('("createdAt" ASC, "id" ASC)');
  });

  it("非 UNIQUE（只加查询面，不改数据约束）", () => {
    expect(sql).not.toContain("CREATE UNIQUE INDEX");
    expect(sql).not.toContain("UNIQUE INDEX");
  });

  it("up：会话级超时豁免 + finally RESET，且 SET 在 CREATE 之前", () => {
    const up = sql.split("public async down")[0];
    expect(up).toContain("SET statement_timeout = 0");
    expect(up).toContain("RESET statement_timeout");
    expect(up).toContain("finally");
    expect(up.indexOf("SET statement_timeout")).toBeLessThan(
      up.indexOf("CREATE INDEX CONCURRENTLY"),
    );
    // SET LOCAL 在 transaction=false 时随语句结束失效，等于没豁免
    expect(up).not.toContain("SET LOCAL statement_timeout");
  });

  it("down：与 up 对称（DROP INDEX CONCURRENTLY IF EXISTS 同名索引）", () => {
    const down = sql.split("public async down")[1];
    expect(down).toContain(`DROP INDEX CONCURRENTLY IF EXISTS "${INDEX_NAME}"`);
    // 普通 DROP 要 ACCESS EXCLUSIVE 锁：回滚时把整表写流量挡住（check-migration-symmetry 也拦这条）
    expect(down).not.toMatch(/DROP\s+INDEX\s+(?!CONCURRENTLY)/);
    expect(down).not.toContain("DROP TABLE");
    expect(down).not.toContain("DROP COLUMN");
  });

  it("down：同一套超时豁免（幂等 DROP 也要能跑完大表）", () => {
    const down = sql.split("public async down")[1];
    expect(down).toContain("SET statement_timeout = 0");
    expect(down).toContain("RESET statement_timeout");
    expect(down).toContain("finally");
    expect(down.indexOf("SET statement_timeout")).toBeLessThan(
      down.indexOf("DROP INDEX CONCURRENTLY"),
    );
    expect(down).not.toContain("SET LOCAL statement_timeout");
  });

  it("不触碰既有索引（本轮只加不删；单列 createdAt 的收敛另开迁移）", () => {
    expect(sql).not.toContain('"idx_audit_logs_created_at"');
    expect(sql).not.toContain('"idx_audit_logs_action_created_at"');
    // 只允许出现本迁移的一个索引名（防顺手带上别的 DROP）
    const dropped = [
      ...sql.matchAll(/DROP INDEX CONCURRENTLY IF EXISTS "([^"]+)"/g),
    ].map((m) => m[1]);
    expect(dropped).toEqual([INDEX_NAME]);
  });
});
