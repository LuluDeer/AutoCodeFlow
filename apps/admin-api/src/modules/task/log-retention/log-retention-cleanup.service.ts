import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { ExecutionLogLine } from "../entities/execution-log-line.entity";

/** 默认日志保留天数（可经 LOG_RETENTION_DAYS 覆盖） */
export const DEFAULT_LOG_RETENTION_DAYS = 30;
/** 单批最大删除行数：限制单条 DELETE 的锁持有范围，防止长事务锁表 */
export const LOG_RETENTION_BATCH_SIZE = 5000;
/** 每日 03:30 清理（6 段 cron，与 scheduler 模块风格一致） */
export const LOG_RETENTION_CRON = "0 30 3 * * *";

/**
 * DB-002: execution_log_lines 表无 TTL 机制，长期运行后无限膨胀。
 * 每日定时按保留期（LOG_RETENTION_DAYS，默认 30 天）分批删除过期日志行。
 *
 * 范围说明：本服务只清理数据库行。LOG_STORAGE_DRIVER=s3 时完整日志对象
 * 外置到 MinIO/S3（log-storage/s3-log-storage.ts，execution-logs/*.log.gz），
 * 外置对象不属于本服务的清理范围，应由对象存储的 bucket lifecycle 策略
 * 或后续专门任务处理，否则 S3 侧仍会无限累积。
 *
 * 注册方式：由 TaskModule providers 装配；@Cron 由 SchedulerModule 中的
 * ScheduleModule.forRoot() 通过全局 DiscoveryService 扫描注册。
 */
@Injectable()
export class LogRetentionCleanupService {
  private readonly logger = new Logger(LogRetentionCleanupService.name);

  constructor(
    @InjectRepository(ExecutionLogLine)
    private readonly logLineRepo: Repository<ExecutionLogLine>,
    // ARCH-27: 保留期配置经 ConfigService 读取（configuration.ts
    // logRetention.days + Joi LOG_RETENTION_DAYS），取代直读 process.env。
    private readonly configService: ConfigService,
  ) {}

  /** 每日定时入口；清理失败只记日志，等下一轮 cron 重试，不影响主流程 */
  @Cron(LOG_RETENTION_CRON)
  async handleDailyCleanup(): Promise<void> {
    try {
      const deleted = await this.cleanupExpiredLines();
      if (deleted > 0) {
        this.logger.log(`DB-002: 清理 ${deleted} 行过期执行日志`);
      }
    } catch (err) {
      this.logger.error(
        `DB-002: 日志保留期清理失败: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * 分批删除 createdAt 早于保留期截止时间的日志行，返回删除总行数。
   *
   * - 每批通过 `id IN (SELECT id ... LIMIT 批大小)` 删除，循环直至单批
   *   影响行数小于批大小，避免一次性 DELETE 大范围行导致长事务锁表；
   * - 定时任务可能多实例同时运行，但按同一条件删除是幂等的（重复命中
   *   已删行只会得到更小的受影响行数），无副作用。
   */
  async cleanupExpiredLines(now: Date = new Date()): Promise<number> {
    const retentionDays = this.resolveRetentionDays();
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);

    let totalDeleted = 0;
    let batchDeleted = 0;
    do {
      const result = await this.logLineRepo
        .createQueryBuilder()
        .delete()
        .where(
          `"id" IN (
            SELECT "victim"."id" FROM "execution_log_lines" "victim"
            WHERE "victim"."createdAt" < :cutoff
            ORDER BY "victim"."id"
            LIMIT :batchSize
          )`,
          { cutoff, batchSize: LOG_RETENTION_BATCH_SIZE },
        )
        .execute();
      batchDeleted = result.affected ?? 0;
      totalDeleted += batchDeleted;
      if (batchDeleted > 0) {
        this.logger.debug(
          `DB-002: 本批清理 ${batchDeleted} 行（截止 ${cutoff.toISOString()}）`,
        );
      }
    } while (batchDeleted >= LOG_RETENTION_BATCH_SIZE);

    return totalDeleted;
  }

  /**
   * 解析保留期：经 ConfigService 读 logRetention.days（ARCH-27 收口）。
   * Joi 保证 LOG_RETENTION_DAYS 是 >=1 的整数，正常路径不会走回退；
   * 保留防御性回退（非数字 / <= 0）以兼容跳过 Joi 校验的测试场景。
   */
  private resolveRetentionDays(): number {
    const parsed = this.configService.get<number>("logRetention.days");
    if (typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    const rawValue = this.configService.get<string>("LOG_RETENTION_DAYS");
    if (rawValue !== undefined) {
      this.logger.warn(
        `DB-002: 非法的 LOG_RETENTION_DAYS="${rawValue}"，回退默认 ${DEFAULT_LOG_RETENTION_DAYS} 天`,
      );
    }
    return DEFAULT_LOG_RETENTION_DAYS;
  }
}
