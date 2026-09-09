import * as fs from "fs";
import * as path from "path";
import { CreateEventOutbox1790000000003 } from "../1790000000003-CreateEventOutbox";

/**
 * FEAT-19: 迁移 1790000000003 结构断言（无真机 PG 的单测环境约定——SQL 文本
 * 逐段断言，先例 add-deployment-approval-columns.migration.spec）。
 * migrations.spec.ts 已覆盖时间戳唯一/类名一致性全目录约束。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(MIGRATIONS_DIR, "1790000000003-CreateEventOutbox.ts");

describe("CreateEventOutbox1790000000003（FEAT-19）", () => {
  let sql: string;
  let migration: CreateEventOutbox1790000000003;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new CreateEventOutbox1790000000003();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("CreateEventOutbox1790000000003");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：建 event_outbox 表，核心列齐全（eventId/eventType/payload jsonb/dispatchedAt 可空/attempts 默认 0/nextAttemptAt 可空/deadLettered）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain('CREATE TABLE IF NOT EXISTS "event_outbox"');
    expect(upPart).toContain('"id" uuid NOT NULL DEFAULT gen_random_uuid()');
    expect(upPart).toContain('"eventId" varchar(64) NOT NULL');
    expect(upPart).toContain('"eventType" varchar(64) NOT NULL');
    expect(upPart).toContain('"payload" jsonb NOT NULL');
    expect(upPart).toContain('"dispatchedAt" timestamptz');
    expect(upPart).toContain('"attempts" int NOT NULL DEFAULT 0');
    expect(upPart).toContain('"nextAttemptAt" timestamptz');
    expect(upPart).toContain('"deadLettered" boolean NOT NULL DEFAULT false');
    expect(upPart).toContain('"createdAt" timestamptz NOT NULL DEFAULT now()');
  });

  it("up：nextAttemptAt 建索引（扫描补投的取行路径）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_event_outbox_nextAttemptAt"',
    );
    expect(upPart).toContain('ON "event_outbox" ("nextAttemptAt")');
  });

  it("up：dispatchedAt 与 eventId 建索引（未派发扫描/追踪查询）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_event_outbox_dispatchedAt"',
    );
    expect(upPart).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_event_outbox_eventId"',
    );
  });

  it("幂等：CREATE TABLE / CREATE INDEX IF NOT EXISTS（重复执行无副作用）", () => {
    expect(sql.match(/CREATE TABLE IF NOT EXISTS/g)?.length).toBe(1);
    expect(sql.match(/CREATE INDEX IF NOT EXISTS/g)?.length).toBe(3);
  });

  it("down 逆序回收：三条索引 → 表", () => {
    const downPart = sql.split("public async down")[1];
    const eventIdIdx = downPart.indexOf("idx_event_outbox_eventId");
    const nextAttemptIdx = downPart.indexOf("idx_event_outbox_nextAttemptAt");
    const dispatchedIdx = downPart.indexOf("idx_event_outbox_dispatchedAt");
    const tableIdx = downPart.indexOf("DROP TABLE");
    expect(eventIdIdx).toBeGreaterThanOrEqual(0);
    expect(eventIdIdx).toBeLessThan(nextAttemptIdx);
    expect(nextAttemptIdx).toBeLessThan(dispatchedIdx);
    expect(dispatchedIdx).toBeLessThan(tableIdx);
  });

  it("eventId 不加唯一约束——at-least-once 允许同一事件重复投递（订阅方幂等）", () => {
    expect(sql).not.toContain("UNIQUE");
  });
});
