import {
  MIGRATION_ADVISORY_LOCK_KEY,
  runMigrationsWithAdvisoryLock,
  type MigrationDescriptor,
  type MigratableDataSource,
} from "../migration-runner.util";

/**
 * down 事务模式定向回归：TypeORM 1.1.x 的 undoLastMigration(options) 默认
 * `"all"`，既不读 migrationsTransactionMode，也不检查实例的 transaction=false。
 * 0109 的 DROP INDEX CONCURRENTLY 因此曾被 PG 拒绝（0A000 → 25P02）。
 * 这里把「按台账最后一条迁移实例决定事务模式」的调用参数钉死，并断言
 * advisory lock 的持有/释放顺序与 down 失败语义。
 */
describe("runMigrationsWithAdvisoryLock — down transaction mode", () => {
  const CONCURRENTLY_MIGRATION =
    "AddExecutionArtifactsListIndexes1790000000109";
  const PLAIN_MIGRATION = "AlterTaskStatusDefaultPaused1790000000110";

  interface Scenario {
    migrations?: MigrationDescriptor[];
    ledger?: Array<{ name: string }>;
    ledgerError?: Error;
    undoError?: Error;
    table?: string;
  }

  const makeDs = (scenario: Scenario = {}) => {
    const events: string[] = [];
    const sqls: string[] = [];
    const undo = jest.fn(async (_options?: unknown) => {
      events.push("undoLastMigration");
      if (scenario.undoError) throw scenario.undoError;
    });
    const runner = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        sqls.push(sql);
        if (sql.includes("pg_try_advisory_lock")) {
          events.push(`try_lock:${params?.[0]}`);
          return [{ locked: true }];
        }
        if (sql.includes("pg_advisory_unlock")) {
          events.push("unlock");
          return [{ unlocked: true }];
        }
        if (sql.includes('ORDER BY "id" DESC LIMIT 1')) {
          events.push("ledger");
          if (scenario.ledgerError) throw scenario.ledgerError;
          return scenario.ledger ?? [];
        }
        throw new Error(`unexpected sql: ${sql}`);
      }),
      release: jest.fn(async () => {
        events.push("release");
      }),
    };
    const ds: MigratableDataSource = {
      createQueryRunner: () => runner,
      runMigrations: jest.fn(async () => undefined),
      undoLastMigration: undo,
      migrations: scenario.migrations ?? [],
      options: { migrationsTableName: scenario.table },
    };
    return { ds, runner, undo, events, sqls };
  };

  it("0109（transaction=false）→ undoLastMigration({transaction:'none'})，台账查询与回滚都在锁内", async () => {
    const { ds, undo, events, sqls } = makeDs({
      migrations: [{ name: CONCURRENTLY_MIGRATION, transaction: false }],
      ledger: [{ name: CONCURRENTLY_MIGRATION }],
    });

    await runMigrationsWithAdvisoryLock(ds, { mode: "down" });

    expect(undo).toHaveBeenCalledTimes(1);
    expect(undo).toHaveBeenCalledWith({ transaction: "none" });
    expect(events).toEqual([
      `try_lock:${MIGRATION_ADVISORY_LOCK_KEY}`,
      "ledger",
      "undoLastMigration",
      "unlock",
      "release",
    ]);
    expect(
      sqls.some((s) => s.includes('SELECT "name" FROM "migrations"')),
    ).toBe(true);
  });

  it("普通迁移（未声明 transaction=false）→ undoLastMigration({transaction:'each'})，保持事务行为", async () => {
    const { ds, undo } = makeDs({
      migrations: [
        { name: CONCURRENTLY_MIGRATION, transaction: false },
        { name: PLAIN_MIGRATION },
      ],
      ledger: [{ name: PLAIN_MIGRATION }],
    });

    await runMigrationsWithAdvisoryLock(ds, { mode: "down" });

    expect(undo).toHaveBeenCalledWith({ transaction: "each" });
  });

  it("台账最后一条才是判据：链中存在 0109 但最后回滚的是 0110 → each", async () => {
    const { ds, undo } = makeDs({
      migrations: [
        { name: PLAIN_MIGRATION },
        { name: CONCURRENTLY_MIGRATION, transaction: false },
      ],
      ledger: [{ name: PLAIN_MIGRATION }],
    });

    await runMigrationsWithAdvisoryLock(ds, { mode: "down" });

    expect(undo).toHaveBeenCalledWith({ transaction: "each" });
  });

  it("down 失败 → 错误透传，unlock/release 仍执行，util 不动台账", async () => {
    const boom = new Error("drop index failed");
    const { ds, runner, events, sqls } = makeDs({
      migrations: [{ name: CONCURRENTLY_MIGRATION, transaction: false }],
      ledger: [{ name: CONCURRENTLY_MIGRATION }],
      undoError: boom,
    });

    await expect(
      runMigrationsWithAdvisoryLock(ds, { mode: "down" }),
    ).rejects.toBe(boom);
    expect(events).toEqual([
      expect.stringContaining("try_lock"),
      "ledger",
      "undoLastMigration",
      "unlock",
      "release",
    ]);
    expect(runner.release).toHaveBeenCalledTimes(1);
    expect(sqls.some((s) => /\b(DELETE|UPDATE|INSERT)\b/i.test(s))).toBe(false);
  });

  it("台账查询失败 → warn 并回退 each，不静默关闭普通迁移的事务保护", async () => {
    const { ds, undo, events } = makeDs({
      migrations: [{ name: CONCURRENTLY_MIGRATION, transaction: false }],
      ledgerError: new Error("relation does not exist"),
    });
    const warnings: string[] = [];

    await runMigrationsWithAdvisoryLock(ds, {
      mode: "down",
      warn: (m) => warnings.push(m),
    });

    expect(undo).toHaveBeenCalledWith({ transaction: "each" });
    expect(warnings.join("\n")).toContain('falling back to "each"');
    expect(events).toEqual(
      expect.arrayContaining([
        "ledger",
        "undoLastMigration",
        "unlock",
        "release",
      ]),
    );
  });

  it("未注入迁移实例（旧调用方）→ 回退 each，保持既有行为", async () => {
    const { ds, undo, events } = makeDs({ migrations: [] });

    await runMigrationsWithAdvisoryLock(ds, { mode: "down" });

    expect(undo).toHaveBeenCalledWith({ transaction: "each" });
    expect(events).not.toContain("ledger");
  });

  it("自定义 migrationsTableName 被正确引用", async () => {
    const { ds, sqls } = makeDs({
      migrations: [{ name: CONCURRENTLY_MIGRATION, transaction: false }],
      ledger: [{ name: CONCURRENTLY_MIGRATION }],
      table: "custom_migrations",
    });

    await runMigrationsWithAdvisoryLock(ds, { mode: "down" });

    expect(
      sqls.some((s) =>
        s.includes('SELECT "name" FROM "custom_migrations" ORDER BY "id" DESC'),
      ),
    ).toBe(true);
  });
});
