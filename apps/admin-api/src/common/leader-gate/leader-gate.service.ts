import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { Lock, RedisLockService } from "../services/redis-lock.service";

/**
 * ARCH-31 §5: cron 维护任务统一 Leader 门禁——竞选锁 key。
 * 独立于调度器选举的 `scheduler:leader`（实际 Redis key 为 `lock:scheduler:leader`，
 * 本服务为 `lock:cron:leader`），避免两套选举互相干扰（一方 demote 不应波及另一方）。
 */
export const CRON_LEADER_LOCK_KEY = "cron:leader";

/** 锁 TTL：与 scheduler:leader 同款 30s */
export const CRON_LEADER_TTL_MS = 30_000;

/** 非 Leader / fail-open 期间的竞选重试间隔 */
export const CRON_LEADER_RETRY_MS = 15_000;

/**
 * ARCH-31 §5: cron 维护任务统一 Leader 门禁（多实例矩阵 §3.8 收口）。
 *
 * 多实例部署时，无门禁的 @Cron 维护任务（executor 清扫、日志/产物/令牌/审计
 * 保留期清理、卡死部署探测、S3 日志回收等）会在每个实例并行执行。这些任务虽然
 * 多数幂等，但重复告警、并发无界 DELETE 抢锁等仍有实际成本——本服务用一把
 * Redis 锁选出「cron Leader」，非 Leader 实例的门禁 @Cron 直接短路。
 *
 * 与 SchedulerService 的 Leader 选举（TASK-006）同款语义、互相独立：
 * - 锁 key：`cron:leader`（≠ `scheduler:leader`），TTL 30s；
 *   RedisLockService.acquireLock 内置 watchdog 以 TTL/3（10s）续期，本服务另设
 *   TTL/2（15s）校验定时器，用 extendLock 探测锁是否仍归本实例，失败即 demote
 *   并进入竞选重试循环。
 * - 降级（fail-open）：Redis 完全不可用（acquireLock 抛错）时按 Leader 运行，
 *   与 scheduler 同款语义——这些 @Cron 是幂等清扫，单实例行为不回退，维护任务
 *   不因 Redis 故障而停摆；多实例短暂双 Leader 的代价只是重复执行幂等清扫。
 * - cron Leader 与调度 Leader 可能落在不同实例：调度任务本身另有
 *   `task:trigger:*` Redis 锁 + DB claim 双保险，两类清扫互不依赖对方身份，
 *   均为幂等操作，无正确性影响。
 *
 * 消费方式（@Cron 方法体第一行）：
 * ```
 * if (this.leaderGate && !this.leaderGate.isLeader) return;
 * ```
 * `this.leaderGate &&` 兜底既有单测的直接 new 装配（gate 缺席 → 门禁不生效，
 * 与 TracingService/DomainEventBus 的 @Optional no-op 先例一致）。
 */
@Injectable()
export class LeaderGateService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LeaderGateService.name);
  private leader = false;
  private leaderLock: Lock | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private verifyTimer: NodeJS.Timeout | null = null;
  /** destroy 后拒绝一切再竞选/再排程，防止在途异步回调复活定时器 */
  private destroyed = false;

  constructor(private readonly redisLockService: RedisLockService) {}

  /** 只读 Leader 身份——@Cron 门禁的唯一对外接口 */
  get isLeader(): boolean {
    return this.leader;
  }

  async onModuleInit(): Promise<void> {
    await this.tryAcquireLeadership();
  }

  /** 停止竞选/续期定时器并 best-effort 释放 Leader 锁，加快 failover */
  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.stopVerification();
    const lock = this.leaderLock;
    this.leaderLock = null;
    this.leader = false;
    if (lock) {
      lock.release().catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------------------
  // 竞选 / 维持（镜像 SchedulerService TASK-006 语义）
  // ---------------------------------------------------------------------------

  /** 启动竞选；结果落在 isLeader 上。导出仅供单元测试，视为模块内部方法 */
  async tryAcquireLeadership(): Promise<void> {
    try {
      const lock = await this.redisLockService.acquireLock(
        CRON_LEADER_LOCK_KEY,
        CRON_LEADER_TTL_MS,
      );
      if (lock) {
        const wasLeader = this.leader;
        this.leaderLock = lock;
        this.leader = true;
        this.startVerification();
        if (!wasLeader) {
          this.logger.log(
            "Cron leadership acquired — this node is now the leader for maintenance crons",
          );
        }
        return;
      }
      // 锁被其他实例持有
      if (this.leader && !this.leaderLock) {
        // fail-open 期间其他实例已真正拿到锁——让位，避免双 Leader
        this.demote("another instance acquired the cron leader lock");
      } else if (!this.leader) {
        this.logger.debug(
          "Cron leader lock held by another instance; staying follower",
        );
      }
    } catch (err: unknown) {
      // 降级（fail-open）：Redis 不可用时按 Leader 运行，避免维护 cron 整体
      // 停摆（与 SchedulerService 同款语义）。这些任务均幂等，多实例短暂双
      // Leader 只放大清扫成本，不产生正确性问题。
      const message = err instanceof Error ? err.message : String(err);
      if (!this.leader) {
        this.leader = true;
        this.leaderLock = null;
        this.logger.warn(
          `Cron leader election unavailable (${message}); degrading to leader so maintenance crons are not stopped`,
        );
      }
    }
    this.scheduleRetry();
  }

  /** cron Leader 周期性校验租约：锁已易主/丢失则 demote 并重试竞选 */
  private startVerification(): void {
    this.stopVerification();
    if (!this.leaderLock) return;
    this.verifyTimer = setInterval(() => {
      void this.verifyLeadership();
    }, CRON_LEADER_TTL_MS / 2);
    this.verifyTimer.unref();
  }

  /**
   * 用 extendLock 探测 Leader 租约是否仍归本实例（同一 lockId 才会续期成功）。
   * Redis 抖动时保留租约（RedisLockService 内部 watchdog 会继续续期），
   * 下一个校验周期再判定，避免单次网络抖动造成无谓的 Leader 切换。
   */
  private async verifyLeadership(): Promise<void> {
    const lock = this.leaderLock;
    if (!lock || lock.released) return;
    try {
      const ok = await this.redisLockService.extendLock(
        CRON_LEADER_LOCK_KEY,
        lock.lockId,
        CRON_LEADER_TTL_MS,
      );
      if (!ok) this.demote("cron leader lease expired");
    } catch (err: unknown) {
      this.logger.debug(
        `Cron leader lease check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private stopVerification(): void {
    if (this.verifyTimer) {
      clearInterval(this.verifyTimer);
      this.verifyTimer = null;
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.destroyed) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      // fail-open Leader 也周期性重试：Redis 恢复后补拿真实锁，或让位于新 Leader
      void this.tryAcquireLeadership();
    }, CRON_LEADER_RETRY_MS);
    this.retryTimer.unref();
  }

  /** 交出 cron Leader 身份（非 Leader 只保留竞选重试） */
  private demote(reason: string): void {
    this.leader = false;
    this.stopVerification();
    const lock = this.leaderLock;
    this.leaderLock = null;
    if (lock) {
      lock.release().catch(() => undefined);
    }
    this.logger.warn(
      `Cron leadership lost (${reason}) — maintenance crons on this node are gated off, will re-contend later`,
    );
    this.scheduleRetry();
  }
}
