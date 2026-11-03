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

/**
 * 锁 TTL：**90s**，与调度器选举（`scheduler:leader`）统一。
 *
 * R1 阶段 1 · 1-E：此前是 30s（比调度侧短 3 倍），造成**双重不一致**——
 * TTL 不同 + demote 容忍度不同（cron 侧单次校验失败即 demote，调度侧容忍
 * 连续 2 次）。后果是 cron Leader 在 Redis 抖动时**频繁切换**：
 *   ① 一次毫秒级抖动 → 立刻 demote → 15s 后重新竞选 → 可能落到另一实例；
 *   ② 于是**某个实例可能长期拿不到 Leader**（每次快要拿到就被抖掉）⇒
 *      维护清扫饥饿（不是重复执行，是**不执行**）。
 * 统一到 90s + 容忍 2 次失败后，单次抖动不再触发切换。
 *
 * ⚠️ **代价（如实）**：Leader 切换的 failover 时延从「最多 30s」变为「最多 90s」。
 * 这是**有意的权衡**——门禁保护的是幂等维护清扫（重复执行代价小、漏执行
 * 代价大），宁可切换慢一点也不要频繁切换导致清扫饥饿。若某天门禁里出现
 * 非幂等任务，应改用「DB 唯一占坑」而不是依赖 Leader 身份（见多实例矩阵 §4.4）。
 */
export const CRON_LEADER_TTL_MS = 90_000;

/**
 * demote 前的**连续校验失败容忍次数**。
 *
 * R1 阶段 1 · 1-E：此前 cron 侧**单次**校验失败即 demote（`extendLock` 抛错
 * 就放弃 Leader 身份），而调度侧容忍连续 2 次失败（`SCHEDULER_LEADER_VERIFY_MAX_FAILURES`）。
 * 两侧不一致 ⇒ 同样的 Redis 抖动，调度 Leader 不动、cron Leader 却掉线。
 * 现与调度侧统一为 2 次。
 *
 * 为什么容忍是安全的：`extendLock` 失败有两种成因——
 *   ① 真丢了租约（锁被他人抢走）→ 此时 `lockId` 已不匹配，**连续两次都失败**
 *      才 demote 会让本实例多当一会儿 Leader（最多一个校验周期 = TTL/2 = 45s），
 *      而门禁任务是幂等清扫 ⇒ 代价可接受；
 *   ② 网络抖动 → 容忍正是为了不误判。
 */
export const CRON_LEADER_VERIFY_MAX_FAILURES = 2;

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
 * - 锁 key：`cron:leader`（≠ `scheduler:leader`），TTL **90s**（R1 阶段 1 · 1-E
 *   与调度侧统一，此前为 30s）；
 *   RedisLockService.acquireLock 内置 watchdog 以 TTL/3（30s）续期，本服务另设
 *   TTL/2（45s）校验定时器，用 extendLock 探测锁是否仍归本实例；**连续 2 次**
 *   校验失败才 demote（R1 阶段 1 · 1-E，此前为单次失败即 demote），
 *   失败即 demote 并进入竞选重试循环。
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
  /**
   * 连续校验失败计数（R1 阶段 1 · 1-E）。
   *
   * 达到 `CRON_LEADER_VERIFY_MAX_FAILURES`（2）才 demote——单次失败只记数，
   * 保留 Leader 身份（与调度侧 `SCHEDULER_LEADER_VERIFY_MAX_FAILURES` 同款）。
   */
  private verifyFailures = 0;
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
        // 新拿到锁 ⇒ 失败计数清零（容忍是**连续**失败，新租约是新起点）。
        this.verifyFailures = 0;
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
   *
   * R1 阶段 1 · 1-E：失败**不立即** demote——连续失败达
   * `CRON_LEADER_VERIFY_MAX_FAILURES`（2）次才 demote。
   *
   * ## 为什么要计数而不是单次即 demote
   *
   * `extendLock` 的失败有两类成因：
   *   ① **网络/Redis 抖动**（毫秒级）——`RedisLockService` 的 watchdog 仍在
   *      独立续期（TTL/3），锁其实还在本实例名下。单次失败即 demote ⇒
   *      一次抖动就把 Leader 身份丢掉 ⇒ 15s 后重新竞选 ⇒ 可能落到别的实例 ⇒
   *      **某个实例长期拿不到 Leader**（每次快拿到就被抖掉）⇒ 维护清扫饥饿。
   *   ② **真丢了租约**（锁被他人抢走）——`lockId` 已不匹配，连续两次都失败。
   *      此时容忍的代价是本实例多当一会儿 Leader（最多一个校验周期 = TTL/2），
   *      而门禁保护的是**幂等**清扫 ⇒ 重复执行代价小，漏执行代价大 ⇒ 容忍划算。
   *
   * 故：**失败计数 + 容忍 2 次**，与调度侧 `SchedulerService` 逐字同款。
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
      if (ok) {
        // 成功一次即清零（容忍是**连续**失败，不是累计失败）。
        this.verifyFailures = 0;
        return;
      }
      // extendLock 返回 false = 锁已不属于本实例（真丢失，不是抖动）。
      this.verifyFailures += 1;
      if (this.verifyFailures >= CRON_LEADER_VERIFY_MAX_FAILURES) {
        this.demote("cron leader lease expired");
      } else {
        this.logger.warn(
          `Cron leader lease check failed (${this.verifyFailures}/${CRON_LEADER_VERIFY_MAX_FAILURES}); ` +
            `keeping leadership for now`,
        );
      }
    } catch (err: unknown) {
      // 抛错 = 网络抖动或 Redis 异常，同样只记数不清零。
      this.verifyFailures += 1;
      this.logger.debug(
        `Cron leader lease check failed (${this.verifyFailures}/${CRON_LEADER_VERIFY_MAX_FAILURES}): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      if (this.verifyFailures >= CRON_LEADER_VERIFY_MAX_FAILURES) {
        this.demote(
          `cron leader lease check failed ${this.verifyFailures} times in a row`,
        );
      }
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
