import * as fs from "fs";
import * as path from "path";
import { CreateEventOutboxDeadLetters1790000000013 } from "../1790000000013-CreateEventOutboxDeadLetters";

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000013-CreateEventOutboxDeadLetters.ts",
);

describe("CreateEventOutboxDeadLetters1790000000013", () => {
  let sql: string;
  let migration: CreateEventOutboxDeadLetters1790000000013;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new CreateEventOutboxDeadLetters1790000000013();
  });

  it("exposes TypeORM migration up/down contract", () => {
    expect(migration.name).toBe("CreateEventOutboxDeadLetters1790000000013");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("creates the table idempotently with outbox-owned columns", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      'CREATE TABLE IF NOT EXISTS "event_outbox_dead_letters"',
    );
    expect(upPart).toContain('"outboxId" uuid NOT NULL');
    expect(upPart).toContain('"eventType" varchar(64) NOT NULL');
    expect(upPart).toContain('"payload" jsonb NOT NULL');
    expect(upPart).toContain('"attempts" int NOT NULL');
    expect(upPart).toContain('"lastError" varchar(1024) NOT NULL');
    expect(upPart).toContain('"deadLetteredAt" timestamptz NOT NULL');
  });

  it("keeps one terminal record per outbox row and cascades on source delete", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "uq_event_outbox_dead_letters_outboxId"',
    );
    expect(upPart).toContain(
      'FOREIGN KEY ("outboxId") REFERENCES "event_outbox"("id")',
    );
    expect(upPart).toContain("ON DELETE CASCADE");
  });

  it("does not reuse the subscription dead-letter table", () => {
    expect(sql).not.toContain("event_subscription_dead_letters");
  });

  it("down drops indexes before the table", () => {
    const downPart = sql.split("public async down")[1];
    const createdAtIndex = downPart.indexOf(
      "idx_event_outbox_dead_letters_createdAt",
    );
    const uniqueIndex = downPart.indexOf(
      "uq_event_outbox_dead_letters_outboxId",
    );
    const table = downPart.indexOf("DROP TABLE IF EXISTS");
    expect(createdAtIndex).toBeGreaterThanOrEqual(0);
    expect(uniqueIndex).toBeGreaterThanOrEqual(0);
    expect(table).toBeGreaterThan(createdAtIndex);
    expect(table).toBeGreaterThan(uniqueIndex);
  });
});
