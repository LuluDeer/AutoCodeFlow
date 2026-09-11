import * as fs from "fs";
import * as path from "path";
import { AddEventOutboxLeases1790000000012 } from "../1790000000012-AddEventOutboxLeases";

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(MIGRATIONS_DIR, "1790000000012-AddEventOutboxLeases.ts");

describe("AddEventOutboxLeases1790000000012", () => {
  let sql: string;
  let migration: AddEventOutboxLeases1790000000012;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddEventOutboxLeases1790000000012();
  });

  it("exposes TypeORM migration up/down contract", () => {
    expect(migration.name).toBe("AddEventOutboxLeases1790000000012");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("adds nullable lease columns and an index idempotently", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      'ADD COLUMN IF NOT EXISTS "leaseUntil" timestamptz NULL',
    );
    expect(upPart).toContain(
      'ADD COLUMN IF NOT EXISTS "leaseToken" varchar(64) NULL',
    );
    expect(upPart).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_event_outbox_leaseUntil"',
    );
    expect(upPart).toContain('ON "event_outbox" ("leaseUntil")');
  });

  it("down removes index and columns in dependency-safe reverse order", () => {
    const downPart = sql.split("public async down")[1];
    const index = downPart.indexOf("idx_event_outbox_leaseUntil");
    const token = downPart.indexOf('DROP COLUMN IF EXISTS "leaseToken"');
    const until = downPart.indexOf('DROP COLUMN IF EXISTS "leaseUntil"');
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(token);
    expect(token).toBeLessThan(until);
  });

  it("does not introduce a uniqueness constraint", () => {
    expect(sql).not.toContain("UNIQUE");
  });
});
