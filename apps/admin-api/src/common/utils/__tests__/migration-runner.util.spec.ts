import {
  MIGRATION_ADVISORY_LOCK_KEY,
  runMigrationsWithAdvisoryLock,
  type MigratableDataSource,
} from "../migration-runner.util";

/**
 * 第四轮审计（A2）: pg_advisory_lock 包裹迁移的时序编排钉子。
 *
 * mock 数据源按结构最小面（MigratableDataSource）实现，断言三件事：
 *  1) 调用序列恒为「try_lock（可重试）→ run/revert → unlock → release」，
 *     其中 unlock 在 runMigrations 抛错时也必须执行（finally 语义）；
 *  2) 锁忙时轮询等待而非报错退出（HA 双副本等待另一副本迁移的路径）；
 *  3) 默认互斥键为共享常量 MIGRATION_ADVISORY_LOCK_KEY（boot 与 CLI 两侧
 *     必须同键才能互斥——漂移即失效）。
 */
describe("runMigrationsWithAdvisoryLock (A2 migration mutex)", () => {
  type LockResult = boolean | Error;

  const makeDs = (lockResults: LockResult[]) => {
    const events: string[] = [];
    let lockIdx = 0;
    const runner = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes("pg_try_advisory_lock")) {
          events.push(`try_lock:${params?.[0]}`);
          const result = lockResults[Math.min(lockIdx++, lockResults.length - 1)];
          if (result instanceof Error) throw result;
          return [{ locked: result }];
        }
        if (sql.includes("pg_advisory_unlock")) {
          events.push("unlock");
          return [{ unlocked: true }];
        }
        throw new Error(`unexpected sql: ${sql}`);
      }),
      release: jest.fn(async () => {
        events.push("release");
      }),
    };
    const ds: MigratableDataSource = {
      createQueryRunner: () => runner,
      runMigrations: jest.fn(async () => {
        events.push("runMigrations");
      }),
      undoLastMigration: jest.fn(async () => {
        events.push("undoLastMigration");
      }),
    };
    return { ds, runner, events };
  };

  it("a) first-try acquisition: run → unlock → release in order, with the shared constant lock key", async () => {
    const { ds, events } = makeDs([true]);
    const logs: string[] = [];

    await runMigrationsWithAdvisoryLock(ds, { log: (m) => logs.push(m) });

    expect(events).toEqual([
      `try_lock:${MIGRATION_ADVISORY_LOCK_KEY}`,
      "runMigrations",
      "unlock",
      "release",
    ]);
    expect(logs.join("\n")).toContain("acquired");
  });

  it("b) lock busy → polls (does not throw) until acquired, then migrates exactly once", async () => {
    const { ds, events } = makeDs([false, false, true]);
    const logs: string[] = [];

    await runMigrationsWithAdvisoryLock(ds, {
      pollIntervalMs: 1,
      log: (m) => logs.push(m),
    });

    expect(events.filter((e) => e.startsWith("try_lock")).length).toBe(3);
    expect(events).toEqual(
      expect.arrayContaining([
        "runMigrations",
        "unlock",
        "release",
      ]),
    );
    expect(logs.join("\n")).toContain("another instance is migrating");
  });

  it("c) runMigrations throws → unlock and release still run (finally), error propagates", async () => {
    const { ds, runner, events } = makeDs([true]);
    (ds.runMigrations as jest.Mock).mockImplementationOnce(async () => {
      events.push("runMigrations");
      throw new Error("migration boom");
    });

    await expect(runMigrationsWithAdvisoryLock(ds)).rejects.toThrow(
      "migration boom",
    );
    expect(events).toEqual([
      expect.stringContaining("try_lock"),
      "runMigrations",
      "unlock",
      "release",
    ]);
    expect(runner.release).toHaveBeenCalledTimes(1);
  });

  it("d) mode=down routes to undoLastMigration (CLI revert path, TypeORM 1.x API name)", async () => {
    const { ds, events } = makeDs([true]);

    await runMigrationsWithAdvisoryLock(ds, { mode: "down" });

    expect(events).toEqual([
      expect.stringContaining("try_lock"),
      "undoLastMigration",
      "unlock",
      "release",
    ]);
    expect(ds.runMigrations).not.toHaveBeenCalled();
  });

  it("d2) mode=down without undoLastMigration fails fast (before lock acquisition)", async () => {
    const { ds, runner, events } = makeDs([true]);
    const narrow = ds as MigratableDataSource & {
      undoLastMigration?: unknown;
    };
    delete narrow.undoLastMigration;

    await expect(
      runMigrationsWithAdvisoryLock(ds, { mode: "down" }),
    ).rejects.toThrow("undoLastMigration");
    // 未抢锁、未迁移、未 release（fail-fast 在编排开始前）。
    expect(events).toEqual([]);
    expect(runner.release).not.toHaveBeenCalled();
  });

  it("e) unlock failure is swallowed (warn path) and release still happens", async () => {
    const events: string[] = [];
    const warnings: string[] = [];
    const runner = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes("pg_try_advisory_lock")) {
          events.push("try_lock");
          return [{ locked: true }];
        }
        if (sql.includes("pg_advisory_unlock")) {
          throw new Error("connection died before unlock");
        }
        throw new Error(`unexpected sql: ${sql}`);
      }),
      release: jest.fn(async () => {
        events.push("release");
      }),
    };
    const ds: MigratableDataSource = {
      createQueryRunner: () => runner,
      runMigrations: jest.fn(async () => {
        events.push("runMigrations");
      }),
      undoLastMigration: jest.fn(async () => undefined),
    };

    await expect(
      runMigrationsWithAdvisoryLock(ds, { warn: (m) => warnings.push(m) }),
    ).resolves.toBeUndefined();
    expect(events).toEqual(["try_lock", "runMigrations", "release"]);
    expect(warnings.join("\n")).toContain("unlock");
  });
});
