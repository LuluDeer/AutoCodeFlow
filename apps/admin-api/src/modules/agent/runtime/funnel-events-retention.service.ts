import { Injectable, Logger, Optional } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

// ARCH-31 §5: 多实例下 @Cron 维护任务仅 cron Leader 执行；@Optional 兼容
// 单测直接 new 装配（gate 缺席 → null → 门禁不生效），先例同 agent-session-retention。
import { LeaderGateService } from "../../../common/leader-gate/leader-gate.service";
import { FunnelEvent } from "../entities/funnel-event.entity";

/** TTFV 方案 §3.2：funnel_events append-only，保留 90 天。 */
export const FUNNEL_EVENT_RETENTION_DAYS = 90;

/** 单批 IN 列表上限（分块防超长语句；命名对齐 agent-session-retention）。 */
const DELETE_CHUNK = 500;

/**
 * R303 / TTFV §3.2：`funnel_events` 的 90 天滚动清理。
 *
 * 按 `createdAt`（入库时刻）而不是 `ts`（业务事件时刻）切边界：清理窗口是
 * 存储侧治理，且列的注释已明确 `createdAt` 只用于排障与清理窗口。
 * 删除走 keyset 分批：先按 id 升序取一批超期 id，再按 id IN + createdAt
 * 双条件删除，避免单条大事务；游标用最后一批最大 id，尾批不满即停。
 */
@Injectable()
export class FunnelEventsRetentionService {
  private readonly logger = new Logger(FunnelEventsRetentionService.name);

  constructor(
    @Optional()
    private readonly leaderGate: LeaderGateService | null = null,
    @InjectRepository(FunnelEvent)
    private readonly repo: Repository<FunnelEvent>,
  ) {}

  /**
   * 每日 03:50：`0 15 3` agent-media、`0 30 3` log、`0 35 3` s3-log、
   * `0 40 3` agent-session、`0 45 3` ai-media、`0 55 3` outbox、
   * `0 5 4` config_history（方案参考）、`0 15 4` webhook 均错开。
   */
  @Cron("0 50 3 * * *")
  async handleDailyCleanup(): Promise<void> {
    if (this.leaderGate && !this.leaderGate.isLeader) return;
    try {
      const deleted = await this.cleanupExpired();
      if (deleted > 0) {
        this.logger.log(
          `Funnel events retention: 清理 ${deleted} 行过期漏斗事件`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Funnel events retention failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** 删除 `createdAt < cutoff` 的 funnel_events 行，返回删除总数。 */
  async cleanupExpired(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(
      now.getTime() - FUNNEL_EVENT_RETENTION_DAYS * 86_400_000,
    );
    let deleted = 0;
    let cursor: string | null = null;
    for (;;) {
      const page = await this.loadExpiredIds(cutoff, cursor);
      if (page.length === 0) break;
      cursor = page[page.length - 1];
      for (let i = 0; i < page.length; i += DELETE_CHUNK) {
        const chunk = page.slice(i, i + DELETE_CHUNK);
        const res = await this.repo
          .createQueryBuilder()
          .delete()
          .where("id IN (:...ids)", { ids: chunk })
          .andWhere("createdAt < :cutoff", { cutoff })
          .execute();
        deleted += res.affected ?? 0;
      }
      if (page.length < DELETE_CHUNK) break;
    }
    return deleted;
  }

  /** keyset 分页读取一批超期 id（id 升序，游标 = 上一批最大 id）。 */
  private async loadExpiredIds(
    cutoff: Date,
    afterId: string | null,
  ): Promise<string[]> {
    const qb = this.repo
      .createQueryBuilder("e")
      .select("e.id", "id")
      .where("e.createdAt < :cutoff", { cutoff })
      .orderBy("e.id", "ASC")
      .limit(DELETE_CHUNK);
    if (afterId !== null) {
      qb.andWhere("e.id > :afterId", { afterId });
    }
    const rows = await qb.getRawMany<{ id: string }>();
    return rows.map((r) => r.id);
  }
}
