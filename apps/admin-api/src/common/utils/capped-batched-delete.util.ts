/**
 * NETOPT-8④: retention 分批 DELETE 循环的公共硬上限（轮数 + 墙钟）。
 *
 * 背景与实测结论见 log-retention-cleanup.service.ts 的 LOG-RETENTION-01
 * 注释：`do { ... } while (batchDeleted >= BATCH_SIZE)` 形态在 DELETE 报告的
 * affected 持续 >= 批大小（并发写入持续补进早于 cutoff 的行、驱动 affected
 * 语义差异、表持续有可删行）时**永不终止**——不是「慢」而是「挂死」，已实测
 * 打出 `FATAL ERROR: Ineffective mark-compacts near heap limit … out of
 * memory` 并杀死进程。
 *
 * log-retention-cleanup.service 首先实现了「轮数 + 墙钟」双闸兜住该风险；
 * 本 helper 把同一语义抽成公共实现，供其余 retention 分批 DELETE 站点统一
 * 回移植：executor.service 的 cleanupOldTaskExecutions /
 * cleanupExpiredMetricsHistory、audit.service 的 retentionDelete、
 * event-subscriptions outbox 每日 retention。
 *
 * 上限的意义不是「够不够删完」，而是**保证一定终止**：单晚删不完的余量交给
 * 下一个 cron 周期——保留期清理幂等，晚一晚无副作用。常量与
 * log-retention-cleanup.service 的同名导出**同源同值**（该文件改为自本处
 * re-export），避免同一语义出现第二份真值漂移。
 */

/** 单次 pass 的硬上限（轮数）：5000 × 200 = 单晚至多 100 万行 */
export const LOG_RETENTION_MAX_DELETE_ROUNDS = 200;
/** 单次 pass 墙钟上限（10 分钟）：防慢查询叠加把 cron 拖成常驻任务 */
export const LOG_RETENTION_MAX_DURATION_MS = 10 * 60 * 1000;

/** 结构最小面：只消费 warn（不为 util 引入整个 @nestjs/common 依赖面） */
export interface CappedDeleteLogger {
  warn(message: string): void;
}

export interface CappedBatchedDeleteOptions {
  /** 单批 DELETE 的预期批大小（affected >= 批大小 ⇒ 可能还有余量） */
  batchSize: number;
  /** 执行一批删除，返回受影响行数；抛错原样外抛（由 cron 入口兜底） */
  executeBatch: () => Promise<number>;
  /** 日志前缀（如 "DB-002" / "SEC-10"），warn 文案以其开头便于检索归因 */
  logLabel: string;
  logger: CappedDeleteLogger;
  maxRounds?: number;
  maxDurationMs?: number;
  /** 时钟注入点（测试用）；默认 Date.now */
  now?: () => number;
}

/**
 * 分批 DELETE 循环：逐批执行 executeBatch 直至单批 affected < batchSize，
 * 且轮数/墙钟任一达上限即停并 warn（照 log-retention-cleanup 的文案形态，
 * 剩余过期行交下一 cron 周期）。返回已删总行数。
 */
export async function cappedBatchedDelete(
  options: CappedBatchedDeleteOptions,
): Promise<number> {
  const {
    batchSize,
    executeBatch,
    logLabel,
    logger,
    maxRounds = LOG_RETENTION_MAX_DELETE_ROUNDS,
    maxDurationMs = LOG_RETENTION_MAX_DURATION_MS,
    now = Date.now,
  } = options;
  let totalDeleted = 0;
  let batchDeleted = 0;
  let rounds = 0;
  const deadline = now() + maxDurationMs;
  do {
    batchDeleted = await executeBatch();
    totalDeleted += batchDeleted;
    rounds += 1;
    if (batchDeleted < batchSize) break;
    if (rounds >= maxRounds) {
      logger.warn(
        `${logLabel}: 达单次清理轮数上限 ${maxRounds}，本轮已删 ${totalDeleted} 行；余量交下一 cron 周期`,
      );
      break;
    }
    if (now() >= deadline) {
      logger.warn(
        `${logLabel}: 达单次清理时间上限 ${maxDurationMs}ms（已 ${rounds} 轮 / ${totalDeleted} 行）；余量交下一 cron 周期`,
      );
      break;
    }
  } while (batchDeleted >= batchSize);
  return totalDeleted;
}
