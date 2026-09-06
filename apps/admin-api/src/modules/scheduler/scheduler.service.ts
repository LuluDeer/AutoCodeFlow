import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, In, LessThan, Repository } from "typeorm";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import * as nodeCron from "node-cron";
import {
  Task,
  TaskStatus,
  TaskTriggerType,
  BlockStrategy,
  MisfireStrategy,
  normalizeTaskPriority,
} from "../task/entities/task.entity";
import {
  TaskExecution,
  ExecutionStatus,
  ExecutionFailureReason,
} from "../task/entities/task-execution.entity";
import { Executor, ExecutorStatus } from "../executor/entities/executor.entity";
import { ExecutorService } from "../executor/executor.service";
import {
  RedisLockService,
  Lock,
} from "../../common/services/redis-lock.service";
import {
  SchedulerMetricsService,
  SchedulerMetricsSnapshot,
  SchedulerMetricsDerived,
} from "./scheduler-metrics.service";

/** TASK-006: Leader Election 锁 key（RedisLockService 会加 lock: 前缀） */
export const SCHEDULER_LEADER_LOCK_KEY = "scheduler:leader";
/** Leader 锁 TTL；RedisLockService 内置 watchdog 以 TTL/3 周期续期 */
export const SCHEDULER_LEADER_TTL_MS = 30_000;
/** 非 Leader 重试竞选 / 降级重试间隔 */
export const SCHEDULER_LEADER_RETRY_MS = 15_000;

/**
 * N5: 单个任务的 stale 回收阈值：max(2 × taskTimeout, 60s)。executor /
 * processor 负责硬超时，stale 扫描只负责抢救 dispatch/callback 丢失的行，
 * 因此保守地等待两个超时周期（下限 60s）后才置 FAILED。
 */
function staleThresholdMs(timeoutSec: number): number {
  return Math.max(timeoutSec * 2, 60) * 1000;
}

/**
 * N6: 跨实例触发去重锁 TTL 的下限（毫秒）。去重窗口语义是"同一触发周期内
 * 至多一次触发"，取 1s 下限用于抵御亚秒级重复回调；fixed_rate 在减去
 * 抖动缓冲后（如 fixedRate=1s → 500ms）也以此下限兜底。
 */
export const TRIGGER_DEDUP_MIN_TTL_MS = 1_000;

/**
 * N6 残留（round5v2 §2.3）：fixed_rate 去重窗口的相位滞后缓冲（毫秒）。
 * 定时器 tick 在 t 时刻回调，enqueue 内 acquireLock 要到 t+δ 才真正拿到锁
 * （δ = tick→锁获取的异步滞后，几十 ms 量级），锁在 t+δ+TTL 过期。若
 * TTL 恰等于周期 P，下一 tick（t+P）落入锁剩余的 δ 窗口被 NX 拒绝 → 该
 * 周期被跳过，实测表现为 15s/30s 混合节奏。TTL 取 P - 缓冲，保证锁在
 * 下一 tick 前必定过期。
 */
export const TRIGGER_DEDUP_JITTER_BUFFER_MS = 500;

/**
 * N5: stale 扫描的固定兜底窗口——timeout=0（不限时）任务的最短回收延迟。
 */
export const STALE_SCAN_FALLBACK_MS = 60 * 60 * 1000;

/**
 * CONSISTENCY-02: 执行器活性探测的绝对兜底参数。当候选 stale 行所属执行器在线
 * 且心跳上报"仍在执行该 executionId"时，本轮跳过误判恢复；但该跳过不是无限的
 * ——一旦 stale 时长超过 max(6 × taskTimeout, ABSOLUTE_FLOOR_MS)，无视上报仍强制
 * 恢复，防止执行器 bug（谎报 running）导致行永久悬挂。timeout=0（无显式超时）
 * 或算得的绝对兜底短于该行 stale 阈值时，回退到 stale 阈值（保持既有回收行为，
 * 不因探测而放宽无限时任务的回收）。
 */
export const STALE_LIVENESS_ABSOLUTE_FLOOR_MS = 30 * 60 * 1000; // 30 min
export const STALE_LIVENESS_ABSOLUTE_TIMEOUT_MULTIPLIER = 6;

/**
 * N6: 计算触发去重锁的 TTL。去重窗口必须由"触发周期"决定而非任务超时：
 * 旧实现 lockTTL=max(taskTimeout, interval) 使短周期任务（如 15s）在默认
 * timeout=300s 下被压制成 300s 才触发一次。现在：
 * - fixed_rate：周期 - 抖动缓冲（TTL 恰等于周期时，tick→acquireLock 的相位
 *   滞后会让下一 tick 落入锁剩余窗口被 NX 拒绝，实测 15s/30s 混合节奏，
 *   见 TRIGGER_DEDUP_JITTER_BUFFER_MS），并不低于 MIN_TTL 下限
 * - cron：没有更细的周期信息，取 1s 下限（仅防同秒重复触发）
 * - 其他（api/manual）：5s 保守窗口
 * 窗口略短于周期不引入重复触发：定时器只在 Leader 上注册（scheduleOne 有
 * isLeader 门），同一任务在一个周期内本就只有 Leader 的一次 tick；Redis 锁
 * 与 claimTaskTrigger 只是 Leader 竞态过渡期（旧 Leader 残余定时器与新
 * Leader 并存）的双保险。claimTaskTrigger 的 lockTtlMs 与本 TTL 在 enqueue
 * 顶部同源计算，Redis 锁窗口与 DB claim 窗口自动保持一致。
 * 导出仅供单元测试，视为模块内部函数。
 */
export function computeTriggerDedupTtlMs(task: Task): number {
  if (task.triggerType === TaskTriggerType.FIXED_RATE && task.fixedRate) {
    return Math.max(
      task.fixedRate * 1000 - TRIGGER_DEDUP_JITTER_BUFFER_MS,
      TRIGGER_DEDUP_MIN_TTL_MS,
    );
  }
  if (task.triggerType === TaskTriggerType.CRON) {
    return TRIGGER_DEDUP_MIN_TTL_MS;
  }
  return 5_000;
}

