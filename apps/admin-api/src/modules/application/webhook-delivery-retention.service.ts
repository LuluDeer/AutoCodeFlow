import { Injectable, Logger, Optional } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { WebhookDelivery } from "./entities/webhook-delivery.entity";
import { cappedBatchedDelete } from "../../common/utils/capped-batched-delete.util";
import { LeaderGateService } from "../../common/leader-gate/leader-gate.service";

/** 每批删除行数（账本行极小，1000 一批即可，避免长事务）。 */
export const WEBHOOK_DELIVERY_CLEANUP_BATCH_SIZE = 1000;

/**
 * SEC-3：`webhook_deliveries` 的**保留期清理**。
 *
 * 去重账本的寿命只有「调用方可能重试的窗口」——默认 7 天
 * （`WEBHOOK_DELIVERY_TTL_DAYS` 可配，与 claim 写入的 expiresAt 同源）。没有清理
 * 就是「每个 webhook 投递永久占一行」，而这张表的读面只有「键是否存在」，
 * 历史行零价值。
 *
 * ## 形态（复用既有 retention 模式：每日 cron + LeaderGate 门禁 + cappedBatchedDelete）
 * · `@Cron` 体自带 try/catch：失败只 `warn`，等下一轮，绝不让未处理 rejection
 *   打穿进程（CRON-GUARD 纪律）；
 * · LeaderGate：多副本下只有 leader 实例删（ARCH-31 §5），否则 N 副本重复扫描；
 * · 分批：`id IN (SELECT ... WHERE expiresAt < now() LIMIT batchSize)`，轮数/墙钟
 *   双闸由 cappedBatchedDelete 提供，单晚删不完的余量交下一 cron 周期（幂等）。
 *
 * 删除谓词与 claim 的「过期」判据逐字对齐（都是 `expiresAt < now()`）：
 * 判据一旦漂移，就会出现「claim 认为已过期可重占、retention 却永不删」的僵尸行。
 */
@Injectable()
export class WebhookDeliveryRetentionService {
  private readonly logger = new Logger(WebhookDeliveryRetentionService.name);

  constructor(
    @InjectRepository(WebhookDelivery)
    private readonly repo: Repository<WebhookDelivery>,
    // ARCH-31 §5：@Optional——单测直接 new 装配时 gate 缺席 → null → 门禁不生效
    // （与 AiMediaRetentionService / log-retention 同款）。
    @Optional()
    private readonly leaderGate: LeaderGateService | null = null,
  ) {}

  /** 每日 04:15（错开 ai retention 03:45 / log retention 的更早时段）。 */
  @Cron("0 15 4 * * *")
  async handleDailyCleanup(): Promise<void> {
    if (this.leaderGate && !this.leaderGate.isLeader) return;
    try {
      const deleted = await this.cleanupExpired();
      if (deleted > 0) {
        this.logger.log(
          `SEC-3 webhook-delivery retention: 清理 ${deleted} 行过期投递账本`,
        );
      }
    } catch (err) {
      // 只 warn：清理失败不污染主流程，下一轮 cron 幂等重试。
      this.logger.warn(
        `SEC-3 webhook-delivery retention 失败（下一轮重试）: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** 删除所有 `expiresAt < now()` 的行，返回删除总行数。 */
  async cleanupExpired(now: Date = new Date()): Promise<number> {
    return cappedBatchedDelete({
      batchSize: WEBHOOK_DELIVERY_CLEANUP_BATCH_SIZE,
      logLabel: "SEC-3 webhook-delivery",
      logger: this.logger,
      executeBatch: async () => {
        const result = await this.repo
          .createQueryBuilder()
          .delete()
          .where(
            `"id" IN (
              SELECT "id" FROM "webhook_deliveries"
               WHERE "expiresAt" < :now
               ORDER BY "expiresAt" ASC
               LIMIT :batchSize
            )`,
            { now, batchSize: WEBHOOK_DELIVERY_CLEANUP_BATCH_SIZE },
          )
          .execute();
        return result.affected ?? 0;
      },
    });
  }
}
