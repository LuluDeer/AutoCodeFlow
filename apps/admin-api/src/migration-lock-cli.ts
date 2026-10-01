/**
 * 第四轮审计（A2）: 迁移 CLI 的互斥包裹入口。
 *
 * `typeorm migration:run -d` 直跑 CLI 时没有任何跨实例互斥（与旧
 * migrationsRun 自动迁移同病），与 boot 路径（main.ts）并发时同样竞跑。
 * 本入口把 run/revert 两条 CLI 路径包进与 boot 相同的 pg_advisory_lock
 * （同一常量键 MIGRATION_ADVISORY_LOCK_KEY——两侧必须同键才能互斥），
 * package.json 的 migration:run / migration:revert（及 :prod 变体）已改为
 * 调用本文件；migration:generate 不触库，维持原 typeorm CLI。
 *
 * 用法：
 *   ts-node -r tsconfig-paths/register src/migration-lock-cli.ts up   （默认）
 *   ts-node -r tsconfig-paths/register src/migration-lock-cli.ts down
 */
import { AppDataSource } from "./data-source";
import { runMigrationsWithAdvisoryLock } from "./common/utils/migration-runner.util";

const direction = process.argv[2] === "down" ? "down" : ("up" as const);

async function main(): Promise<void> {
  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize();
  }
  try {
    await runMigrationsWithAdvisoryLock(AppDataSource, {
      mode: direction,
      // CLI 是人盯着的交互路径：日志直落 stdout 即可（data-source.ts 的
      // logging 配置已覆盖查询面；本侧只打锁等待/获取进度）。
      log: (m) => console.log(`[migration-lock] ${m}`),
      warn: (m) => console.warn(`[migration-lock] ${m}`),
    });
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch((err: unknown) => {
  console.error("[migration-lock] migration failed:", err);
  process.exit(1);
});