/**
 * 终态保护门（TASK-004 / R4-P1）：所有把执行推进到终态的写路径都只允许命中
 * 仍处于打开状态（pending/running）的行——并发回调已写入的终态绝不被覆盖。
 */
const OPEN_EXECUTION_STATUSES = [
  ExecutionStatus.PENDING,
  ExecutionStatus.RUNNING,
];

@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  // fixed_rate timers
  private timers = new Map<string, NodeJS.Timeout>();
  // cron tasks
  private cronTasks = new Map<string, nodeCron.ScheduledTask>();
  // B-04: Track whether a fixed_rate task is currently executing to prevent re-entry
  private runningTasks = new Map<string, boolean>();
  // Prevent reload() and scheduleOne() from registering the same task concurrently.
  private schedulingTasks = new Set<string>();

  // TASK-006: Leader Election 状态
  private leaderLock: Lock | null = null;
  private isLeader = false;
  private leaderRetryTimer: NodeJS.Timeout | null = null;
  private leaderVerifyTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(Task) private taskRepo: Repository<Task>,
    @InjectRepository(TaskExecution)
    private execRepo: Repository<TaskExecution>,
    @InjectQueue("task-queue") private queue: Queue,
    private redisLockService: RedisLockService,
    private dataSource: DataSource,
    private schedulerMetrics: SchedulerMetricsService,
    // P2: stale sweep 的重试兑现（scheduleRetryAfterRecovery/hasRetryBudget）
    // 与 re-enqueue 前的 best-effort kill 通知（notifyExecutorKill）。
    private executorService: ExecutorService,
    private configService: ConfigService,
  ) {}

  // ---------------------------------------------------------------------------
  // TASK-006: Leader Election
  //
  // 多实例部署时，扫描型 tick（reload / checkMisfires / recoverStaleExecutions）
  // 只允许 Leader 执行，避免每个实例都注册一遍定时器并重复触发任务。
  //
  // - 锁 key: "scheduler:leader"（实际 Redis key 为 lock:scheduler:leader）
  // - TTL: 30s；RedisLockService.acquireLock 内置 watchdog 以 TTL/3（10s）续期，
  //   本服务另设 TTL/2（15s）的校验定时器，用 extendLock 探测锁是否仍归本实例，
  //   失败即 demote 并清空本地调度，由其他实例在重试周期内接管。
  // - 降级：Redis 完全不可用（acquireLock 抛错）时按 Leader 运行（fail-open），
  //   保持与单实例部署一致的行为——调度不会因 Redis 故障而整体停摆；
  //   跨实例去重退化为 enqueue() 内的 DB 条件 UPDATE claim 兜底。
  // - BullMQ worker（TaskProcessor）消费路径与 Leader 无关，不受影响。
  // ---------------------------------------------------------------------------

  async onModuleInit() {
    await this.initLeaderElection();
    await this.reload();
    await this.checkMisfires();
    await this.recoverStaleExecutions();
  }

  /** TASK-006: 启动 Leader 竞选；结果落在 isLeader 上，供扫描型 tick 判断 */
  async initLeaderElection(): Promise<void> {
    await this.tryAcquireLeadership();
  }

  private async tryAcquireLeadership(): Promise<void> {
    try {
      const lock = await this.redisLockService.acquireLock(
        SCHEDULER_LEADER_LOCK_KEY,
        SCHEDULER_LEADER_TTL_MS,
      );
      if (lock) {
        const wasLeader = this.isLeader;
        this.leaderLock = lock;
        this.isLeader = true;
        this.startLeaderVerification();
        if (!wasLeader) {
          this.logger.log(
            "Scheduler leadership acquired — this node is now the leader",
          );
        }
        return;
      }
      // 锁被其他实例持有
      if (this.isLeader && !this.leaderLock) {
        // 降级（fail-open）期间其他实例已真正拿到锁——让位，避免双 Leader
        this.demote("another instance acquired the leader lock");
      } else if (!this.isLeader) {
        this.logger.debug(
          "Scheduler leader lock held by another instance; staying follower",
        );
      }
    } catch (err: unknown) {
      // 降级（fail-open）：Redis 不可用时按 Leader 运行，避免调度整体停摆；
      // 重复触发风险由 enqueue() 的 DB 条件 claim 兜底（见 claimTaskTrigger）。
      const message = err instanceof Error ? err.message : String(err);
      if (!this.isLeader) {
        this.isLeader = true;
        this.leaderLock = null;
        this.logger.warn(
          `Leader election unavailable (${message}); degrading to leader so scheduling is not stopped`,
        );
      }
    }
    this.scheduleLeaderRetry();
  }

  /** Leader 周期性校验租约：锁已易主/丢失则 demote，本地调度交由新 Leader 重建 */
  private startLeaderVerification(): void {
    this.stopLeaderVerification();
    if (!this.leaderLock) return;
    this.leaderVerifyTimer = setInterval(() => {
      void this.verifyLeadership();
    }, SCHEDULER_LEADER_TTL_MS / 2);
    this.leaderVerifyTimer.unref();
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
        SCHEDULER_LEADER_LOCK_KEY,
        lock.lockId,
        SCHEDULER_LEADER_TTL_MS,
      );
      if (!ok) this.demote("leader lease expired");
    } catch (err: unknown) {
      this.logger.debug(
        `Leader lease check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private stopLeaderVerification(): void {
    if (this.leaderVerifyTimer) {
      clearInterval(this.leaderVerifyTimer);
      this.leaderVerifyTimer = null;
    }
  }

  private scheduleLeaderRetry(): void {
    if (this.leaderRetryTimer) return;
    this.leaderRetryTimer = setTimeout(() => {
      this.leaderRetryTimer = null;
      // 降级 Leader 也周期性重试：Redis 恢复后补拿真实锁，或让位于新 Leader
      void this.tryAcquireLeadership();
    }, SCHEDULER_LEADER_RETRY_MS);
    this.leaderRetryTimer.unref();
  }

  /** 交出 Leader 身份：停本地全部调度，非 Leader 只保留竞选重试 */
  private demote(reason: string): void {
    this.isLeader = false;
    this.stopLeaderVerification();
    const lock = this.leaderLock;
    this.leaderLock = null;
    if (lock) {
      lock.release().catch(() => undefined);
    }
    // 已注册的定时器/ Cron 必须清空，否则 demote 后本节点仍会触发 enqueue，
    // 与新 Leader 产生竞争（enqueue 有 Redis 锁 + DB claim 双保险，但能免则免）
    for (const id of [...this.timers.keys()]) this.stop(id);
    for (const id of [...this.cronTasks.keys()]) this.stop(id);
    this.logger.warn(
      `Scheduler leadership lost (${reason}) — local schedules stopped, will re-contend later`,
    );
    this.scheduleLeaderRetry();
  }

  private getCronOptions(task: Task): { timezone: string } | undefined {
    const timezone = task.timezone?.trim();
    if (!timezone) return undefined;

    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(
        new Date(),
      );
      return { timezone };
    } catch {
      this.logger.warn(
        `Invalid timezone for task "${task.name}": ${timezone}; scheduling with server default timezone`,
      );
      return undefined;
    }
  }

  async onModuleDestroy() {
    this.timers.forEach((t) => clearInterval(t));
    this.cronTasks.forEach((t) => t.stop());
    // TASK-006: 停止竞选/续期定时器并主动释放 Leader 锁，加快 failover
    if (this.leaderRetryTimer) {
      clearTimeout(this.leaderRetryTimer);
      this.leaderRetryTimer = null;
    }
    this.stopLeaderVerification();
    const lock = this.leaderLock;
    this.leaderLock = null;
    this.isLeader = false;
    if (lock) {
      lock.release().catch(() => undefined);
    }
  }

  /** Detect misfires on startup and compensate according to policy */
  async checkMisfires() {
    // TASK-006: 扫描型 tick 仅 Leader 执行
    if (!this.isLeader) {
      this.logger.debug("checkMisfires skipped: not the scheduler leader");
      return;
    }
    const tasks = await this.taskRepo.find({
      where: { status: TaskStatus.ACTIVE },
    });
    const now = Date.now();
    for (const task of tasks) {
      if (!task.lastTriggerTime) continue;
      const gap = now - task.lastTriggerTime.getTime();
      const threshold =
        task.triggerType === TaskTriggerType.FIXED_RATE
          ? (task.fixedRate || 60) * 2000
          : 2 * 60 * 1000;
      if (gap > threshold) {
        if (task.misfireStrategy === MisfireStrategy.FIRE_ONCE) {
          this.logger.warn(`Misfire detected for "${task.name}", firing once`);
          await this.enqueue(task, "misfire");
        } else {
          this.logger.warn(
            `Misfire detected for "${task.name}", strategy=IGNORE`,
          );
        }
      }
    }
  }

  /**
   * REC-01: Periodically find executions stuck in RUNNING (e.g. from a crash)
   * and mark them FAILED so the UI never shows permanently-running tasks.
   * Runs on startup and every 10 minutes thereafter.
   *
   * P2: sweep 赢得 RUNNING→FAILED 后还兑现重试预算——预算未耗尽的执行经
   * ExecutorService.scheduleRetryAfterRecovery 创建新 PENDING execution 并
   * 入队（re-enqueue 前先 best-effort kill 原执行器进程），开关见
   * STALE_RECOVERY_RETRY_ENABLED。
   *
   * Timeout logic:
   * - If the associated task has a timeout > 0, use that as the stale threshold.
   * - Otherwise fall back to a 1-hour global grace window.
   */
  @Cron("0 */10 * * * *")
  async recoverStaleExecutions() {
    // TASK-006: 扫描型 tick 仅 Leader 执行
    if (!this.isLeader) {
      this.logger.debug(
        "recoverStaleExecutions skipped: not the scheduler leader",
      );
      return;
    }
    // Medium-1.2: scan only RUNNING rows whose startTime is older than the
    // initial cutoff — the rest are presumed healthy and should not be
    // materialized into memory. The per-task timeout refinement below may
    // still rescue individual rows older than that, but we cap the initial
    // find() to keep the cron cheap even with millions of rows.
    //
    // N5: the cutoff is now tied to task timeouts instead of a fixed 1h —
    // a stuck execution for a short-timeout task (e.g. 10s) must not wait up
    // to 1h before being recovered. Per-task stale threshold =
    // max(2 × taskTimeout, 60s): the executor/processor own the hard timeout,
    // so the sweep deliberately waits out two timeout periods (60s floor) and
    // only rescues rows whose dispatch/callback was lost. The scan cutoff is
    // the smallest such threshold (bounded by the 1h fallback used for
    // timeout=0 tasks), so short-timeout tasks are swept promptly while the
    // scan stays cheap.
    const now = Date.now();
    const DEFAULT_STALE_MS = STALE_SCAN_FALLBACK_MS; // 1-hour fallback
    const initialCutoff = new Date(now - (await this.staleScanWindowMs()));
    const runningExecs = await this.execRepo.find({
      where: {
        status: ExecutionStatus.RUNNING,
        startTime: LessThan(initialCutoff),
      },
    });

    // Get all unique taskIds and fetch their timeouts
    const taskIds = [...new Set(runningExecs.map((e) => e.taskId))];
    const tasks =
      taskIds.length > 0 ? await this.taskRepo.findBy({ id: In(taskIds) }) : [];
    const taskTimeouts = new Map<string, number>();
    for (const t of tasks) {
      if (t.timeout && t.timeout > 0) {
        taskTimeouts.set(t.id, t.timeout);
      }
    }
    // P2: re-enqueue 需要完整 task 行（maxRetry/retryDelay 预算语义）与原执行
    // 快照（retryCount/params/triggerType）——循环外各索引一次。
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const execById = new Map(runningExecs.map((e) => [e.id, e]));

    // TASK-004: 在内存中按"超时类型"分组，随后用单事务内的条件批量 UPDATE
    // 一次性恢复（替代原先逐行 save 的 N 条独立 UPDATE）。
    // 终态保护：UPDATE 仅命中 status IN (pending, running) 的行，与
    // handleCallback / killExecution 的保护语义一致——已进入终态的行
    // （如并发回调刚写入 SUCCESS）绝不会被置为 FAILED。
    const timedOut = new Map<number, TaskExecution[]>(); // taskTimeoutSec -> execs
    const recovered: TaskExecution[] = [];

    // CONSISTENCY-02: 先收集"超阈值候选"，再对候选做一次批量执行器活性探测，
    // 命中"执行器在线且上报仍在执行该 executionId"的行本轮跳过（改到绝对兜底仍
    // 未上报时才恢复）。先聚合候选再探测，避免把无谓的执行器查询塞进行循环。
    type StaleCandidate = {
      exec: TaskExecution;
      taskTimeoutSec?: number;
      staleMs: number;
      ageMs: number;
    };
    const candidates: StaleCandidate[] = [];
    for (const exec of runningExecs) {
      const anchor = exec.startTime ?? exec.createdAt;
      if (!anchor) continue;

      // Prefer per-task timeout (seconds → ms); fall back to global default.
      // N5: use max(2 × taskTimeout, 60s) — matching the scan cutoff formula —
      // so the sweep never races the processor's own hard-timeout kill.
      const taskTimeoutSec = taskTimeouts.get(exec.taskId);
      const staleMs =
        taskTimeoutSec && taskTimeoutSec > 0
          ? staleThresholdMs(taskTimeoutSec)
          : DEFAULT_STALE_MS;

      const ageMs = now - anchor.getTime();
      if (ageMs > staleMs) {
        candidates.push({ exec, taskTimeoutSec, staleMs, ageMs });
      }
    }

    const liveness = await this.collectRunningLiveness(candidates);
    for (const c of candidates) {
      // 活性命中：执行器在线且明确上报仍在跑该 executionId，且未到绝对兜底 →
      // 本轮跳过，交由后续心跳 / 真实回调收敛。
      if (liveness.deferredIds.has(c.exec.id)) continue;
      if (c.taskTimeoutSec && c.taskTimeoutSec > 0) {
        const bucket = timedOut.get(c.taskTimeoutSec) ?? [];
        bucket.push(c.exec);
        timedOut.set(c.taskTimeoutSec, bucket);
      } else {
        recovered.push(c.exec);
      }
    }

    // 跳过本轮的行不计入 recovered，故 totalRecovered 自动不含它们。

    const OPEN_STATUSES = OPEN_EXECUTION_STATUSES;
    const finishedAt = new Date();
    // TASK-004: 通过 RETURNING 收集真正被本批 UPDATE 命中的行——竞态中
    // 已被回调写成终态的行不会出现在受影响集合里，executor 槽位只对
    // 确实被恢复的行释放（避免与回调路径重复释放）。
    const recoveredRows: Array<{
      id: string;
      executorAddress: string | null;
    }> = [];

    if (timedOut.size > 0 || recovered.length > 0) {
      // 单事务：部分失败整体回滚，恢复动作要么全部生效要么全部不变
      await this.dataSource.transaction(async (manager) => {
        const runUpdate = async (
          execs: TaskExecution[],
          patch: Record<string, unknown>,
        ): Promise<void> => {
          if (execs.length === 0) return;
          const result = await manager
            .createQueryBuilder()
            .update(TaskExecution)
            .set(patch)
            .where('"id" IN (:...ids) AND "status" IN (:...open)', {
              ids: execs.map((e) => e.id),
              open: OPEN_STATUSES,
            })
            .returning(["id", "executorAddress"])
            .execute();
          for (const row of (result.raw ?? []) as Array<{
            id: string;
            executorAddress: string | null;
          }>) {
            recoveredRows.push(row);
          }
        };

        for (const [timeoutSec, execs] of timedOut) {
          await runUpdate(execs, {
            status: ExecutionStatus.FAILED,
            endTime: finishedAt,
            errorMessage: `Execution timed out after ${timeoutSec}s`,
            failureReason: ExecutionFailureReason.TIMEOUT,
          });
        }
        // P2: 本桶是 sweep 自行定案的"worker 崩溃型/回调丢失型"恢复行，
        // failureReason 用 STALE_RECOVERED 取代泛化的 UNKNOWN，使"sweep 恢复 +
        // 重试预算兑现/耗尽"全链路可溯源。timedOut 桶保留 TIMEOUT——超时分类
        // 本身有语义且被下游消费，sweep 归属由 REC-01 日志承载。
        await runUpdate(recovered, {
          status: ExecutionStatus.FAILED,
          endTime: finishedAt,
          errorMessage: "Execution did not complete (recovered by stale sweep)",
          failureReason: ExecutionFailureReason.STALE_RECOVERED,
        });
      });

      // P2 (sweep 重试预算兑现): task.processor 已把 RUNNING 移出 claimable，
      // worker 在 claim 后崩溃的执行只能等本 sweep 收敛——若只置 FAILED 不
      // re-enqueue，task.maxRetry>0 的任务实际拿不到任何重试。此处对 sweep
      // 赢家兑现预算。
      //
      // 幂等/竞态护栏：recoveredRows 来自 UPDATE ... RETURNING，只含条件
      // UPDATE（status IN open）真正命中的行——并发回调已写终态的输家行不在
      // 其中，绝不触发 re-enqueue；新 execution 由 execRepo.create 生成全新
      // uuid，同一 execution 不会被重复 re-enqueue。
      //
      // timeout=0（不限时）任务不做特判：它们只有在"执行器在线且活性上报仍
      // 含该 execution"被 defer 到绝对兜底（30min）之后才会进入本恢复路径，
      // 上报已不可信（谎报/僵死），与其余行同等对待——kill 通知尽力而为，
      // 预算未耗尽则重试。取舍：极端情况下可能与仍在运行的原进程并行一次，
      // 由 kill 通知兜底；相比"静默丢重试"，这是更安全的失败方向。
      const retryOnRecovery = this.staleRecoveryRetryEnabled();
      for (const row of recoveredRows) {
        await this.releaseExecutorSlot(row.executorAddress);
        this.logger.warn(`REC-01: execution ${row.id} recovered as FAILED`);
        if (!retryOnRecovery) continue;
        const exec = execById.get(row.id);
        const task = exec ? taskById.get(exec.taskId) : undefined;
        if (!exec || !task) {
          // 任务已删除/查不到：无预算可对照，维持旧行为（只 FAILED）。
          continue;
        }
        // 预算语义与 executor-restart 路径同源（ExecutorService）。预算耗尽
        // 时连 kill 都不发——没有新执行就不会双跑。
        if (!this.executorService.hasRetryBudget(task, exec)) continue;
        // kill 必须在 re-enqueue 之前：防"执行器谎报/进程僵死但仍存活"场景下
        // 原进程与新执行双跑。best-effort——离线/404/超时不阻塞重试。
        try {
          await this.executorService.notifyExecutorKill(
            exec.id,
            exec.executorAddress,
          );
        } catch (err: unknown) {
          this.logger.warn(
            `REC-01: kill notification before retry failed for ${exec.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        try {
          await this.executorService.scheduleRetryAfterRecovery(
            task,
            exec,
            "stale_recovery",
          );
        } catch (err: unknown) {
          this.logger.warn(
            `REC-01: retry scheduling failed for recovered execution ${exec.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }

    // P1: sweep PENDING executions never picked up by a worker (queue lost
    // the job / Redis flushed) — after a grace window mark them FAILED.
    // TASK-004: 同样改为单条条件批量 UPDATE（终态保护：仅 PENDING 可被清理）。
    const stalePending = await this.execRepo.find({
      where: { status: ExecutionStatus.PENDING },
    });
    const PENDING_GRACE_MS = 10 * 60 * 1000;
    const stalePendingIds = stalePending
      .filter(
        (exec) =>
          exec.createdAt && now - exec.createdAt.getTime() > PENDING_GRACE_MS,
      )
      .map((exec) => exec.id);
    let recoveredPending = 0;
    if (stalePendingIds.length > 0) {
      const result = await this.execRepo
        .createQueryBuilder()
        .update(TaskExecution)
        .set({
          status: ExecutionStatus.FAILED,
          endTime: finishedAt,
          errorMessage:
            "Execution was never dispatched by the queue (recovered by stale sweep)",
          failureReason: ExecutionFailureReason.UNKNOWN,
        })
        .where('"id" IN (:...ids) AND "status" = :status', {
          ids: stalePendingIds,
          status: ExecutionStatus.PENDING,
        })
        .returning(["id"])
        .execute();
      recoveredPending = ((result.raw ?? []) as unknown[]).length;
      if (recoveredPending === 0 && result.affected) {
        recoveredPending = result.affected;
      }
      if (recoveredPending > 0) {
        this.logger.warn(
          `REC-01: ${recoveredPending} pending execution(s) never dispatched, marked FAILED`,
        );
      }
    }

    const totalRecovered = recoveredRows.length + recoveredPending;
    if (totalRecovered > 0) {
      this.logger.warn(
        `REC-01: recovered ${totalRecovered} stale execution(s)`,
      );
    }
  }

  /**
   * CONSISTENCY-02: 对超阈值候选做一次执行器活性探测。返回本轮应"跳过恢复"的
   * executionId 集合（deferredIds）。跳过条件——候选行所属执行器 status=ONLINE
   * 且其心跳上报的 runningExecutionIds 命中该 executionId，且 stale 时长未超过
   * 绝对兜底 max(6×timeout, 30min)。执行器离线 / 无记录 / 未上报（runningExecutionIds
   * 为 null 或不含该 id）→ 不跳过，维持既有恢复行为。
   *
   * 探测失败（执行器表查询异常）时降级为"不跳过"（空集），宁可对疑似仍健康的行
   * 恢复一次，也不放大容量误判。
   */
  private async collectRunningLiveness(
    candidates: Array<{
      exec: TaskExecution;
      taskTimeoutSec?: number;
      staleMs: number;
      ageMs: number;
    }>,
  ): Promise<{ deferredIds: Set<string> }> {
    const deferredIds = new Set<string>();
    if (candidates.length === 0) return { deferredIds };

    const addresses = [
      ...new Set(
        candidates
          .map((c) => c.exec.executorAddress)
          .filter((a): a is string => Boolean(a)),
      ),
    ];
    if (addresses.length === 0) return { deferredIds };

    let executors: Array<{
      address: string;
      status: ExecutorStatus;
      runningExecutionIds: string[] | null;
    }> = [];
    try {
      executors = await this.dataSource.getRepository(Executor).find({
        where: { address: In(addresses) },
        select: ["address", "status", "runningExecutionIds"],
      });
    } catch (err: unknown) {
      this.logger.warn(
        `recoverStaleExecutions liveness probe degraded (recover normally): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { deferredIds };
    }

    const byAddress = new Map(executors.map((ex) => [ex.address, ex] as const));
    for (const c of candidates) {
      const addr = c.exec.executorAddress;
      if (!addr) continue;
      const ex = byAddress.get(addr);
      // 执行器离线 / 无记录 / 未上报该字段 / 未命中该 executionId → 不跳过。
      if (!ex || ex.status !== ExecutorStatus.ONLINE) continue;
      if (!Array.isArray(ex.runningExecutionIds)) continue;
      if (!ex.runningExecutionIds.includes(c.exec.id)) continue;

      // 活性命中，但设绝对兜底：超过 max(6×timeout, 30min) 仍强制恢复。
      // ageMs 以 anchor（startTime ?? createdAt）为基准，与 stale 判定同锚。
      const absoluteFloorMs = Math.max(
        c.taskTimeoutSec && c.taskTimeoutSec > 0
          ? c.taskTimeoutSec * 1000 * STALE_LIVENESS_ABSOLUTE_TIMEOUT_MULTIPLIER
          : 0,
        STALE_LIVENESS_ABSOLUTE_FLOOR_MS,
        c.staleMs,
      );
      if (c.ageMs > absoluteFloorMs) {
        this.logger.warn(
          `REC-01: execution ${c.exec.id} reported still-running by ${addr} but exceeded the absolute fallback — recovering anyway`,
        );
        continue;
      }
      deferredIds.add(c.exec.id);
    }
    return { deferredIds };
  }

  /**
   * P2: stale sweep 重试兑现开关（env STALE_RECOVERY_RETRY_ENABLED，默认
   * true）。仅显式 false 关闭；ConfigService 未注册/未命中（如单测环境）时
   * 按默认开启处理，保证生产默认行为与设计一致。
   */
  private staleRecoveryRetryEnabled(): boolean {
    return (
      this.configService.get<boolean>("scheduler.staleRecoveryRetryEnabled") !==
      false
    );
  }

  private async releaseExecutorSlot(address?: string | null): Promise<void> {
    if (!address) return;
    await this.dataSource
      .createQueryBuilder()
      .update("executors")
      .set({ runningTaskCount: () => 'GREATEST("runningTaskCount" - 1, 0)' })
      .where("address = :addr", { addr: address })
      .execute();
  }

  /**
   * N5: stale 扫描的初始窗口 = min(所有 active 任务中最短的
   * max(2×timeout, 60s) 阈值, 1h 兜底)。timeout=0（不限时）任务不参与收缩，
   * 仍由 1h 兜底覆盖；没有任何短 timeout 任务时窗口保持 1h，扫描开销不变。
   * 轻量查询仅取 id/timeout 两列。
   */
  private async staleScanWindowMs(): Promise<number> {
    const tasks = await this.taskRepo.find({
      where: { status: TaskStatus.ACTIVE },
      select: ["id", "timeout"],
    });
    let shortestMs = Number.POSITIVE_INFINITY;
    for (const t of tasks ?? []) {
      if (t.timeout && t.timeout > 0) {
        shortestMs = Math.min(shortestMs, staleThresholdMs(t.timeout));
      }
    }
    if (!Number.isFinite(shortestMs)) return STALE_SCAN_FALLBACK_MS;
    // 上限仍为 1h 兜底：超长 timeout 任务的行会被扫描到但被逐行阈值过滤
    return Math.min(shortestMs, STALE_SCAN_FALLBACK_MS);
  }

  /** Re-scan active tasks every minute and register any unscheduled tasks */
  @Cron(CronExpression.EVERY_MINUTE)
  async reload() {
    // TASK-006: 扫描型 tick 仅 Leader 执行（非 Leader 节点不注册任何定时器）
    if (!this.isLeader) {
      this.logger.debug("reload skipped: not the scheduler leader");
      return;
    }
    // R4-§5.5: tick 计数 + 耗时（含本 tick 的全部扫描/注册工作）
    const tickStart = Date.now();
    try {
      await this.reloadActiveTasks();
    } finally {
      this.schedulerMetrics.recordTick(Date.now() - tickStart);
    }
  }

  /** reload 的实际扫描体（抽出以便 tick 计时只包住扫描工作本身） */
  private async reloadActiveTasks(): Promise<void> {
    const tasks = await this.taskRepo.find({
      where: { status: TaskStatus.ACTIVE },
    });
    const activeIds = new Set(tasks.map((t) => t.id));

    // BUG-01: Stop and clean up timers for tasks that are no longer active
    // This prevents memory leaks from accumulating inactive task references
    for (const id of this.timers.keys()) {
      if (!activeIds.has(id)) this.stop(id);
    }
    for (const id of this.cronTasks.keys()) {
      if (!activeIds.has(id)) this.stop(id);
    }

    // BUG-01: Clean up running tasks map for tasks that are no longer active
    for (const id of this.runningTasks.keys()) {
      if (!activeIds.has(id)) this.runningTasks.delete(id);
    }

    for (const task of tasks) {
      if (this.timers.has(task.id) || this.cronTasks.has(task.id)) continue;
      await this.scheduleOne(task);
    }
  }

  async enqueue(task: Task, triggerType: string) {
    // N6: the dedup window is derived from the trigger period, NOT the task
    // timeout (the old max(timeout, interval) TTL silently suppressed
    // short-period tasks down to the task timeout). See computeTriggerDedupTtlMs.
    const lockTTL = computeTriggerDedupTtlMs(task);

    let lock: Lock | null = null;
    let claimedViaDb = false;
    try {
      // R4-P0: renew:false — this lock is never released (see finally): its
      // TTL IS the cross-instance dedup window. A renewing watchdog would
      // keep it alive forever, so each scheduled task would only ever fire
      // once per process lifetime.
      lock = await this.redisLockService.acquireLock(
        `task:trigger:${task.id}`,
        lockTTL,
        { renew: false },
      );
    } catch (err: unknown) {
      // TASK-006 降级路径：Redis 不可用时改用 DB 条件 UPDATE 原子 claim 兜底
      // （Leader Election + claim 双保险的第二道）。claim 失败即跳过。
      const claimed = await this.claimTaskTrigger(task, lockTTL);
      if (!claimed) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.debug(
          `Task "${task.name}" trigger claimed by another instance (db claim, redis=${message}), skip`,
        );
        this.schedulerMetrics.recordTriggerSkippedDbClaim();
        return null;
      }
      claimedViaDb = true;
      this.logger.warn(
        `Redis trigger lock unavailable for "${task.name}"; proceeding with DB claim`,
      );
    }
    if (!lock && !claimedViaDb) {
      this.logger.debug(
        `Task "${task.name}" recently triggered by another instance, skip`,
      );
      this.schedulerMetrics.recordTriggerSkippedLockHeld();
      return null;
    }

    try {
      // N8: re-fetch task state to avoid acting on a stale trigger snapshot
      // (a paused/deleted task must not be enqueued).
      const taskRecord = await this.taskRepo.findOne({
        where: { id: task.id, status: TaskStatus.ACTIVE },
      });
      if (!taskRecord) {
        this.logger.debug(`Task "${task.name}" is no longer active, skip`);
        this.schedulerMetrics.recordTriggerSkippedInactive();
        return null;
      }

      if (task.blockStrategy === BlockStrategy.DISCARD) {
        const running = await this.execRepo.findOne({
          where: { taskId: task.id, status: ExecutionStatus.RUNNING },
        });
        if (running) {
          this.logger.warn(
            `Task "${task.name}" is RUNNING (blockStrategy=DISCARD), skip trigger`,
          );
          this.schedulerMetrics.recordTriggerSkippedBlockStrategy();
          return null;
        }
      }

      if (task.blockStrategy === BlockStrategy.COVER_EARLY) {
        const running = await this.execRepo.findOne({
          where: { taskId: task.id, status: ExecutionStatus.RUNNING },
        });
        if (running) {
          this.logger.warn(
            `Task "${task.name}" is RUNNING (blockStrategy=COVER_EARLY), cancelling running execution ${running.id}`,
          );
          // R4-P1: the previous blind save() could overwrite a SUCCESS that
          // a concurrent callback had already committed (and double-release
          // the executor slot, oversubscribing capacity). Use the same
          // TASK-004 pattern as recoverStaleExecutions: a conditional UPDATE
          // guarded by the open-status gate, with RETURNING rows deciding
          // which slots to release.
          const result = await this.execRepo
            .createQueryBuilder()
            .update(TaskExecution)
            .set({
              status: ExecutionStatus.CANCELLED,
              errorMessage: "Task was covered by new trigger",
              endTime: new Date(),
            })
            .where('"id" = :id AND "status" IN (:...open)', {
              id: running.id,
              open: OPEN_EXECUTION_STATUSES,
            })
            .returning(["id", "executorAddress"])
            .execute();
          const coveredRows = (result.raw ?? []) as Array<{
            id: string;
            executorAddress: string | null;
          }>;
          if (coveredRows.length === 0 && result.affected) {
            // Driver reported the hit without RETURNING rows: fall back to
            // the snapshot address. Safe — affected=1 means this UPDATE made
            // the transition, so no concurrent callback released it already.
            coveredRows.push({
              id: running.id,
              executorAddress: running.executorAddress,
            });
          }
          if (coveredRows.length === 0) {
            this.logger.warn(
              `COVER_EARLY: execution ${running.id} already reached a terminal state (concurrent callback/kill), not covered`,
            );
          }
          for (const row of coveredRows) {
            await this.releaseExecutorSlot(row.executorAddress);
            this.logger.warn(
              `COVER_EARLY: execution ${row.id} cancelled by new trigger`,
            );
          }
        }
      }

      const exec = await this.execRepo.save(
        this.execRepo.create({
          taskId: task.id,
          taskName: task.name,
          status: ExecutionStatus.PENDING,
          params: task.params,
          triggerType,
          taskVersion: task.currentVersion,
        }),
      );

      const queueOptions = {
        attempts: Math.max(1, task.maxRetry ?? 1),
        backoff:
          task.retryDelay > 0
            ? {
                type: "exponential" as const,
                delay: task.retryDelay * 1000,
              }
            : undefined,
        // N2: DB 里 priority 是 PG 字符串枚举，TypeORM 读回 'normal' 等
        // label——原样传给 BullMQ 会被 lua 校验拒绝（"Priority should not
        // be float"），导致所有调度触发入队失败。入队边界强制归一化为数字。
        priority: normalizeTaskPriority(task.priority),
      };
      try {
        await this.queue.add(
          "execute",
          { executionId: exec.id, task },
          queueOptions,
        );
      } catch (err: unknown) {
        // P1: compensate the committed PENDING row so it cannot hang forever
        const message = err instanceof Error ? err.message : String(err);
        await this.execRepo.update(exec.id, {
          status: ExecutionStatus.FAILED,
          endTime: new Date(),
          errorMessage: `Failed to enqueue execution: ${message}`,
          failureReason: ExecutionFailureReason.UNKNOWN,
        });
        this.logger.error(`Failed to enqueue execution ${exec.id}: ${message}`);
        // R4-§5.5: 已创建 PENDING 行但入队失败（含补偿路径）计为触发失败
        this.schedulerMetrics.recordTriggerFailed();
        return null;
      }
      // P1: record the trigger time so checkMisfires() has data to work
      // with (this column was previously never written, leaving misfire
      // compensation dead code).
      await this.taskRepo.update(task.id, {
        lastTriggerTime: new Date(),
      });
      // R4-§5.5: 触发成功（claim 赢家且执行已入队）
      this.schedulerMetrics.recordTriggerClaimed();
      return exec;
    } finally {
      // P1: deliberately do NOT release the dedup lock — its TTL is the
      // dedup window across instances. Releasing it milliseconds after
      // acquisition made it useless against clock skew between instances.
    }
  }

  /**
   * TASK-006: DB 层原子触发 claim——Redis 触发锁不可用（抛错）时的兜底。
   * 条件 UPDATE：仅当任务仍为 ACTIVE 且上一触发窗口（与 Redis 锁 TTL 同窗）
   * 之外未被领取过时，本实例才能推进 lastTriggerTime 并获得触发权；
   * affected=0 表示另一实例（或旧 Leader 残余定时器）已领取，跳过本次触发。
   * 与 Redis 锁的"不释放、靠 TTL 去重"语义保持一致。
   */
  private async claimTaskTrigger(
    task: Task,
    lockTtlMs: number,
  ): Promise<boolean> {
    const windowStart = new Date(Date.now() - lockTtlMs);
    const result = await this.taskRepo
      .createQueryBuilder()
      .update(Task)
      .set({ lastTriggerTime: new Date() })
      .where(
        '"id" = :id AND "status" = :status AND ("lastTriggerTime" IS NULL OR "lastTriggerTime" < :windowStart)',
        {
          id: task.id,
          status: TaskStatus.ACTIVE,
          windowStart,
        },
      )
      .execute();
    return (result?.affected ?? 0) > 0;
  }

  /** Stop and remove all schedules for the given task */
  stop(taskId: string) {
    const timer = this.timers.get(taskId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(taskId);
    }

    const cronTask = this.cronTasks.get(taskId);
    if (cronTask) {
      cronTask.stop();
      this.cronTasks.delete(taskId);
    }

    this.runningTasks.delete(taskId);
  }

  /** Register scheduling for a single task; call after TaskService update to avoid waiting for the next reload */
  async scheduleOne(task: Task) {
    // TASK-003/TASK-006: 注册路径统一在 Leader 保护下执行。非 Leader 节点
    // 不注册定时器（改动由 Leader 的分钟级 reload 收编）；跨进程重复注册
    // 由 enqueue 的 Redis 锁 + DB claim 兜底。
    if (!this.isLeader) {
      this.logger.debug(
        `scheduleOne("${task.name}") skipped: not the scheduler leader`,
      );
      return;
    }
    if (this.schedulingTasks.has(task.id)) return;
    this.schedulingTasks.add(task.id);
    try {
      this.stop(task.id);

      if (task.triggerType === TaskTriggerType.FIXED_RATE && task.fixedRate) {
        const taskId = task.id;
        const timer = setInterval(async () => {
          // B-04: Prevent re-entry
          if (this.runningTasks.get(taskId)) {
            this.logger.warn(
              `Fixed_rate task "${task.name}" still running, skipping trigger`,
            );
            return;
          }
          this.runningTasks.set(taskId, true);
          try {
            const latest = await this.taskRepo.findOne({
              where: { id: taskId, status: TaskStatus.ACTIVE },
            });
            if (latest) await this.enqueue(latest, "fixed_rate");
          } finally {
            this.runningTasks.delete(taskId);
          }
        }, task.fixedRate * 1000);
        this.timers.set(task.id, timer);
        this.logger.log(
          `Re-scheduled fixed_rate task "${task.name}" every ${task.fixedRate}s`,
        );
      }

      if (task.triggerType === TaskTriggerType.CRON && task.cronExpression) {
        if (!nodeCron.validate(task.cronExpression)) {
          this.logger.warn(
            `Invalid cron expression for task "${task.name}": ${task.cronExpression}`,
          );
          return;
        }
        // N8: re-fetch task at trigger time to avoid stale closure snapshot
        const taskId = task.id;
        const cronTask = nodeCron.schedule(
          task.cronExpression,
          async () => {
            const latest = await this.taskRepo.findOne({
              where: { id: taskId, status: TaskStatus.ACTIVE },
            });
            if (latest) await this.enqueue(latest, "cron");
          },
          this.getCronOptions(task),
        );
        this.cronTasks.set(task.id, cronTask);
        this.logger.log(
          `Re-scheduled cron task "${task.name}" with expression: ${task.cronExpression}`,
        );
      }
    } finally {
      this.schedulingTasks.delete(task.id);
    }
  }

  /** Get scheduler runtime statistics */
  getStats() {
    return {
      healthy: true, // Scheduler is considered healthy if it's not crashed
      isLeader: this.isLeader,
      activeTimers: this.timers.size,
      activeCronTasks: this.cronTasks.size,
      runningTaskCount: this.runningTasks.size,
      totalScheduledTasks: this.timers.size + this.cronTasks.size,
      uptime: process.uptime(),
    };
  }

  /**
   * R4-§5.5: BullMQ 队列深度（waiting / active / delayed / failed / completed）。
   * getJobCounts 由 Redis 侧聚合，无需扫描队列；失败时返回 null 字段值，
   * 让调用方（metrics 端点）显式区分"Redis 不可用"与"队列为空"。
   */
  async getQueueDepth(): Promise<{
    waiting: number | null;
    active: number | null;
    delayed: number | null;
    failed: number | null;
    completed: number | null;
  }> {
    try {
      const counts = await this.queue.getJobCounts(
        "waiting",
        "active",
        "delayed",
        "failed",
        "completed",
      );
      return {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
        completed: counts.completed ?? 0,
      };
    } catch (err: unknown) {
      this.logger.debug(
        `Queue depth unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        waiting: null,
        active: null,
        delayed: null,
        failed: null,
        completed: null,
      };
    }
  }

  /** R4-§5.5: 调度可观测性快照（tick / trigger 计数 + 队列深度） */
  async getSchedulerMetrics(): Promise<{
    counters: SchedulerMetricsSnapshot;
    derived: SchedulerMetricsDerived;
    queue: Awaited<ReturnType<SchedulerService["getQueueDepth"]>>;
  }> {
    const [counters, queue] = await Promise.all([
      Promise.resolve(this.schedulerMetrics.snapshot),
      this.getQueueDepth(),
    ]);
    return {
      counters,
      derived: this.schedulerMetrics.derived,
      queue,
    };
  }
}
