import { Logger } from "@nestjs/common";

/**
 * 第四轮审计（A2）: 生产迁移跨实例互斥——pg_advisory_lock 包裹的显式迁移入口。
 *
 * ## 要解决的问题
 * 原 `migrationsRun: true`（configuration.ts）让 TypeORM 在**每个副本** boot 时
 * 自动跑迁移链，且没有任何跨实例互斥：HA `--scale admin-api=2` 双副本同时
 * boot 会竞跑同一条 pending 迁移链（migrations 表 SELECT-then-INSERT 存在竞窗；
 * DDL 并发执行可能约束冲突/半途死锁），轻则一副本 boot 失败重启循环，重则
 * schema 半套应用。
 *
 * ## 设计要点
 * - **会话级 advisory lock（pg_try_advisory_lock / pg_advisory_unlock）**：
 *   PG 保证同一 key 全局唯一持有；会话结束（进程崩溃/连接断开）锁自动释放，
 *   不存在死锁残留。锁由**独立 queryRunner 连接**持有（createQueryRunner 到
 *   release 全程同一条池连接），与 runMigrations 内部自用的连接互不干扰。
 * - **轮询 try 而非 pg_advisory_lock 阻塞等待**：阻塞式等待是一条长事务语句，
 *   会被连接池的 statement_timeout=30s（configuration.ts extra）反复掐断；且
 *   拿不到锁时无任何进度反馈。改为 try+轮询：拿不到 = 另一副本正在迁移，
 *   按 pollIntervalMs 等待重试（不报错退出——等它跑完自己再跑，发现链已
 *   应用即 no-op），每 WAIT_LOG_INTERVAL_MS 打一条等待日志。
 * - **finally 释放**：迁移成功/失败都必须解铃——池化连接归还后不关闭，
 *   会话级锁若不解开会随该池连接存活到 idle 超时，其他副本全程空等。
 * - **固定常量键**：boot 路径（main.ts）与 CLI 路径（migration-lock-cli.ts）
 *   必须用同一个 key 才能互斥，故为导出常量，禁止调用方自选。
 * - 本 util 只做「锁 → runMigrations/undoLastMigration → 解锁」的时序编排，
 *   不 import typeorm 类型——消费方以结构最小面（MigratableDataSource）传入
 *   真 DataSource（结构兼容）或单测 mock。
 */

/** 固定互斥键（int8 任意常数；boot 与 CLI 两侧共用，改动即失去互斥语义）。 */
export const MIGRATION_ADVISORY_LOCK_KEY = 727412345678;

/** 轮询间隔默认值：迁移是分钟级操作，1s 粒度足够；pollIntervalMs 可覆盖。 */
export const MIGRATION_LOCK_POLL_INTERVAL_MS = 1_000;

/** 等待日志节流：每 30s 至多一条，避免多副本等待期间刷屏。 */
const WAIT_LOG_INTERVAL_MS = 30_000;

/** 真 DataSource 满足的结构最小面（单测以 mock 实现同一形状）。
 * TypeORM 1.x 的 DataSource 只有 runMigrations / undoLastMigration（没有
 * revertMigrations）——down 模式走 undoLastMigration，且为可选成员：仅消费
 * up 模式的调用方（main.ts boot 路径）无需提供。 */
export interface MigratableDataSource {
  createQueryRunner(): {
    query(sql: string, params?: unknown[]): Promise<unknown>;
    release(): Promise<void>;
  };
  runMigrations(): Promise<unknown>;
  undoLastMigration?(): Promise<unknown>;
}

export interface AdvisoryLockMigrationOptions {
  /** 覆盖互斥键（仅测试用——生产路径必须缺省以共享常量键）。 */
  lockKey?: number;
  /** 轮询间隔毫秒（默认 1000；测试注入 1ms 加速）。 */
  pollIntervalMs?: number;
  /** up = runMigrations（默认）；down = undoLastMigration（CLI revert 路径，
   * TypeORM 1.x DataSource 的回滚 API 名，无 revertMigrations 一说）。 */
  mode?: "up" | "down";
  /** 日志注入口（默认 Nest Logger；测试注入收集器断言）。 */
  log?: (message: string) => void;
  warn?: (message: string) => void;
  /** 错误级日志注入口（db-1 的 INVALID INDEX 自检用；默认 Nest Logger）。 */
  error?: (message: string) => void;
}

const isTrue = (v: unknown): boolean => v === true || v === "t";
/**
 * db-1：INVALID 索引自检 SQL。
 *
 * `CREATE INDEX CONCURRENTLY` 被 statement_timeout 取消时，PG 会留下
 * `indisvalid = false` 的同名索引；它不参与查询，而 `IF NOT EXISTS` 重跑会命中
 * 它并直接跳过——索引**永远不会**被建起来，且没有任何报错。启动时查一次是
 * 唯一能把「静默的性能/唯一性缺失」变成可观测信号的地方。
 */
export const INVALID_INDEX_CHECK_SQL =
  "SELECT indexrelid::regclass::text AS index_name, indrelid::regclass::text AS table_name " +
  "FROM pg_index WHERE NOT indisvalid ORDER BY 1 LIMIT 50";

/**
 * 报告 indisvalid=false 的索引（fail-open：查询失败只 warn，绝不影响启动）。
 *
 * 不自动修复：DROP + 重建是 DDL，自动执行会在多副本启动风暴里放大锁竞争，
 * 且需要人判断是「历史超时残留」还是「正在构建中」（后者在另一连接里是
 * 合法中间态）。这里只把清单与处置步骤写进错误日志。
 */
async function reportInvalidIndexes(
  runner: { query(sql: string, params?: unknown[]): Promise<unknown> },
  error: (message: string) => void,
  warn: (message: string) => void,
): Promise<void> {
  try {
    const rows = (await runner.query(INVALID_INDEX_CHECK_SQL)) as Array<{
      index_name?: string;
      table_name?: string;
    }>;
    if (!Array.isArray(rows) || rows.length === 0) return;
    const list = rows
      .map((r) => `${r.table_name ?? "?"}.${r.index_name ?? "?"}`)
      .join(", ");
    error(
      `INVALID INDEX DETECTED (${rows.length}): ${list} — 这些索引 indisvalid=false，` +
        `查询不会使用它们。常见成因：CREATE INDEX CONCURRENTLY 被 statement_timeout ` +
        `取消（见迁移 0022/0049/0050/0051/0053/0055/0056/0075/0076 的会话级豁免）。` +
        `处置：确认没有正在进行的构建后 DROP INDEX CONCURRENTLY <name>，再重跑对应迁移。`,
    );
  } catch (err: unknown) {
    warn(
      `Invalid-index self-check skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function runMigrationsWithAdvisoryLock(
  dataSource: MigratableDataSource,
  options: AdvisoryLockMigrationOptions = {},
): Promise<void> {
  const lockKey = options.lockKey ?? MIGRATION_ADVISORY_LOCK_KEY;
  const pollIntervalMs =
    options.pollIntervalMs ?? MIGRATION_LOCK_POLL_INTERVAL_MS;
  const mode = options.mode ?? "up";
  // fail-fast：down 模式要求调用方具备 TypeORM 的回滚 API（真 DataSource 天然
  // 满足；mock/窄面消费方走 up 模式不受影响）。放锁外判——缺能力时没必要
  // 抢锁。
  if (mode === "down" && !dataSource.undoLastMigration) {
    throw new Error(
      "mode=down 需要暴露 undoLastMigration 的数据源（TypeORM revert API）",
    );
  }
  const log = options.log ?? ((m: string) => Logger.log(m, "Migration"));
  const warn = options.warn ?? ((m: string) => Logger.warn(m, "Migration"));
  const error =
    options.error ?? ((m: string) => Logger.error(m, undefined, "Migration"));

  const lockRunner = dataSource.createQueryRunner();
  try {
    // 轮询拿锁：拿不到 = 另一副本正在迁移，等待重试而非报错退出（boot 循环
    // 重启只会加剧竞跑）。每次重查都发独立语句，天然兼容 statement_timeout。
    let acquired = false;
    let waitedMs = 0;
    while (!acquired) {
      const rows = (await lockRunner.query(
        "SELECT pg_try_advisory_lock($1) AS locked",
        [lockKey],
      )) as Array<{ locked?: unknown }>;
      acquired = isTrue(rows?.[0]?.locked);
      if (!acquired) {
        if (waitedMs % WAIT_LOG_INTERVAL_MS === 0) {
          log(
            `Migration advisory lock busy (key=${lockKey}) — another instance is migrating, waiting (poll=${pollIntervalMs}ms)`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        waitedMs += pollIntervalMs;
      }
    }
    log(
      `Migration advisory lock acquired (key=${lockKey}) — running migrations (${mode})`,
    );
    // no-op 可观测：CI 的幂等守卫（admin-api-migrations job）断言第二次
    // migration:run 的输出含 "No migrations are pending"——旧 typeorm CLI
    // 自带这句，1.x 的 runMigrations() 无 pending 时静默返回。用执行前后
    // migrations 表行数对比判定（表不存在=-1，首跑场景必然有 pending，
    // 不可能误打）。
    const countMigrations = async (): Promise<number> => {
      try {
        const rows = (await lockRunner.query(
          'SELECT count(*)::int AS n FROM "migrations"',
        )) as Array<{ n?: number }>;
        return Number(rows?.[0]?.n ?? -1);
      } catch {
        return -1;
      }
    };
    const before = mode === "up" ? await countMigrations() : -1;
    try {
      if (mode === "down") {
        await dataSource.undoLastMigration();
      } else {
        await dataSource.runMigrations();
        // db-1：迁移后立刻自检 INVALID 索引（同一条锁连接；fail-open）。
        await reportInvalidIndexes(lockRunner, error, warn);
      }
    } finally {
      if (
        mode === "up" &&
        before >= 0 &&
        (await countMigrations()) === before
      ) {
        log("No migrations are pending");
      }
      // finally 释放（见头注）：解锁失败必须 loud warn——池化连接归还后仍
      // 持锁会让其他副本永远等待，这是需要立刻人工介入的故障态。
      try {
        const rows = (await lockRunner.query(
          "SELECT pg_advisory_unlock($1) AS unlocked",
          [lockKey],
        )) as Array<{ unlocked?: unknown }>;
        if (!isTrue(rows?.[0]?.unlocked)) {
          warn(
            `pg_advisory_unlock(${lockKey}) returned false — lock not held by this session (investigate immediately)`,
          );
        }
      } catch (err: unknown) {
        warn(
          `pg_advisory_unlock(${lockKey}) failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } finally {
    await lockRunner.release();
  }
}
