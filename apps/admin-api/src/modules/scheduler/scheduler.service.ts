import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import {
  And,
  DataSource,
  Equal,
  In,
  LessThan,
  MoreThan,
  Repository,
} from "typeorm";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import * as nodeCron from "node-cron";
import {
  Task,
  TaskStatus,
  TaskTriggerType,
  MisfireStrategy,
  normalizeTaskPriority,
} from "../task/entities/task.entity";
import {
  findActiveMaintenanceWindow,
  lastWindowCronFireBefore,
  MAINTENANCE_WINDOW_LOOKBACK_MINUTES,
} from "../task/maintenance-window.util";
// B-6: misfire 补偿入队前的依赖闸（与 TaskService.checkDependencies 同一实现）
import { areDependenciesSatisfied } from "../task/dependency-gate.util";
// CORE-02: 重试退避抖动——±20% 摊开同周期失败任务的的重试时刻
import { jitteredRetryDelayMs } from "../task/retry-backoff.util";
// A4: DB 优先级(4=紧急) → BullMQ 出队优先级(1=最高)的方向换算——此前入队
// 直传 DB 原值，方向倒置（紧急任务反而最后出队）。
import { toBullPriority } from "../../common/utils/task-priority.util";
import {
  TaskExecution,
  ExecutionStatus,
  ExecutionFailureReason,
} from "../task/entities/task-execution.entity";
// A1: 终态跃迁（条件 UPDATE + RETURNING + 驱动兜底）与开放态常量的单一事实源。
import { transitionToTerminal } from "../task/execution-terminal";
// N-14：blockStrategy 闸门单一事实源（与 TaskService.trigger 共享）
import {
  applyBlockStrategyGate,
  releaseExecutorSlotByAddress,
} from "../task/block-strategy-gate";
// MUTEX-01：互斥组快照解析（执行入队时从 task→application 带下）。
import { resolveTaskMutexGroupId } from "../task/execution-mutex";
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
// OBS-01: 调度入队链路追踪（disabled 时全短路零开销）
import { TracingService } from "../../common/tracing/tracing.service";

/** TASK-006: Leader Election 锁 key（RedisLockService 会加 lock: 前缀） */
export const SCHEDULER_LEADER_LOCK_KEY = "scheduler:leader";
/**
 * Leader 锁 TTL；RedisLockService 内置 watchdog 以 TTL/3 周期续期。
 *
 * INCIDENT-2026-10-28（P1-3）：30s → 90s。10-28 11:59 的事件循环冻结实测
 * 28~40s，30s TTL 会被直接打穿（丢锁 → demote → 丢落点）。90s 覆盖该量级；
 * 10-26 那次 87s 卡顿仍在边缘，但 P0-1（demote 不再清定时器）已使"丢锁"
 * 不再等于"丢调度"，所以这里只需降低触发频率，不再承担正确性。
 */
export const SCHEDULER_LEADER_TTL_MS = 90_000;
/**
 * 非 Leader（跟随者）重试竞选间隔。
 *
 * INCIDENT-2026-10-28（P1-3）：15s → 3s。丢锁后越快拿回，调度真空越短。
 * 竞选尝试是单次 `SET NX`，3s 间隔的额外 Redis 压力可忽略。
 */
export const SCHEDULER_LEADER_RETRY_MS = 3_000;
/**
 * INCIDENT-2026-10-28（P1-3）：Leader 租约校验周期——**固定值，不随 TTL 缩放**。
 *
 * 此前校验周期 = `SCHEDULER_LEADER_TTL_MS / 2`，于是"TTL 越长，真故障时发现
 * 并切换得越慢"：TTL 提到 90s 会让校验变成 45s。解耦后校验恒为 15s。
 */
export const SCHEDULER_LEADER_VERIFY_MS = 15_000;
/**
 * INCIDENT-2026-10-28（P1-3）：连续 N 次 extendLock 失败才 demote。
 *
 * 单次失败可能只是 Redis 抖动/命令超时（`commandTimeout: 3000`）；此前一次
 * 失败即 demote，会让一次网络毛刺升级成调度中断。取 2 次（≥1 个校验周期）。
 *
 * 与 RedisLockService 的 `REDIS_LOCK_WATCHDOG_MAX_CONSECUTIVE_FAILURES = 3`
 * 区分：那个数的是**续期**失败，本常量数的是**归属校验**失败，两者独立。
 */
export const SCHEDULER_LEADER_VERIFY_MAX_FAILURES = 2;
/**
 * fail-open 降级期间（isLeader 但 leaderLock === null，Redis 不可用）的重试
 * 间隔：Redis 恢复后 5s 内补拿真实锁并收敛为单 Leader，把"多实例同时降级
 * 运行"的窗口压到最短。正确性本身由 DB 条件 claim 兜底（claimTaskTrigger /
 * transitionToTerminal），此项只压缩重复扫描开销的持续时长。
 */
export const SCHEDULER_LEADER_FAILOPEN_RETRY_MS = 5_000;

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
 * FIX-2.3: 短周期档上限（毫秒）。fixed_rate 周期 ≤ 此值时，「周期 - 抖动
 * 缓冲」的既有公式会被 MIN_TTL 下限抵消（TTL==周期，相位陷阱回归），改用
 * clamp(period×0.5, 200, 1000) 缩窗——详见 computeTriggerDedupTtlMs。
 */
export const TRIGGER_DEDUP_SHORT_PERIOD_MAX_MS = 1_500;

/**
 * F-3/F-6（调度域审计）：Node 定时器与 Redis PEXPIRE 的毫秒上限（2^31-1）。
 * setInterval/setTimeout 的 delay 经 int32 强转——超过 2^31-1 ms 的值会
 * **回绕成负数 = 立即触发**（1ms 定时器风暴）；Redis PEXPIRE 同样只接受
 * int4 毫秒。DTO 的 fixedRate 已用 @Max(2147483) 秒双重封顶（int4 列 +
 * 本上限，见 create-task.dto.ts 的 TASK_FIXED_RATE_MAX_SECONDS），这里是
 * 对**存量行**（封顶前写入）与未来其他调用方的纵深防御。
 */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * N5: stale 扫描的固定兜底窗口——timeout=0（不限时）任务的最短回收延迟。
 */
export const STALE_SCAN_FALLBACK_MS = 60 * 60 * 1000;

/** E-P1-R1/E-P2-R3: active-task keyset 分页页大小（按 id 升序推进）。 */
export const ACTIVE_TASK_PAGE_SIZE = 1000;

/**
 * F-1（HA 审计）：注册指纹对账周期——reload tick 每 N 轮做一次「DB 触发配置
 * vs 本地注册表」的指纹比对（N 可配 SCHEDULER_RECONCILE_EVERY，默认 5）。
 *
 * 背景：多实例部署下 task.service 的 update/pause/resume/rollback/维护窗口
 * 都是 stop+scheduleOne——LB 把写请求打到 follower 时 follower 只 stop 本地
 * （本就没有注册）且 scheduleOne 对非 Leader 早退，真正注册在 Leader 上的
 * 旧表达式定时器要等任务停用/重启用才能刷新。指纹对账让 Leader 在 N 轮内
 * 自愈：DB 侧表达式/周期/时区已改而本地注册仍是旧值的任务被逐个重排。
 */
export const SCHEDULER_RECONCILE_EVERY = 5;

/**
 * F-1: 任务触发配置的注册指纹（纯函数，便于单测）。
 *
 * 指纹 = `${triggerType}|${cron}|${fixedRate}|${timezone}`，cron/fixedRate
 * 仅在各自的 triggerType 下取值（与 scheduleOne 的注册分支同构——triggerType
 * 改变时指纹必然改变，即使 cron 字段残留旧值）；cron 与 timezone 做 trim
 * 归一（scheduleOne 的注册语义同样容忍首尾空白）。
 */
export function taskTriggerFingerprint(task: {
  triggerType: TaskTriggerType;
  cronExpression?: string | null;
  fixedRate?: number | null;
  timezone?: string | null;
}): string {
  const cron =
    task.triggerType === TaskTriggerType.CRON
      ? (task.cronExpression?.trim() ?? "")
      : "";
  const fixedRate =
    task.triggerType === TaskTriggerType.FIXED_RATE
      ? (task.fixedRate ?? "")
      : "";
  const timezone = task.timezone?.trim() || "";
  return `${task.triggerType}|${cron}|${fixedRate}|${timezone}`;
}

/**
 * B-4: 互斥唤醒 sweep 的分页参数。页大小沿用旧单页 take:200（行为兼容）；
 * 轮数上限是防极端情形死循环的安全阀（每 tick 至多唤醒 200×10 条，上限内
 * 未处理行交由下一 tick——10s 粒度的唤醒保证不变）。
 */
export const MUTEX_WAKE_PAGE_SIZE = 200;
export const MUTEX_WAKE_MAX_ROUNDS = 10;

/**
 * CONSISTENCY-02: 执行器活性探测的绝对兜底参数。当候选 stale 行所属执行器在线
 * 且心跳上报"仍在执行该 executionId"时，本轮跳过误判恢复；但该跳过不是无限的
 * ——一旦 stale 时长超过 max(6 × taskTimeout, ABSOLUTE_FLOOR_MS)，无视上报仍强制
 * 恢复，防止执行器 bug（谎报 running）导致行永久悬挂。timeout=0（无显式超时）
 * 或算得的绝对兜底短于该行 stale 阈值时，回退到 stale 阈值（保持既有回收行为，
 * 不因探测而放宽无限时任务的回收）。
 *
 * O-3（中台↔执行器深度审查）：绝对兜底 30min → 5min。旧值对短超时任务过宽：
 * 10s 超时的任务 6×timeout=60s，但绝对兜底仍压到 30min——一个谎报 running 的
 * 执行器 bug 会让该执行悬挂 30 分钟才被强制恢复。5min 仍远大于正常心跳/回调
 * 节奏（健康任务通常在 timeout 内回调），只收紧"谎报者"的收敛上界，不误伤
 * 真实长时任务（长任务由 6×timeout 主导）。
 */
export const STALE_LIVENESS_ABSOLUTE_FLOOR_MS = 5 * 60 * 1000; // 5 min（O-3）
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
 * R126-A1 补充：上面的"双保险"现为**强**关系——DB claim 是每条入队路径的唯一
 * 判决（不依赖 Redis 可用性），本 TTL 只决定"去重窗口多宽"，不再决定"谁说了
 * 算"。因此 cron 档的 1s 下限只挡"同一拍内的重放"，挡不住跨秒的重复源——那
 * 部分由 checkMisfiresBody 的补偿前复核 + claimTaskTrigger 的窗口裁决共同收口。
 * 导出仅供单元测试，视为模块内部函数。
 */
export function computeTriggerDedupTtlMs(task: Task): number {
  if (task.triggerType === TaskTriggerType.FIXED_RATE && task.fixedRate) {
    const periodMs = task.fixedRate * 1000;
    // FIX-2.3: 短周期档（≤1.5s）下「周期 - 抖动缓冲」会被 MIN_TTL=1000ms
    // 抵消，TTL 重新等于周期——tick→acquireLock 的相位滞后 δ>0 时下一 tick
    // 落入锁剩余窗口被 NX 拒绝，正是 N6 要消灭的跳周期（在 1s 档回归）。
    // 短周期档改为按周期比例缩窗：TTL = clamp(period×0.5, 200, 1000)，保证
    // TTL 严格小于周期（1s 档 → 500ms），下一 tick 前锁必已过期。窗口缩短
    // 不引入重复触发：定时器只注册在 Leader 上，同周期内本就只有一次 tick，
    // 去重锁只需覆盖「同一次 tick 的跨实例重放」（亚秒级），500ms 足够。
    if (periodMs <= TRIGGER_DEDUP_SHORT_PERIOD_MAX_MS) {
      // clamp(period×0.5, 200, 1000)：下限 200ms 保证极短周期仍有一个
      // 可用的跨实例去重窗口；上限 = MIN_TTL（1s）。
      return Math.min(
        Math.max(Math.floor(periodMs / 2), 200),
        TRIGGER_DEDUP_MIN_TTL_MS,
      );
    }
    // F-3/F-6 防御性 clamp：对超长 period（DTO @Max(2147483) 封顶前写入的
    // 存量行）返回的 TTL 可能超过 PEXPIRE 的 int4 上限——部分 Redis 客户端
    // 会静默取整/拒绝。DTO 封顶后本分支正常不可达越界值，这里钳到
    // MAX_TIMER_DELAY_MS（2^31-1 ms）兜底其他调用方。
    return Math.min(
      Math.max(
        periodMs - TRIGGER_DEDUP_JITTER_BUFFER_MS,
        TRIGGER_DEDUP_MIN_TTL_MS,
      ),
      MAX_TIMER_DELAY_MS,
    );
  }
  if (task.triggerType === TaskTriggerType.CRON) {
    return TRIGGER_DEDUP_MIN_TTL_MS;
  }
  return 5_000;
}

/**
 * B-1: cron 周期估算（毫秒）。复用 maintenance-window.util 的
 * lastWindowCronFireBefore（同一套 node-cron.validate 口径的解析器，时区
 * 语义与调度注册一致）：取 now 的最近一次触达与它的上一次触达，两者间隔
 * 即「期望触发周期」。解析失败 / 7 天回看内触达不足两次（周期超过 7 天的
 * cron）返回 null——调用方回退保守阈值。
 *
 * 结果按 (表达式|时区) 缓存并带 TTL：周期估算只服务于 misfire 阈值这一
 * 启发式（真闸是 B-1 的落点校验），10 分钟的陈旧窗口（跨 DST 时刻周期
 * 漂移一档）无正确性影响；无 TTL 的话进程生命周期内一次性缓存会让 DST
 * 前后的估算永久偏离。
 */
const CRON_PERIOD_ESTIMATE_TTL_MS = 10 * 60 * 1000;
const CRON_PERIOD_ESTIMATE_CACHE = new Map<
  string,
  { value: number | null; at: number }
>();
const CRON_PERIOD_ESTIMATE_CACHE_MAX = 512;

export function estimateCronPeriodMs(
  expr: string,
  timeZone?: string | null,
  now: Date = new Date(),
): number | null {
  const key = `${expr}|${timeZone ?? ""}`;
  const cached = CRON_PERIOD_ESTIMATE_CACHE.get(key);
  if (cached && Date.now() - cached.at < CRON_PERIOD_ESTIMATE_TTL_MS) {
    return cached.value;
  }
  const latest = lastWindowCronFireBefore(
    expr,
    now,
    MAINTENANCE_WINDOW_LOOKBACK_MINUTES,
    timeZone,
  );
  let value: number | null = null;
  if (latest) {
    const prev = lastWindowCronFireBefore(
      expr,
      // 严格早于 latest：回看窗口 7 天对周级 cron 足够（月级 cron 触达
      // 不足两次 → null → 调用方回退保守阈值，方向安全）。
      new Date(latest.getTime() - 1),
      MAINTENANCE_WINDOW_LOOKBACK_MINUTES,
      timeZone,
    );
    if (prev) value = latest.getTime() - prev.getTime();
  }
  if (CRON_PERIOD_ESTIMATE_CACHE.size >= CRON_PERIOD_ESTIMATE_CACHE_MAX) {
    CRON_PERIOD_ESTIMATE_CACHE.clear();
  }
  CRON_PERIOD_ESTIMATE_CACHE.set(key, { value, at: Date.now() });
  return value;
}

/**
 * B-1: misfire 判定阈值 = 2 × 任务的真实触发周期。
 *
 * 旧实现对 cron 任务恒用 2min（只有 fixed_rate 用 2×fixedRate）——周期
 * 大于 7min 的 cron（小时/日级）在健康状态下 gap 几乎恒超 2min，每轮
 * 5 分钟级 checkMisfires 都误判 misfire：FIRE_ONCE 任务被 enqueue(task,
 * "misfire") 在计划时刻外补偿入队（cron 去重锁 TTL 仅 1s 挡不住），任务
 * 退化为高频触发；IGNORE 任务则每轮刷 warn。现在 cron 任务按其表达式的
 * 真实周期推导阈值（周期估算见 estimateCronPeriodMs；解析失败回退旧的
 * 2min 保守值）；fixed_rate 维持 2×fixedRate 既有语义。
 * 导出仅供单元测试，视为模块内部函数。
 */
export function computeMisfireThresholdMs(task: Task): number {
  if (task.triggerType === TaskTriggerType.FIXED_RATE) {
    return (task.fixedRate || 60) * 2000;
  }
  if (
    task.triggerType === TaskTriggerType.CRON &&
    task.cronExpression?.trim()
  ) {
    const periodMs = estimateCronPeriodMs(
      task.cronExpression.trim(),
      task.timezone?.trim() || undefined,
    );
    if (periodMs != null && Number.isFinite(periodMs) && periodMs > 0) {
      return 2 * periodMs;
    }
  }
  return 2 * 60 * 1000;
}

/**
 * INCIDENT-2026-10-28（P0-3）：node-cron 的漏跑容错窗口。
 *
 * 引擎默认 1000ms：定时器迟醒 ≤1s 仍执行该落点，超出记 missed。生产上事件
 * 循环被钉住 28~40s，1s 窗口形同虚设——落点被静默丢弃，且引擎的 warn 走的是
 * node-cron 内部 logger，不进我们的结构化日志。
 *
 * 取值 min(30s, period/2)：
 *  - 上限 30s：覆盖本次实测的 28s 冻结，并与 event-loop lag 告警阈值对齐
 *    （>1s 即告警，>30s 即确认丢拍）。再长会让"确实该丢的落点"被延迟执行，
 *    与下一次落点挤在一起。
 *  - 下限 period/2 是**保守选择，不是引擎的硬性要求**：planBeat 的判定是
 *    `lateBy <= toleranceMs && lateBy < gap`，其中 `lateBy < gap`（gap = 到
 *    下一落点的间隔）已经保证了容错窗口不会越过后一个落点。取 period/2 的
 *    理由是语义上的克制：容错窗口不应超过半个周期。
 *  - 最小 1s：与引擎默认值对齐，避免把容错关掉。
 *
 * 导出仅供单元测试，视为模块内部函数。
 */
export function computeMissedToleranceMs(task: Task): number {
  const periodMs =
    task.triggerType === TaskTriggerType.CRON && task.cronExpression?.trim()
      ? estimateCronPeriodMs(
          task.cronExpression.trim(),
          task.timezone?.trim() || undefined,
        )
      : task.triggerType === TaskTriggerType.FIXED_RATE
        ? (task.fixedRate || 60) * 1000
        : null;
  const cap =
    periodMs != null && Number.isFinite(periodMs) && periodMs > 0
      ? Math.min(30_000, Math.floor(periodMs / 2))
      : 30_000;
  return Math.max(1_000, cap);
}

/**
 * 终态保护门（TASK-004 / R4-P1）：所有把执行推进到终态的写路径都只允许命中
 * 仍处于打开状态（pending/running）的行——并发回调已写入的终态绝不被覆盖。
 *
 * A1: 常量已收口到 `../task/execution-terminal` 的 `OPEN_EXECUTION_STATUSES`
 * （此前 task.service 两处各写一份字面量，加状态必漏改）。如需在本文件内引用，
 * 请从那里 import，勿在此重复定义。
 */

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

  /**
   * R126-A1: 扫描型 tick 的在飞登记表（重入闸）。@nestjs/schedule 的 cron 回调
   * 不 await 返回值，扫描体超周期时下一拍会并发进入——见 guardTick。
   */
  private readonly inFlightTicks = new Set<string>();
  // F-1: 本地注册指纹表——scheduleOne 注册时记录该次注册所依据的触发配置
  // 指纹，reload 的对账轮把它与 DB 侧指纹比对，漂移者重排。stop 时同步删除
  // （与 timers/cronTasks 的清理语义一致，防 inactive 任务残留泄漏）。
  private registeredFingerprints = new Map<string, string>();
  // F-1: reload tick 计数（仅 Leader 走到 reloadActiveTasks，故只在 Leader 侧推进）
  private reloadTickCount = 0;

  // TASK-006: Leader Election 状态
  private leaderLock: Lock | null = null;
  private isLeader = false;
  private leaderRetryTimer: NodeJS.Timeout | null = null;
  private leaderVerifyTimer: NodeJS.Timeout | null = null;
  /**
   * INCIDENT-2026-10-28（P1-3）：连续归属校验失败计数。
   * 成功即清零；达 `SCHEDULER_LEADER_VERIFY_MAX_FAILURES` 才 demote。
   */
  private leaderVerifyFailures = 0;

  /**
   * INCIDENT-2026-10-28 §2.5：调度代际号，每次 demote 递增。
   *
   * 用途：让"卡在旧回调里、demote 之后才恢复"的触发识别出自己属于上一代，
   * 从而放弃入队——否则 demote 里 runningTasks.clear() 会让它在恢复后补一次
   * enqueue，与 demote 后的新落点叠加成重复执行（且那一行可能已被 stale
   * sweep 判为 NEVER_DISPATCHED，因为 worker 的 claimable 含 FAILED）。
   *
   * 为什么用代际号而不是"检查 isLeader"：isLeader 在 demote 后可能因重新
   * 竞选而变回 true，届时旧回调会误判为"我是现任"；代际号单调递增则不会。
   *
   * 已知覆盖边界：本检查点在 enqueue() **之前**，因此挡不住"已进入 enqueue、
   * 卡在 queue.add() 内部"的情形（见 §2.5.5 残余风险与 §11.3 的收敛方案）。
   */
  private runGeneration = 0;

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
    // OBS-01: 调度入队 span（@Global 恒提供；disabled 时全短路）。
    // @Optional 仅为既有单测装配兼容（provider 缺失 → null → no-op）。
    @Optional()
    private tracing: TracingService | null,
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
    // boot 容错（第四轮 CI 教训）：api-types-drift 等「空库起 AppModule」的
    // 场景（无迁移、无表）里，这三个启动步骤都会因表不存在而抛错并炸掉整个
    // boot；生产里 DB/Redis 瞬时抖动同理。调度器的契约是「不因依赖故障而
    // 整体停摆」（见上方注释）——启动步骤失败只 warn，等 cron tick 下一轮
    // reload/补偿自然收敛。DB 正常时行为完全不变。
    await this.initLeaderElection();
    const bootSteps: Array<[string, () => Promise<void>]> = [
      ["reload", () => this.reload()],
      ["checkMisfires", () => this.checkMisfires()],
      ["recoverStaleExecutions", () => this.recoverStaleExecutions()],
    ];
    for (const [name, run] of bootSteps) {
      try {
        await run();
      } catch (err: unknown) {
        this.logger.warn(
          `scheduler boot step "${name}" failed (will retry on next tick): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
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
          // NETOPT-3③: checkMisfires 此前只在 onModuleInit 跑一次——多实例
          // 部署下 Leader failover 后，新 Leader 永远不会再做 misfire 补偿，
          // FIRE_ONCE 策略的错失触发就此静默丢失。晋升瞬间补跑一轮（此时
          // isLeader 已置位，门禁通过）；fire-and-forget，不阻塞竞选路径，
          // 失败仅记日志——FIX-2.2 起本方法挂了 5 分钟级 @Cron，本轮失败由
          // 下一轮周期 tick 覆盖，不再是「仅此一次」的孤注。
          void this.checkMisfires().catch((err: unknown) => {
            this.logger.warn(
              `Post-promotion misfire check failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
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
    this.leaderVerifyFailures = 0;
    this.leaderVerifyTimer = setInterval(() => {
      void this.verifyLeadership();
    }, SCHEDULER_LEADER_VERIFY_MS);
    this.leaderVerifyTimer.unref();
  }

  /**
   * 用 extendLock 探测 Leader 租约是否仍归本实例（同一 lockId 才会续期成功）。
   *
   * Redis 抖动时保留租约（RedisLockService 内部 watchdog 会继续续期），下一个
   * 校验周期再判定，避免单次网络抖动造成无谓的 Leader 切换。
   *
   * INCIDENT-2026-10-28（P1-3）：连续 `SCHEDULER_LEADER_VERIFY_MAX_FAILURES`
   * 次归属校验失败才 demote。此前一次 `false` 即 demote——而 extendLock 返回
   * false 只说明"此刻锁不归我"，可能是一次命令超时后被误判，也可能是锁刚
   * 被 watchdog 续上。多观察一拍能挡掉绝大多数毛刺。
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
      if (ok) {
        this.leaderVerifyFailures = 0;
        return;
      }
      this.leaderVerifyFailures += 1;
      if (this.leaderVerifyFailures >= SCHEDULER_LEADER_VERIFY_MAX_FAILURES) {
        this.logger.warn(
          `Leader lease check failed ${this.leaderVerifyFailures} consecutive ` +
            `time(s) — demoting`,
        );
        this.demote("leader lease expired");
      } else {
        this.logger.warn(
          `Leader lease check failed once (${this.leaderVerifyFailures}/` +
            `${SCHEDULER_LEADER_VERIFY_MAX_FAILURES}) — keeping leadership, ` +
            `will re-check in ${SCHEDULER_LEADER_VERIFY_MS}ms`,
        );
      }
    } catch (err: unknown) {
      // 异常路径沿用既有语义：不据此 demote（RedisLockService 的 watchdog
      // 仍在续期），仅记 debug——连不上时没有可靠信息可判断归属。
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
    // fail-open 降级期间（isLeader 但无真实锁）用短间隔快速重试竞选：Redis
    // 恢复后尽快收敛为单 Leader，缩短多实例同时降级运行的窗口（正确性由
    // DB 条件 claim 兜底，此项只压缩重复扫描开销的持续时长）。
    const delayMs =
      this.isLeader && !this.leaderLock
        ? SCHEDULER_LEADER_FAILOPEN_RETRY_MS
        : SCHEDULER_LEADER_RETRY_MS;
    this.leaderRetryTimer = setTimeout(() => {
      this.leaderRetryTimer = null;
      // 降级 Leader 也周期性重试：Redis 恢复后补拿真实锁，或让位于新 Leader
      void this.tryAcquireLeadership();
    }, delayMs);
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
    // INCIDENT-2026-10-28（P0-1）：**不再清空定时器**。
    //
    // 旧实现无条件 stop() 掉全部 timers/cronTasks，代价是丢失整个调度落点：
    // 10-28 11:59 进程冻结 28s 打穿 30s 租约 → demote 清掉 56 个 cron 定时器
    // → 12:00:00.000 那拍 reload 因 isLeader=false 早退 → 12:01 才重建，而
    // node-cron 从"注册时刻"起算 getNextMatch → 12:00 永久跳过。
    //
    // 现在保留定时器：存活期间照常 fire，跨实例/跨 Leader 的重复派发由
    // enqueue() → claimTaskTrigger() 的 DB 条件 UPDATE 判决（ADR-002：DB claim
    // 是判决，Redis 锁只是快筛）。这正是 fail-open 路径早已采用的语义。
    //
    // ⚠️ 不要在 fire 回调里加 `isLeader` 门禁：事故中 isLeader 到 12:00:00.91
    // 才恢复，加门禁等于复现事故。
    //
    // ⚠️ 必须同步清 runningTasks：旧实现靠 stop() 顺带清它（stop 内部有
    // runningTasks.delete），不再调 stop() 后这个 Map 失去唯一的整表清理点。
    // 而 cron 回调的重入闸是 `if (runningTasks.get(id)) return`——一旦某任务在
    // demote 瞬间卡在 set(true) 与 delete 之间，会被**永久**判为"仍在运行"，
    // 此后每次落点都静默跳过。
    //
    // 为什么是 clear() 而不是逐个 delete：demote 语义是"本节点放弃 Leader
    // 身份"，此刻**所有**在飞标记都不再可信（既无法确认对应回调还在跑，也无法
    // 确认它何时结束）；逐个删需要知道哪些是"真在跑"，而我们恰恰不知道。
    // 代价是可能放过一次并发，由 DB claim 兜底，与 P0-1 整体取舍一致。
    //
    // runGeneration 递增：让"卡在旧回调里、demote 之后才恢复"的触发识别出
    // 自己属于上一代并放弃入队（见 scheduleOne 的 cron/fixed_rate 回调）。
    this.runGeneration += 1;
    this.runningTasks.clear();
    this.logger.warn(
      `Scheduler leadership lost (${reason}) — local schedules KEPT (dedup falls ` +
        `back to the DB claim), will re-contend later`,
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

  /**
   * B-1（双保险第二道）：cron 任务错失的调度点是否确实落在
   * (lastTriggerTime, now] 内。
   *
   * 背景：misfire 补偿此前只看 gap 超阈——lastTriggerTime 可能被依赖扇出
   * claim（TaskService.claimDependencyTrigger 复用同列）等**计划外**触发
   * 推进，补偿入队发生在任意时刻而非 cron 的计划触达点。现在补偿前用
   * lastWindowCronFireBefore 反查「now 之前最近一次计划触达」：该触达晚于
   * lastTriggerTime 才是真错失（lastTriggerTime 未跟上计划进度）；反查
   * 不到（表达式非法 / 触达超出 7 天回看）按「无法确认错失」处理——宁可
   * 少补一次（下轮 tick 自然重查），不在计划外入队。扫描本身被 B-1 阈值
   * 推导前置过滤（gap ≤ 2×周期不会走到这里），且回扫在最近触达处即停
   * （分钟级 cron ≤ 几十步），开销可忽略。
   */
  private cronHasMissedFirePoint(
    task: Task,
    lastTriggerTime: Date,
    now: Date,
  ): boolean {
    const expr = task.cronExpression?.trim();
    if (!expr) return false; // 无法判定 → 不补偿（scheduleOne 对缺表达式任务本就拒绝注册）
    const lastFire = lastWindowCronFireBefore(
      expr,
      now,
      MAINTENANCE_WINDOW_LOOKBACK_MINUTES,
      task.timezone?.trim() || undefined,
    );
    return lastFire != null && lastFire.getTime() > lastTriggerTime.getTime();
  }

  /**
   * Detect misfires on startup and compensate according to policy.
   *
   * FIX-2.2：此前本方法**只在启动与 Leader 晋升时**被调用（无 @Cron 装饰器，
   * 旧注释声称的「下一轮 cron tick 会再覆盖」并不存在）——运行期一次补偿失败
   * 即成孤注，FIRE_ONCE 的错失触发要等下次 failover 才有第二次机会。现挂
   * 5 分钟级 @Cron 作为运行期兜底：扫描本身是 status 索引上的 keyset 分页读 +
   * lastTriggerTime 内存判定，无写放大；真正的补偿入队仍受 enqueue 内
   * 维护窗口/去重锁/DB claim/blockStrategy 全套闸门约束，且 Redis 锁
   * `task:trigger:*`（TTL=触发周期）保证周期内至多一次触发——Leader 短暂
   * 双活或 tick 与晋升钩子重叠时重复扫描是安全的（重复补偿会被去重吸收），
   * 幂等成立。
   *
   * B-1/B-6（调度域审计）：判定链升级为「gap 超阈（阈值=2×真实周期）→
   * cron 落点校验 → 依赖闸 → FIRE_ONCE 补偿」，见各函数注释。
   */
  @Cron("0 */5 * * * *")
  async checkMisfires() {
    // TASK-006: 扫描型 tick 仅 Leader 执行
    if (!this.isLeader) {
      this.logger.debug("checkMisfires skipped: not the scheduler leader");
      return;
    }
    // CRON-GUARD：顶层异常闸门——DB 抖动不得升级为未处理 rejection（进程退出）。
    await this.guardTick("checkMisfires", () => this.checkMisfiresBody());
  }

  /**
   * INCIDENT-2026-10-28（P1-1）：计划的 cron 落点是否被静默丢弃 —— **只告警，
   * 不补偿**。
   *
   * ## 与 checkMisfires 的分工
   *
   * `checkMisfires` 的判据是"距上次触发超过 2×周期"，对多点 cron 的语义是错的：
   * `0 8,12,17 * * *` 的"最近两落点间隔"会随当前时刻漂移（09:00 时算出 15h、
   * 12:30 时算出 4h），于是 12:00 真丢点静默（只隔 4h）、而每晚 03:00~08:00
   * 误报 59 条。生产实测 2.4 天 12,342 条告警，真问题被完全淹没。
   *
   * 本方法改用**落点存在性**作判据（`lastWindowCronFireBefore` 反查"最近一个
   * 计划落点"），与时刻无关：最近落点已过 grace 却晚于 lastTriggerTime →
   * 确实漏了。这条判据与周期形状无关，对 `0 8,12,17` 这类多点表达式同样成立。
   *
   * ## 为什么不做补偿
   *
   * 业务侧 2026-10-28 已明确：默认只告警、不自动补跑。汇总任务是日报，补跑会
   * 造成数据时序错乱；且单次运行 1.8~44 分钟，可能与下一批撞车。详见事故方案
   * 文档 §10。补偿仅对显式 opt-in（`misfireStrategy=fire_once`）的任务生效，
   * 那条路径由 `checkMisfires` 负责。
   *
   * ## 排除项
   *
   * 维护窗口内的落点不算漏跑——窗口本就要抑制触发，否则每个窗口都告警。
   */
  @Cron("0 */5 * * * *")
  async auditMissedFirePoints() {
    if (!this.isLeader) {
      this.logger.debug(
        "auditMissedFirePoints skipped: not the scheduler leader",
      );
      return;
    }
    await this.guardTick("auditMissedFirePoints", () =>
      this.auditMissedFirePointsBody(),
    );
  }

  /** auditMissedFirePoints 的扫描体（异常由 guardTick 统一兜住）。 */
  private async auditMissedFirePointsBody(): Promise<void> {
    const now = new Date();
    // grace：给事件循环抖动/入队延迟留余量。取 90s——大于 30s 的
    // missedExecutionTolerance，确保"引擎还能补跑"的落点不被提前告警。
    const GRACE_MS = 90_000;
    let idCursor = "";
    for (;;) {
      const where: Record<string, unknown> = {
        status: TaskStatus.ACTIVE,
        triggerType: TaskTriggerType.CRON,
      };
      if (idCursor) where.id = MoreThan(idCursor);
      const tasks = await this.taskRepo.find({
        where,
        order: { id: "ASC" },
        take: ACTIVE_TASK_PAGE_SIZE,
      });
      if (tasks.length === 0) break;
      for (const task of tasks) {
        if (!task.lastTriggerTime) continue;
        const expr = task.cronExpression?.trim();
        if (!expr) continue;

        const lastFire = lastWindowCronFireBefore(
          expr,
          now,
          MAINTENANCE_WINDOW_LOOKBACK_MINUTES,
          task.timezone?.trim() || undefined,
        );
        // 反查不到（表达式非法 / 超出回看窗口）→ 无法判定，不告警
        if (!lastFire) continue;
        // 落点还没到 grace，或该落点之前已经触发过 → 正常
        if (now.getTime() - lastFire.getTime() < GRACE_MS) continue;
        if (lastFire.getTime() <= task.lastTriggerTime.getTime()) continue;
        // 维护窗口内的落点是被有意抑制的，不算漏跑
        if (
          findActiveMaintenanceWindow(
            task.maintenanceWindows,
            lastFire,
            task.timezone?.trim() || undefined,
          )
        ) {
          continue;
        }

        const lateMs = now.getTime() - lastFire.getTime();
        this.logger.warn(
          `Scheduled fire point MISSED for "${task.name}" at ` +
            `${lastFire.toISOString()} (expression=${expr}, ` +
            `late by ${Math.round(lateMs / 1000)}s, ` +
            `lastTriggerTime=${task.lastTriggerTime.toISOString()}) — ` +
            `no compensation will be attempted (strategy=ignore by default)`,
        );
        this.schedulerMetrics.recordCronSlotMissed();
      }
      if (tasks.length < ACTIVE_TASK_PAGE_SIZE) break;
      idCursor = tasks[tasks.length - 1].id;
    }
  }

  /** checkMisfires 的扫描体（异常由 guardTick 统一兜住）。 */
  private async checkMisfiresBody(): Promise<void> {
    const now = Date.now();
    // P2-8：先收集命中 FIRE_ONCE 补偿的任务，再 Promise.allSettled 并发入队。
    // 每任务使用独立 Redis 锁 key / DB claim（互不依赖），并发安全；单个任务
    // 入队失败不再中断其余任务的补偿（原串行循环中 enqueue 抛错会中断整轮）。
    const misfired: Task[] = [];
    // E-P2-R3: 旧 take:10000 截断——active 超万级时 misfire 补偿漏行。改 id
    // keyset 分页循环覆盖全部 active 任务（不截断），每页有界、主键范围扫描。
    let idCursor = "";
    for (;;) {
      // 空串游标绝不能拼 `id > ''`（uuid 列 PG 报错）
      const where: Record<string, unknown> = { status: TaskStatus.ACTIVE };
      if (idCursor) where.id = MoreThan(idCursor);
      const tasks = await this.taskRepo.find({
        where,
        order: { id: "ASC" },
        take: ACTIVE_TASK_PAGE_SIZE,
      });
      if (tasks.length === 0) break;
      for (const task of tasks) {
        if (!task.lastTriggerTime) continue;
        // INCIDENT-2026-10-28（P2-2）：manual/api/webhook 任务**没有"计划落点"**，
        // computeMisfireThresholdMs 对它们恒返回 2min（非 cron/fixed_rate 分支），
        // 于是只要 2 分钟没跑就被判一次 misfire。实测 2.4 天产生 12,342 条告警
        // （单任务最高 570 条），真丢点被完全淹没——值班视角下这批任务等于静音。
        // 只对真正有周期语义的触发类型做判定。
        if (
          task.triggerType !== TaskTriggerType.CRON &&
          task.triggerType !== TaskTriggerType.FIXED_RATE
        ) {
          continue;
        }
        const gap = now - task.lastTriggerTime.getTime();
        // B-1: 阈值按任务真实触发周期推导（cron 不再恒用 2min，长周期
        // cron 不再被每轮 tick 误判；见 computeMisfireThresholdMs）。
        const threshold = computeMisfireThresholdMs(task);
        if (gap > threshold) {
          if (task.misfireStrategy === MisfireStrategy.FIRE_ONCE) {
            // R126-A1：上面判 gap 用的 lastTriggerTime 是本轮**分页扫描开始时的
            // 快照**，而补偿入队发生在扫描末尾的 Promise.allSettled——万级 active
            // 表上「读快照 → 入队」的滞后远超 cron 的去重窗口（computeTriggerDedupTtlMs
            // 对 cron 恒为 TRIGGER_DEDUP_MIN_TTL_MS = 1s，与真实周期解耦）。
            // 这期间定时器完全可能已经按点正常触发过，于是同一个落点被
            // 「正常触发 + 补偿」各执行一次，去重锁早已过期挡不住。
            // 处置：补偿是**不可撤销的副作用**，兑现前必须按主键复核一次真实
            // 状态（单行读，毫秒级，远小于 1s 去重窗口）——陈旧快照不得直接兑现。
            const fresh = await this.taskRepo.findOne({
              where: { id: task.id },
              select: { id: true, lastTriggerTime: true },
            });
            const anchor = fresh?.lastTriggerTime ?? task.lastTriggerTime;
            if (now - anchor.getTime() <= threshold) {
              this.logger.debug(
                `Misfire for "${task.name}" was already covered by a trigger at ` +
                  `${anchor.toISOString()} (scan snapshot was stale) — not compensating`,
              );
              continue;
            }
            // B-1 落点校验：错失的计划触达点必须确实落在
            // (lastTriggerTime, now] 内，才允许在计划外补偿入队。
            if (
              task.triggerType === TaskTriggerType.CRON &&
              !this.cronHasMissedFirePoint(task, anchor, new Date(now))
            ) {
              this.logger.debug(
                `Misfire window for "${task.name}" contains no scheduled cron fire point — not compensating`,
              );
              continue;
            }
            // B-6: 依赖任务补偿前补依赖闸——补偿路径经 enqueue 直接入队，
            // 绕过 TaskService.trigger 的 checkDependencies；依赖未满足时
            // （如上游刚失败）绝不强行触发。计入 skipped 指标 + debug 日志
            // （不刷 warn 告警：依赖未满足是预期态，下轮 tick 再查）。
            if (
              task.dependencies &&
              Object.keys(task.dependencies).length > 0
            ) {
              const satisfied = await areDependenciesSatisfied(
                this.execRepo,
                task.dependencies,
              );
              if (!satisfied) {
                this.logger.debug(
                  `Misfire compensation for "${task.name}" skipped: dependencies not satisfied`,
                );
                this.schedulerMetrics.recordMisfireSkippedDependencies();
                continue;
              }
            }
            this.logger.warn(
              `Misfire detected for "${task.name}", firing once`,
            );
            misfired.push(task);
          } else {
            this.logger.warn(
              `Misfire detected for "${task.name}", strategy=IGNORE`,
            );
          }
        }
      }
      if (tasks.length < ACTIVE_TASK_PAGE_SIZE) break;
      idCursor = tasks[tasks.length - 1].id;
    }
    if (misfired.length > 0) {
      await Promise.allSettled(
        misfired.map((task) => this.enqueue(task, "misfire")),
      );
    }
  }

  /**
   * REC-01: Periodically find executions stuck in RUNNING (e.g. from a crash)
   * and mark them FAILED so the UI never shows permanently-running tasks.
   * Runs on startup and every 2 minutes thereafter.
   *
   * 频率说明（原 10 分钟）：staleScanWindowMs() 已按活跃任务中最短超时动态
   * 计算扫描窗口（短超时任务如 10s 的僵尸行在窗口内即被捞出），find() 带
   * startTime 过滤，扫描本身是轻量索引查询；2 分钟粒度把"短超时任务的僵尸
   * 行最多等 10 分钟"压缩到最多 2 分钟，DB 压力增加可忽略。
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
  @Cron("0 */2 * * * *")
  async recoverStaleExecutions() {
    // TASK-006: 扫描型 tick 仅 Leader 执行
    if (!this.isLeader) {
      this.logger.debug(
        "recoverStaleExecutions skipped: not the scheduler leader",
      );
      return;
    }
    // CRON-GUARD：顶层异常闸门——DB 抖动不得升级为未处理 rejection（进程退出）。
    await this.guardTick("recoverStaleExecutions", () =>
      this.recoverStaleExecutionsBody(),
    );
  }

  /** recoverStaleExecutions 的扫描体（异常由 guardTick 统一兜住）。 */
  private async recoverStaleExecutionsBody(): Promise<void> {
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
    // NETOPT-D P3-5: take 提到与 E9 maxConcurrentTasks(≤10000) 同一档位并加
    // order 保证确定性——单执行器 10000 并发时旧 take:1000 每 10 分钟只恢复
    // 前 1000 行，第 1001+ 行滞留 RUNNING 直到后续 tick（恢复吞吐 < 故障规模
    // 时永不自收敛）。分页循环：每页 1000、总量封顶 20000 防极端膨胀目录一次
    // 物化过多；O-2 的"下一 tick 自收敛"承诺在单 tick 取全量后依然成立
    // （恢复行离开 RUNNING 谓词，循环条件自然收敛）。
    const STALE_SWEEP_PAGE = 1000;
    const STALE_SWEEP_MAX = 20_000;
    const runningExecs: TaskExecution[] = [];
    // F-2（调度域审计）: 旧实现 order {startTime,id} + skip 翻页仍是 offset
    // 分页——本 sweep 自己把恢复行移出 RUNNING 谓词（并发回调/恢复竞态同理），
    // 谓词命中集一变，skip 便会跳过尚未扫描的行（offset 分页经典漏扫）。改
    // (startTime,id) keyset 游标（范式先例：同文件 wakeMutexQueuedExecutions）
    // ——游标推进到本页最后一行，与行状态翻转无关，翻多少页都不漏行。
    let staleCursor: { startTime: Date; id: string } | null = null;
    while (runningExecs.length < STALE_SWEEP_MAX) {
      const baseWhere = {
        status: ExecutionStatus.RUNNING,
        startTime: LessThan(initialCutoff),
      };
      // 游标条件 `(startTime,id) > (cursor.startTime, cursor.id)`（字典序）
      // 在 find 的 OR 数组形态下展开为两个分支：startTime 更晚，或 startTime
      // 相等且 id 更大。被恢复行离开谓词不影响游标推进。
      const page = await this.execRepo.find({
        where: staleCursor
          ? [
              {
                ...baseWhere,
                startTime: And(
                  LessThan(initialCutoff),
                  MoreThan(staleCursor.startTime),
                ),
              },
              {
                status: ExecutionStatus.RUNNING,
                startTime: Equal(staleCursor.startTime),
                id: MoreThan(staleCursor.id),
              },
            ]
          : baseWhere,
        order: { startTime: "ASC", id: "ASC" },
        take: STALE_SWEEP_PAGE,
      });
      if (page.length === 0) break;
      runningExecs.push(...page);
      // 游标推进到本页最后一行（其 startTime 由 where 谓词保证非空；防御性
      // 回落 createdAt——只影响不可能经本扫描出现的 NULL startTime 行）。
      const lastRow = page[page.length - 1];
      staleCursor = {
        startTime: lastRow.startTime ?? lastRow.createdAt,
        id: lastRow.id,
      };
      if (page.length < STALE_SWEEP_PAGE) break;
    }

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

    const finishedAt = new Date();
    // A1: 终态跃迁统一走 transitionToTerminal——竞态中已被回调写成终态的行
    // 不会出现在受影响集合里，executor 槽位只对确实被恢复的行释放。相比此前
    // 的手写 UPDATE，额外获得「驱动未返回 RETURNING 行」的快照兜底（旧实现
    // 直接读 result.raw，该场景会静默漏释放槽位）。
    const recoveredRows: Array<{
      id: string;
      executorAddress: string | null;
    }> = [];

    if (timedOut.size > 0 || recovered.length > 0) {
      // 单事务：部分失败整体回滚，恢复动作要么全部生效要么全部不变
      await this.dataSource.transaction(async (manager) => {
        const runUpdate = async (
          execs: TaskExecution[],
          patch: Record<string, unknown> & { status: ExecutionStatus },
        ): Promise<void> => {
          if (execs.length === 0) return;
          const { rows } = await transitionToTerminal(this.execRepo, {
            ids: execs.map((e) => e.id),
            patch,
            // 槽位释放类调用：必须给快照，供「命中但驱动未返回行」时兜底。
            addressSnapshot: new Map(
              execs.map((e) => [e.id, e.executorAddress ?? null]),
            ),
            manager,
          });
          recoveredRows.push(...rows);
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
      // 含该 execution"被 defer 到绝对兜底（5min，O-3 从 30min 收紧）之后才会进入本恢复路径，
      // 上报已不可信（谎报/僵死），与其余行同等对待——kill 通知尽力而为，
      // 预算未耗尽则重试。取舍：极端情况下可能与仍在运行的原进程并行一次，
      // 由 kill 通知兜底；相比"静默丢重试"，这是更安全的失败方向。
      const retryOnRecovery = this.staleRecoveryRetryEnabled();
      // R-15（DEEP_REVIEW 0ef3bbe）: 此前对每个失联执行器串行 await kill HTTP
      // （3s 超时/行），大规模宕机（如 100 执行器）一轮恢复最多 300s（5 分钟）
      // 阻塞 cron tick。改为：先并发释放全部槽位，再按并发上限分批处理
      // kill→retry（同一行 kill 必须先于 retry，但跨行互不依赖可并发）。
      // notifyExecutorKill 内部已 catch 所有异常仅 warn，故 Promise.allSettled
      // 不会因单执行器失败而中断整批。
      const STALE_RECOVERY_KILL_CONCURRENCY = 10;

      // 1) 并发释放全部槽位（DB 快操作，无 HTTP）
      await Promise.allSettled(
        recoveredRows.map((row) =>
          this.releaseExecutorSlot(row.executorAddress),
        ),
      );
      for (const row of recoveredRows) {
        this.logger.warn(`REC-01: execution ${row.id} recovered as FAILED`);
      }

      if (!retryOnRecovery) return;

      // 2) 收集需要重试的行（预算检查在内存中完成，无 I/O）
      const retryables: Array<{
        id: string;
        exec: TaskExecution;
        task: Task;
      }> = [];
      for (const row of recoveredRows) {
        const exec = execById.get(row.id);
        const task = exec ? taskById.get(exec.taskId) : undefined;
        if (!exec || !task) continue;
        // 预算语义与 executor-restart 路径同源（ExecutorService）。预算耗尽
        // 时连 kill 都不发——没有新执行就不会双跑。
        if (!this.executorService.hasRetryBudget(task, exec)) continue;
        retryables.push({ id: row.id, exec, task });
      }

      // 3) 分批并发 kill→retry：每批内并发，批间串行，限制同时在飞的 HTTP 数。
      for (
        let i = 0;
        i < retryables.length;
        i += STALE_RECOVERY_KILL_CONCURRENCY
      ) {
        const batch = retryables.slice(i, i + STALE_RECOVERY_KILL_CONCURRENCY);
        await Promise.allSettled(
          batch.map(async ({ exec, task }) => {
            // kill 必须在 re-enqueue 之前：防"执行器谎报/进程僵死但仍存活"场景下
            // 原进程与新执行双跑。best-effort——离线/404/超时不阻塞重试。
            // P2-3（2026-10-26 第三轮审计）：透传行身份 exec.executorId——这是
            // stale sweep 防双跑的关键防线，pull 同址多行时按 address 寻路会进
            // 别行的命令队列（任一行获胜），错误机器查无此执行且无任何痕迹。
            // 存量行 executorId 为空 → 上层回落 address 寻路并 warn。
            try {
              await this.executorService.notifyExecutorKill(
                exec.id,
                exec.executorAddress,
                exec.executorId,
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
          }),
        );
      }
    }

    // P1: sweep PENDING executions never picked up by a worker (queue lost
    // the job / Redis flushed) — after a grace window mark them FAILED.
    // TASK-004: 同样改为单条条件批量 UPDATE（终态保护：仅 PENDING 可被清理）。
    //
    // R-10（DEEP_REVIEW 0ef3bbe）: 此前 find({ status: PENDING }) 无 SQL 级
    // cutoff（时间范围）和 take（行数限制）——系统恢复/大规模积压时数万行
    // PENDING 全量进内存。现在把 grace cutoff 下推到 SQL（createdAt < cutoff），
    // 并按 PENDING_SWEEP_BATCH_SIZE 分批循环：每批标记 FAILED 后状态即脱离
    // PENDING，下一批 find 自然推进，单轮 cron 最多处理 N 行避免长事务/内存峰值。
    const PENDING_GRACE_MS = 10 * 60 * 1000;
    const pendingCutoff = new Date(now - PENDING_GRACE_MS);
    let recoveredPending = 0;
    // R-10: 单批最多捞多少行 stale PENDING（循环直至某批不足批大小）。
    const PENDING_SWEEP_BATCH_SIZE = 1000;
    for (;;) {
      const stalePending = await this.execRepo.find({
        where: {
          status: ExecutionStatus.PENDING,
          createdAt: LessThan(pendingCutoff),
        },
        take: PENDING_SWEEP_BATCH_SIZE,
      });
      const stalePendingIds = stalePending.map((exec) => exec.id);
      if (stalePendingIds.length === 0) break;
      // A1: 走统一入口。本桶只回收「从未被派发」的行，故门槛显式收窄为
      // PENDING（而非默认开放态）——PENDING 行不可能持有执行器槽位，无需
      // 传 addressSnapshot。
      const result = await transitionToTerminal(this.execRepo, {
        ids: stalePendingIds,
        patch: {
          status: ExecutionStatus.FAILED,
          endTime: finishedAt,
          errorMessage:
            "Execution was never dispatched by the queue (recovered by stale sweep)",
          // P0-8（UX-AUDIT-2026-09-21）：本桶只回收「从未被派发」的行（见上），
          // 此前写泛化的 UNKNOWN，用户看到「未知原因：去查看执行日志定位根因」——
          // 而这类执行**从未在任何机器上运行过，根本没有日志可看**，提示把排查
          // 方向指向了一个不存在的东西。同一次 sweep 的 RUNNING 桶早已升级为
          // STALE_RECOVERED，此处补齐以消除"同一类失败按桶分类不同"的不一致。
          failureReason: ExecutionFailureReason.NEVER_DISPATCHED,
        },
        from: [ExecutionStatus.PENDING],
      });
      const batchRecovered = result.rows.length;
      recoveredPending += batchRecovered > 0 ? batchRecovered : result.affected;
      // 这批捞满了但一条都没真正命中（竞态：并发回调已写终态）→ 再捞一次
      // 推进游标；否则若本批未捞满说明已无更多 stale PENDING，退出。
      if (stalePendingIds.length < PENDING_SWEEP_BATCH_SIZE) break;
    }
    if (recoveredPending > 0) {
      this.logger.warn(
        `REC-01: ${recoveredPending} pending execution(s) never dispatched, marked FAILED`,
      );
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
   * 绝对兜底 max(6×timeout, 5min)（O-3 从 30min 收紧）。执行器离线 / 无记录 / 未上报（runningExecutionIds
   * 为 null 或不含该 id）→ 不跳过，维持既有恢复行为。
   *
   * 探测失败（执行器表查询异常）时降级为"不跳过"（空集），宁可对疑似仍健康的行
   * 恢复一次，也不放大容量误判。
   *
   * ## ADR-017 阶段 3（复查补口）：活性探测必须按**行身份**定位执行器
   *
   * 阶段 3 把 `uq_executors_address` 收窄为 partial（仅 push 行），pull 模式
   * **允许同地址多行并存**（ADR-017 §5）。此前实现用 `new Map(rows.map(ex =>
   * [ex.address, ex]))` 建地址索引——**同址多行时 Map 静默折叠为最后一行**：
   * A 的候选执行去读 B 的 `runningExecutionIds`，命中与否全凭「B 恰好也在跑
   * 同名 id」这个巧合。两个方向都错：
   * - B 的数组不含 A 的 executionId → A 的健康长任务**失去存活宽限**，被提前
   *   恢复成 FAILED（正是 E1/CONSISTENCY-02 引入该字段要消灭的误判）；
   * - B 的数组含该 id（同名/串台）→ 错误地延后一条其实已死的执行。
   *
   * 修法：候选行**有 `executorId`**（阶段 3 起新派发一律有）时按 id 精确定位；
   * 无该值（存量行）才回落地址匹配，且**只在该地址唯一对应一行时**采用——
   * 同址多行且候选无行身份时无法判定归属，按"不跳过"处置（= 本方法既有的
   * 保守失败方向：宁可恢复一次，也不放大容量误判）。
   *
   * 单行部署（引入本改动前的全部现实形态）行为与原来逐字节一致。
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

    // 分层收集：有行身份走 id，其余走地址（两条谓词各自可下推索引）。
    const executorIds = [
      ...new Set(
        candidates
          .map((c) => c.exec.executorId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    // 只有**缺行身份**的候选才需要地址维度（有 id 的已被精确覆盖）。
    const addressesNeeded = [
      ...new Set(
        candidates
          .filter((c) => !c.exec.executorId)
          .map((c) => c.exec.executorAddress)
          .filter((a): a is string => Boolean(a)),
      ),
    ];
    if (executorIds.length === 0 && addressesNeeded.length === 0) {
      return { deferredIds };
    }

    let executors: Array<{
      id: string;
      address: string;
      status: ExecutorStatus;
      runningExecutionIds: string[] | null;
    }> = [];
    try {
      // 一次查询覆盖两个维度（任一命中即取回）；两条谓词都不成立的行不参与
      // 判定，语义与原来的 address-only 查询一致。
      executors = await this.dataSource.getRepository(Executor).find({
        where: [
          ...(executorIds.length > 0 ? [{ id: In(executorIds) }] : []),
          ...(addressesNeeded.length > 0
            ? [{ address: In(addressesNeeded) }]
            : []),
        ],
        select: {
          id: true,
          address: true,
          status: true,
          runningExecutionIds: true,
        },
      });
    } catch (err: unknown) {
      this.logger.warn(
        `recoverStaleExecutions liveness probe degraded (recover normally): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { deferredIds };
    }

    // 行身份索引：id 是主键，恒无歧义。
    const byId = new Map(executors.map((ex) => [ex.id, ex] as const));
    // 地址索引：**仅供无行身份的存量候选**使用，且必须唯一——同址多行时
    // 该地址无法指代一行，从索引里剔除（查不到 → 不跳过，见方法头注）。
    const byAddress = new Map<string, (typeof executors)[number]>();
    const ambiguousAddresses = new Set<string>();
    for (const ex of executors) {
      if (byAddress.has(ex.address)) {
        // 第二行同址 → 地址维度作废（连先前那一条一起撤下，否则"先到的
        // 一行"会被当成唯一行，正是本次要修的错行判定）。
        byAddress.delete(ex.address);
        ambiguousAddresses.add(ex.address);
      } else if (!ambiguousAddresses.has(ex.address)) {
        byAddress.set(ex.address, ex);
      }
    }
    // NETOPT-D P3: 候选循环内对 ≤10000 数组逐条 includes() 是 O(N×10000) 热路径
    // ——批次 C 把截顶从 200 提到 10000 后成本放大 50×。按**行身份**预建 Set、
    // 循环内 O(1) 命中；Set 缺失（= 未上报该字段）语义与原 `!isArray` 分支一致。
    const runningIdSets = new Map<string, Set<string>>();
    for (const ex of executors) {
      if (Array.isArray(ex.runningExecutionIds)) {
        runningIdSets.set(ex.id, new Set(ex.runningExecutionIds));
      }
    }
    for (const c of candidates) {
      // ADR-017 阶段 3：优先按行身份定位；无则该候选只能靠地址（唯一时）。
      let ex: (typeof executors)[number] | undefined;
      let resolvedBy: string;
      const rowId = c.exec.executorId;
      if (rowId) {
        ex = byId.get(rowId);
        resolvedBy = `executorId=${rowId}`;
      } else {
        const addr = c.exec.executorAddress;
        if (!addr) continue;
        ex = byAddress.get(addr);
        resolvedBy = `address=${addr}`;
      }
      // 执行器离线 / 无记录（含地址歧义）→ 不跳过。
      if (!ex || ex.status !== ExecutorStatus.ONLINE) continue;
      const runningIds = runningIdSets.get(ex.id);
      if (!runningIds) continue;
      if (!runningIds.has(c.exec.id)) continue;

      // 活性命中，但设绝对兜底：超过 max(6×timeout, 5min) 仍强制恢复（O-3）。
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
          `REC-01: execution ${c.exec.id} reported still-running by ${resolvedBy} but exceeded the absolute fallback — recovering anyway`,
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
    // N-14：实现挪到 task/block-strategy-gate.ts（手动触发路径的 cover 同样
    // 需要槽位冲销），此处保留薄委托以不动全部调用点。
    await releaseExecutorSlotByAddress(this.dataSource, address);
  }

  /**
   * MUTEX-01（应用互斥组）：互斥排队唤醒。
   *
   * WAITING 执行的唤醒语义：任意同组执行在任意设备上终态释放后，排队的执行
   * 就应该被重新尝试派发。本 sweep 是**唯一唤醒机制**（刻意不做终态钩子）：
   * - 正确性：每 10s 无条件重试所有 WAITING——组占用是否真的释放由 dispatch
   *   占坑事务重新判定（竞态输家再次 WAITING，下轮 sweep 收敛），唤醒本身
   *   不做任何「占用已释放」的推断，因此不可能漏唤醒，也不需要与终态写路径
   *   （A1 终态门、多处调用点）耦合出新的通知链路；
   * - 同组短路（P3 惊群修复）：单轮内每个互斥组只唤醒**最早的一条**作为探针，
   *   其余同组候选本轮跳过。dispatch 的组满判定是逐候选一次 FOR UPDATE 占坑
   *   事务（claimExecutorSlotForExecution）——组满时同组其余候选**必然同样
   *   失败**，全量唤醒只是每 10s 白烧 take:200 个 job。探针失败会回 WAITING
   *   （MutexWaitError 路径）或离线排队（processor 互斥执行回 WAITING 路径），
   *   下轮 sweep 再试；组有容量时探针成功占用、下轮唤醒下一条，以 10s 粒度
   *   逐条排空——组级唤醒保证不变，只是把"同一判断重复 N 次"收敛为 1 次。
   *   无组（mutexGroupId=null）候选不受影响，照旧全量唤醒。
   * - 延迟：≤10s + 队列延迟，相对浏览器自动化任务的分钟级时长可忽略；
   * - 多实例：与 reload/checkMisfires 同款 isLeader 门，单 Leader 执行。
   *
   * WAITING → PENDING 用条件 UPDATE 独占唤醒权（并发/重复触发只入队一次），
   * 入队失败回滚为 WAITING（否则该执行沦为无 job 的 PENDING，10 分钟后被
   * stale sweep 误标 never_dispatched）。唤醒 job 带任务完整重试预算（等待
   * 期间 attempts 一次都没消耗，语义等同一次全新派发尝试）。
   */
  @Cron(CronExpression.EVERY_10_SECONDS)
  async wakeMutexQueuedExecutions() {
    if (!this.isLeader) return;
    // CRON-GUARD：顶层异常闸门——DB 抖动不得升级为未处理 rejection（进程退出）。
    await this.guardTick("wakeMutexQueuedExecutions", () =>
      this.wakeMutexQueuedExecutionsBody(),
    );
  }

  /** wakeMutexQueuedExecutions 的扫描体（异常由 guardTick 统一兜住）。 */
  private async wakeMutexQueuedExecutionsBody(): Promise<void> {
    // B-4（调度域审计）：分页循环——旧实现单次 take:200 无翻页，积压 > 200
    // 且最早 200 条同属满组时（组内探针翻转后很快被 dispatch 失败退回
    // WAITING，回到页首），第 201+ 条永远拿不到探针。改为 (createdAt,id)
    // keyset 游标分页：每轮游标推进到本页最后一行（无论该行翻转与否——
    // 翻转成功的行已离开 WAITING，被有意跳过的行见下方各自注释），直至取空
    // 或到达安全轮数上限（防极端情形下的死循环；上限内的未处理行交由下一
    // tick 继续，10s 粒度不丢唤醒保证）。翻页安全：翻转是条件 UPDATE 独占
    // 唤醒权（幂等），重复处理同一行不会重复入队。
    let woken = 0;
    let skippedSameGroup = 0;
    // B-11: 非 ACTIVE（PAUSED）任务的排队执行被跳过的计数
    let skippedNotActive = 0;
    // 同组短路：本次 sweep（跨所有分页轮）已唤醒过探针的互斥组。
    const probedGroups = new Set<string>();
    let cursor: { createdAt: Date; id: string } | null = null;
    for (let round = 0; round < MUTEX_WAKE_MAX_ROUNDS; round++) {
      const pageQb = this.execRepo
        .createQueryBuilder("e")
        .where("e.status = :waiting", { waiting: ExecutionStatus.WAITING })
        .orderBy("e.createdAt", "ASC")
        .addOrderBy("e.id", "ASC")
        .take(MUTEX_WAKE_PAGE_SIZE);
      if (cursor) {
        pageQb.andWhere(
          "(e.createdAt > :cursorAt OR (e.createdAt = :cursorAt AND e.id > :cursorId))",
          { cursorAt: cursor.createdAt, cursorId: cursor.id },
        );
      }
      const waiting = await pageQb.getMany();
      if (waiting.length === 0) break;

      const taskIds = [...new Set(waiting.map((e) => e.taskId))];
      const tasks = await this.taskRepo.findBy({ id: In(taskIds) });
      // B-11: 任务行按 id 索引——唤醒前校验任务仍为 ACTIVE（PAUSED 跳过）。
      const taskById = new Map(tasks.map((t) => [t.id, t] as const));
      const attemptsByTask = new Map(
        tasks.map((t) => [t.id, Math.max(1, t.maxRetry ?? 1)]),
      );
      const priorityByTask = new Map(
        // A4: 地图值直接换算为 BullMQ 出队优先级（DB 4=紧急 → BullMQ 1=最先
        // 出队）。任务行被并发删除时 .get() 仍回 undefined，沿用旧缺省行为。
        tasks.map((t) => [
          t.id,
          toBullPriority(normalizeTaskPriority(t.priority)),
        ]),
      );

      for (const exec of waiting) {
        // B-11（调度域审计）：PAUSED（及一切非 ACTIVE）任务的排队执行不再
        // 被唤醒派发——行保持 WAITING 不动，resume 落 ACTIVE 后由下一轮
        // sweep 正常唤醒（resume 语义衔接）。任务行缺席（并发删除/软删）
        // 维持旧行为照常唤醒：dispatch 阶段按 "Task not found" 收敛为
        // FAILED，避免行永久悬挂。
        const taskRow = taskById.get(exec.taskId);
        if (taskRow && taskRow.status !== TaskStatus.ACTIVE) {
          skippedNotActive += 1;
          continue;
        }
        // 同组短路：本次 sweep 已唤醒过探针的互斥组（组 id → 已探）。
        if (exec.mutexGroupId) {
          if (probedGroups.has(exec.mutexGroupId)) {
            skippedSameGroup += 1;
            continue;
          }
          probedGroups.add(exec.mutexGroupId);
        }
        // 条件翻转独占唤醒权：同一执行不会被重复入队（sweep 重叠 / 与用户
        // kill 竞态时，kill 赢家先把行终态化，本 UPDATE affected=0 跳过）。
        // errorMessage（排队原因）一并清空——后续失败由各自路径写自己的原因。
        const flipped = await this.execRepo
          .createQueryBuilder()
          .update(TaskExecution)
          .set({ status: ExecutionStatus.PENDING, errorMessage: null })
          .where("id = :id AND status = :waiting", {
            id: exec.id,
            waiting: ExecutionStatus.WAITING,
          })
          .execute();
        if (!flipped.affected) continue;
        try {
          await this.queue.add(
            "execute",
            { executionId: exec.id },
            {
              attempts: attemptsByTask.get(exec.taskId) ?? 1,
              priority: priorityByTask.get(exec.taskId),
            },
          );
          woken += 1;
        } catch (err: unknown) {
          // 回滚为 WAITING：保住「排队等唤醒」的状态，下轮 sweep 再试。
          await this.execRepo
            .createQueryBuilder()
            .update(TaskExecution)
            .set({ status: ExecutionStatus.WAITING })
            .where("id = :id AND status = :pending", {
              id: exec.id,
              pending: ExecutionStatus.PENDING,
            })
            .execute();
          this.logger.warn(
            `MUTEX-01: wake re-enqueue failed for execution ${exec.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      // 游标推进到本页最后一行；本页不足页大小 = 已无更多 WAITING，收工。
      const lastRow = waiting[waiting.length - 1];
      cursor = { createdAt: lastRow.createdAt, id: lastRow.id };
      if (waiting.length < MUTEX_WAKE_PAGE_SIZE) break;
    }
    if (woken > 0 || skippedSameGroup > 0 || skippedNotActive > 0) {
      this.logger.log(
        `MUTEX-01: woke ${woken} mutex-queued execution(s) for re-dispatch` +
          (skippedSameGroup > 0
            ? ` (skipped ${skippedSameGroup} same-group candidate(s) this sweep — group probe already in flight)`
            : "") +
          (skippedNotActive > 0
            ? ` (skipped ${skippedNotActive} candidate(s) of non-active tasks — B-11)`
            : ""),
      );
    }
  }

  /**
   * CRON-GUARD（审计 P2，2026-10-17）：定时回调的**顶层**异常闸门。
   *
   * 缺陷现场：四个 `@Cron` 方法（checkMisfires / recoverStaleExecutions /
   * wakeMutexQueuedExecutions / reload）都是直接 `async` 体，体内任何一次
   * 未捕获的 DB 异常（连接池抖动、语句超时、序列化冲突重试耗尽）都会变成
   * **未处理的 Promise rejection**。@nestjs/schedule 的 cron 回调不 await
   * 返回的 Promise，于是：
   *   · Node 20 默认 `--unhandled-rejections=throw` → 进程直接退出；
   *   · 即使被宿主兜住，该轮 tick 也静默丢失、无日志可循。
   * 一次短暂的数据库抖动就能把整个 admin-api 打挂（所有 API 一起 503），
   * 而正确的处置只是「记日志 + 下一轮重试」。
   *
   * 现在所有 cron 体都经本方法包裹：异常被捕获、以 warn 记栈（含 tick 名），
   * 下一轮周期自然重试。**刻意不重试本轮**——这些 tick 全是幂等扫描，下一轮
   * 5s/10s/1min/2min 后重跑比在本轮内紧循环重试更安全（不放大 DB 压力）。
   */
  private async guardTick(
    name: string,
    body: () => Promise<void>,
  ): Promise<boolean> {
    // R126-A1（重入闸）：上面说的「cron 回调不 await 返回的 Promise」还有另一面
    // ——扫描体跑得比周期长时，下一拍的实例必然**与上一拍并发**。异常有 catch
    // 兜住，重叠此前完全没人管：
    //   · 万级 active 表上并发跑 2 份 keyset 全表扫描（DB 压力 ×2，且可能叠加
    //     到 3 份、4 份，没有上界）；
    //   · 两份 reload 并发推进 reloadTickCount → F-1 对账轮次漂移；
    //   · 两份 reload 都把同一批任务判为「未注册」→ 后一份 scheduleOne 先 stop
    //     再重排刚注册的定时器，node-cron 相位被重置，短周期 cron 丢一拍。
    // 丢弃重叠轮是安全的：四个 tick 都是幂等扫描，下一拍自然接上（与异常路径
    // 的处理一致），不会漏掉终态收敛——最坏只是延后一个周期。
    // 返回值语义：true = 本轮真的跑了扫描体（调用方据此决定是否记 tick 指标）。
    if (this.inFlightTicks.has(name)) {
      this.logger.warn(
        `Scheduler tick "${name}" is still in flight — overlapping invocation skipped`,
      );
      return false;
    }
    this.inFlightTicks.add(name);
    try {
      await body();
      return true;
    } catch (err: unknown) {
      this.logger.warn(
        `Scheduler tick "${name}" failed and was skipped this round ` +
          `(next tick retries): ${
            err instanceof Error ? (err.stack ?? err.message) : String(err)
          }`,
      );
      return true;
    } finally {
      this.inFlightTicks.delete(name);
    }
  }

  /**
   * N5: stale 扫描的初始窗口 = min(所有 active 任务中最短的
   * max(2×timeout, 60s) 阈值, 1h 兜底)。timeout=0（不限时）任务不参与收缩，
   * 仍由 1h 兜底覆盖；没有任何短 timeout 任务时窗口保持 1h，扫描开销不变。
   * 轻量查询仅取 id/timeout 两列。
   */
  private async staleScanWindowMs(): Promise<number> {
    // E-P1-R1: 窗口只需所有 active 任务中的最短阈值。staleThresholdMs(timeout)
    // = max(timeout*2,60)*1000 对 timeout 单调非降，故取 timeout>0 中 timeout
    // 最小的一行（ORDER BY timeout ASC LIMIT 1）即可——这正面满足旧注释「不能
    // take 截断否则漏掉最短 timeout」的约束：我们要的就是最短那一个，不再把
    // 全表 id/timeout 拉进内存。timeout=0（不限时）不参与收缩，仍由 1h 兜底覆盖。
    const shortest = await this.taskRepo.findOne({
      where: { status: TaskStatus.ACTIVE, timeout: MoreThan(0) },
      select: { id: true, timeout: true },
      order: { timeout: "ASC" },
    });
    if (!shortest || !shortest.timeout || shortest.timeout <= 0) {
      return STALE_SCAN_FALLBACK_MS;
    }
    const shortestMs = staleThresholdMs(shortest.timeout);
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
    // CRON-GUARD：顶层异常闸门——DB 抖动不得升级为未处理 rejection（进程退出）。
    // 计时/指标仍包住扫描体本身（recordTick 在 finally 里，异常路径同样记账）。
    const tickStart = Date.now();
    let ran = false;
    try {
      ran = await this.guardTick("reload", () => this.reloadActiveTasks());
    } finally {
      // R126-A1: 被重入闸丢弃的重叠轮不计入 tick 指标（否则 tick 数与真实
      // 扫描次数脱钩，tick 时延分位数被一堆 0ms 的空转污染）。
      if (ran) this.schedulerMetrics.recordTick(Date.now() - tickStart);
    }
  }

  /** reload 的实际扫描体（抽出以便 tick 计时只包住扫描工作本身） */
  private async reloadActiveTasks(): Promise<void> {
    // F-1（HA 审计）：每 N 轮（scheduler.reconcileEvery，默认 5）做一次注册
    // 指纹对账。非对账轮保持 id-only 轻扫描；对账轮只是把**既有** keyset
    // 扫描的 select 加宽 4 个触发配置列——不新增 DB 查询次数，指纹构建与
    // 比对纯内存，漂移者的重排每轮至多一次（In 一批取整行后逐个 scheduleOne）。
    const reconcileEvery = this.resolveReconcileEvery();
    const reconcileRound =
      reconcileEvery > 0 && ++this.reloadTickCount % reconcileEvery === 0;
    const dbFingerprints = reconcileRound ? new Map<string, string>() : null;
    // O-4 修正：活跃集合的 id-only 扫描**仍必须收齐全部 active id**——一旦截断，
    // 超过上限的已注册任务会因不在 activeIds 里被下方的清理循环误 stop，调度静默
    // 丢失。E-P1-R1：把单次无界 find 改为按 id 升序 keyset 分页循环拉全量——
    // 语义上与旧版等价（仍收齐全部 id），只是每批有界、用主键范围扫描，避免万级
    // active 单次大结果集。完整行只对「尚未注册的新任务」按 id 定向补拉。
    const activeIds: string[] = [];
    let idCursor = "";
    for (;;) {
      // id 是 uuid 列，idCursor 为空串时绝不能拼 `id > ''`（PG 报 invalid input syntax for type uuid）
      const where: Record<string, unknown> = { status: TaskStatus.ACTIVE };
      if (idCursor) where.id = MoreThan(idCursor);
      const rows = await this.taskRepo.find({
        where,
        select: dbFingerprints
          ? {
              id: true,
              triggerType: true,
              cronExpression: true,
              fixedRate: true,
              timezone: true,
            }
          : { id: true },
        order: { id: "ASC" },
        take: ACTIVE_TASK_PAGE_SIZE,
      });
      if (rows.length === 0) break;
      for (const row of rows) {
        activeIds.push(row.id);
        // F-1: 对账轮顺手构建 DB 侧指纹（同一批行，无额外查询）。
        dbFingerprints?.set(row.id, taskTriggerFingerprint(row));
      }
      if (rows.length < ACTIVE_TASK_PAGE_SIZE) break;
      idCursor = rows[rows.length - 1].id;
    }
    const activeSet = new Set(activeIds);

    // BUG-01: Stop and clean up timers for tasks that are no longer active
    // This prevents memory leaks from accumulating inactive task references
    for (const id of this.timers.keys()) {
      if (!activeSet.has(id)) this.stop(id);
    }
    for (const id of this.cronTasks.keys()) {
      if (!activeSet.has(id)) this.stop(id);
    }

    // BUG-01: Clean up running tasks map for tasks that are no longer active
    for (const id of this.runningTasks.keys()) {
      if (!activeSet.has(id)) this.runningTasks.delete(id);
    }

    const missingIds = activeIds.filter(
      (id) => !this.timers.has(id) && !this.cronTasks.has(id),
    );
    if (missingIds.length === 0) {
      // F-1: 无缺失注册时也要走对账轮（漂移的恰恰是「已注册但配置已改」的任务）。
      if (dbFingerprints) {
        await this.reconcileTriggerFingerprints(dbFingerprints);
      }
      return;
    }
    const tasks = await this.taskRepo.find({
      where: { id: In(missingIds) },
    });
    for (const task of tasks) {
      await this.scheduleOne(task);
    }
    // F-1: 对账轮——本 tick 刚补注册的任务指纹已在 scheduleOne 里同步到
    // DB 值，比对天然通过；比对只可能命中「DB 配置已改而本地注册是旧的」。
    if (dbFingerprints) {
      await this.reconcileTriggerFingerprints(dbFingerprints);
    }
  }

  /**
   * F-1（HA 审计）：注册指纹对账。DB 侧指纹（reloadActiveTasks 对账轮随 id
   * 扫描构建）与本地注册指纹逐任务比对，漂移者逐个 scheduleOne 重排
   * （scheduleOne 内部先 stop 旧注册再按新配置注册）。
   *
   * 跳过规则：
   * - 本地未注册（timers/cronTasks 均无）的任务不进对账——它们归 missingIds
   *   路径补注册（注册失败如非法 cron 的，下一轮 reload 仍走 missing 重试）；
   * - 指纹比对在内存完成，漂移者的整行重取按 In 一批（每轮对账至多一次）。
   *
   * 边界：对账只发生在 Leader（reloadActiveTasks 的唯一调用方 reload 有
   * isLeader 门）；scheduleOne 内部的 isLeader 门沿用现有逻辑——与对账
   * 之间 demote 的竞态下 scheduleOne 会自跳过，新 Leader 的 reload 会重建。
   */
  private async reconcileTriggerFingerprints(
    dbFingerprints: Map<string, string>,
  ): Promise<void> {
    const drifted: string[] = [];
    for (const [id, fp] of dbFingerprints) {
      if (!this.timers.has(id) && !this.cronTasks.has(id)) continue;
      if (this.registeredFingerprints.get(id) !== fp) drifted.push(id);
    }
    if (drifted.length === 0) return;
    this.logger.log(
      `Trigger fingerprint reconciliation: ${drifted.length} task(s) drifted from the local registry — re-scheduling`,
    );
    const driftedTasks = await this.taskRepo.find({
      where: { id: In(drifted) },
    });
    for (const task of driftedTasks) {
      await this.scheduleOne(task);
    }
  }

  /**
   * F-1: 对账周期 N 的解析（scheduler.reconcileEvery，env
   * SCHEDULER_RECONCILE_EVERY，默认 5）。非法/缺省回退默认值——对账是
   * 自愈路径，配置坏了宁可多做也不能关掉（0/负数/非整数一律回退）。
   */
  private resolveReconcileEvery(): number {
    const raw = this.configService.get<number>("scheduler.reconcileEvery");
    return typeof raw === "number" && Number.isInteger(raw) && raw > 0
      ? raw
      : SCHEDULER_RECONCILE_EVERY;
  }

  async enqueue(
    task: Task,
    triggerType: string,
    /** CORE-06：定时器计划触发的时刻（Date.now()），用于 fire→入队延迟分布 */
    fireTime?: number,
  ) {
    // FEAT-06: 任务级维护窗口——命中即跳过（不 claim 去重锁、不建
    // executions 行、不推进 lastTriggerTime），窗口关闭后的下一个调度点
    // 正常触发。检查放在去重锁之前：被窗口抑制的触发不应消耗本周期的
    // 去重窗口。范围取舍：仅约束调度入队路径（cron/fixed_rate/misfire
    // 补偿）；手动/API 触发与依赖扇出走 TaskService.trigger，不受窗口
    // 约束（发布窗口内人工补跑是预期操作）。可观测性：metrics 的
    // triggersSkippedMaintenance + 本日志，executions 不建行（窗口内
    // 每个触发点都会跳过，建行会淹没执行记录）。
    // 时区：窗口 cron 与调度主 cron 同一语义——按任务自身 timezone 的分区
    // 壁钟评估（P2 修复：此前按服务器本地时区评估，UTC 容器下窗口错位数
    // 小时）。未配置/空串/存量非法值由 util 内部降级服务端本地时区（非法值
    // 的写面拦截见 timezone.constraint.ts）。
    const activeWindow = findActiveMaintenanceWindow(
      task.maintenanceWindows,
      undefined,
      task.timezone?.trim() || undefined,
    );
    if (activeWindow) {
      this.logger.log(
        `Task "${task.name}" trigger skipped: inside maintenance window ` +
          `(start=${activeWindow.start}, end=${activeWindow.end}` +
          `${activeWindow.description ? `, ${activeWindow.description}` : ""})`,
      );
      this.schedulerMetrics.recordTriggerSkippedMaintenance();
      return null;
    }
    // N6: the dedup window is derived from the trigger period, NOT the task
    // timeout (the old max(timeout, interval) TTL silently suppressed
    // short-period tasks down to the task timeout). See computeTriggerDedupTtlMs.
    const lockTTL = computeTriggerDedupTtlMs(task);

    // R126-A1（去重权威单一化）：触发去重的**唯一权威是 DB 条件 claim**
    // （claimTaskTrigger 的条件 UPDATE）。Redis 锁 task:trigger:* 降级为
    // 「先手快筛」——它能在不写库的情况下挡掉绝大多数跨实例重复，但不能
    // 单独充任去重。
    //
    // 缺陷现场（旧写法）：只有 acquireLock **抛错**时才走 DB claim，Redis
    // 正常时入队完全不读 lastTriggerTime。于是「部分 Redis 故障」（连接池
    // 耗尽 / 单次超时，而不是整个 Redis 挂掉）会同时激活两条互不相认的
    // 权威：实例 A 超时 → DB claim 推进 lastTriggerTime → 入队；实例 B
    // Redis 正常 → 拿到 task:trigger:<id>（A 从未持有过它）→ 同一去重窗口
    // 内再派一次。跨实例去重实际由「谁先拿到 Redis 锁」单点决定，DB 侧的
    // CAS 只在 Redis 全挂时生效——两条路径不同源就是没有权威。
    //
    // 现在无论 Redis 是否可用，入队前都必须赢得同一条条件 UPDATE：Redis
    // 锁只是快筛，DB claim 是判决。写入次数不增加（原先入队成功后本来就有
    // 一次无条件 UPDATE lastTriggerTime，现由 claim 取代）。
    let lock: Lock | null = null;
    let redisUnavailable = false;
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
      // TASK-006 降级路径：Redis 不可用时不能因此丢掉调度——快筛失效，
      // 交由下方统一的 DB 条件 claim 独自裁决。
      redisUnavailable = true;
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Redis trigger lock unavailable for "${task.name}" (${message}); falling back to the DB conditional claim`,
      );
    }
    if (!lock && !redisUnavailable) {
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

      // R126-A1: 与 Redis 是否可用无关的**唯一**去重判决。放在 blockStrategy
      // 闸门之前是刻意的：闸门会做 kill/覆盖等**副作用**（COVER_EARLY 会杀掉
      // 在跑执行），若先过闸门再输掉 claim，就会出现「杀了人家却没派新的」。
      // 领取窗口与 Redis 锁 TTL 同源（lockTTL），两者语义保持一致。
      const claimed = await this.claimTaskTrigger(task, lockTTL);
      if (!claimed) {
        this.logger.debug(
          `Task "${task.name}" trigger already claimed inside the dedup window (db claim), skip`,
        );
        this.schedulerMetrics.recordTriggerSkippedDbClaim();
        return null;
      }

      // N-14：blockStrategy 闸门抽到共享 util（task/block-strategy-gate.ts），
      // 手动/API/依赖触发（TaskService.trigger）与调度路径同规则。比较维度=
      // 「任务+参数」：仅同参在跑/排队才覆盖/丢弃，异参放行并发（发货程序按
      // 订单传参场景）。调度触发恒用 task.params——对本路径行为不变（历史
      // 执行行的 params 同源）。
      // MUTEX-01 语义保留：WAITING（互斥/部署约束排队）计入「前一轮还没跑
      // 完」；PENDING 刻意不计入（BullMQ backlog 是常态，计入会改变既有
      // 语义）。与互斥组正交：闸门管触发层重复工作，互斥组管执行层串行。
      const gateOutcome = await applyBlockStrategyGate(
        taskRecord,
        taskRecord.params,
        this.execRepo,
        {
          warn: (message) => this.logger.warn(message),
          releaseSlot: (address) => this.releaseExecutorSlot(address),
          notifyKill: (executionId, address, executorId) =>
            // P2-3: 透传被覆盖行的行身份（pull 同址多行时按行寻路 kill）。
            this.executorService.notifyExecutorKill(
              executionId,
              address,
              executorId,
            ),
          onDiscardSkip: () =>
            this.schedulerMetrics.recordTriggerSkippedBlockStrategy(),
        },
      );
      if (gateOutcome === "skip") return null;

      const exec = await this.execRepo.save(
        this.execRepo.create({
          taskId: task.id,
          taskName: task.name,
          status: ExecutionStatus.PENDING,
          params: task.params,
          triggerType,
          taskVersion: task.currentVersion,
          // MUTEX-01：互斥组快照（task→application 一次主键查询；任务未挂
          // 应用/应用未挂组时为 null，零额外查询）。
          mutexGroupId: await resolveTaskMutexGroupId(this.dataSource, task),
          // OBS-01: 追踪开启时由入队侧生成 trace 根（NULL=追踪未开启）。
          traceId: this.newExecutionTraceId(),
        }),
      );

      const queueOptions = {
        attempts: Math.max(1, task.maxRetry ?? 1),
        backoff:
          task.retryDelay > 0
            ? {
                type: "exponential" as const,
                // CORE-02: 首次尝试即预乘指数基座并加 ±20% 抖动，摊开同周期
                // 失败任务的重试时刻（thundering herd）。
                delay: jitteredRetryDelayMs(task.retryDelay, 1),
              }
            : undefined,
        // N2: DB 里 priority 是 PG 字符串枚举，TypeORM 读回 'normal' 等
        // label——原样传给 BullMQ 会被 lua 校验拒绝（"Priority should not
        // be float"），导致所有调度触发入队失败。入队边界强制归一化为数字。
        // A4: 归一化后再做方向换算——BullMQ 数值越小越先出队，DB 4=紧急
        // 必须映射为 BullMQ 1，否则紧急任务反而排最后。
        priority: toBullPriority(normalizeTaskPriority(task.priority)),
      };
      try {
        // R-29（DEEP_REVIEW 0ef3bbe）: 入队载荷瘦身——只传 executionId。
        // 旧实现把整行 task entity（含 params/secrets 密文）序列化进 Redis，
        // 但 processor 统一从 DB 按 executionId 重读 task（task.processor.ts
        // 仅解构 job.data.executionId），载荷里的 task 是死重量且把密文驻留
        // Redis 数据面。trigger/rollback 入队本就只传 { executionId }，此处对齐。
        await this.queue.add("execute", { executionId: exec.id }, queueOptions);
      } catch (err: unknown) {
        // P1: compensate the committed PENDING row so it cannot hang forever
        const message = err instanceof Error ? err.message : String(err);
        await this.execRepo.update(exec.id, {
          status: ExecutionStatus.FAILED,
          endTime: new Date(),
          errorMessage: `Failed to enqueue execution: ${message}`,
          // F-3（调度域审计）: 补偿行从未进入队列派发（queue.add 抛错），
          // 与同 sweep 的 PENDING 桶（P0-8 决策）统一写 NEVER_DISPATCHED
          // ——此前写泛化 UNKNOWN，用户被「未知原因」引向根本不存在的执行日志。
          failureReason: ExecutionFailureReason.NEVER_DISPATCHED,
        });
        this.logger.error(`Failed to enqueue execution ${exec.id}: ${message}`);
        // R4-§5.5: 已创建 PENDING 行但入队失败（含补偿路径）计为触发失败
        this.schedulerMetrics.recordTriggerFailed();
        return null;
      }
      // P1: lastTriggerTime 供 checkMisfires() 使用（该列历史上从未被写，
      // 使 misfire 补偿成为死代码）。R126-A1: 该列现由上面的 claimTaskTrigger
      // 在**领取触发时原子写入**，这里不再重复无条件 UPDATE——一来省一次写，
      // 二来入队延迟（queue.add 可能几百 ms）不再污染去重窗口的起点，避免
      // 「上一次的 lastTriggerTime 落到下一个窗口内」把合法的一拍压掉。
      // R4-§5.5: 触发成功（claim 赢家且执行已入队）
      this.schedulerMetrics.recordTriggerClaimed();
      // CORE-06：定时触发的 fire→入队延迟（手动触发无计划时刻，不记录）
      if (fireTime != null) {
        this.schedulerMetrics.recordTriggerLatency(Date.now() - fireTime);
      }
      // OBS-01: 调度入队 span（traceId 来自刚落库的执行行；null=no-op）
      this.tracing?.startSpan(exec.traceId, "scheduler.enqueue", {
        executionId: exec.id,
        triggerType,
      })?.();
      return exec;
    } finally {
      // P1: deliberately do NOT release the dedup lock — its TTL is the
      // dedup window across instances. Releasing it milliseconds after
      // acquisition made it useless against clock skew between instances.
    }
  }

  /**
   * TASK-006 / R126-A1: DB 层原子触发 claim——**每条入队路径的唯一去重判决**。
   * 条件 UPDATE：仅当任务仍为 ACTIVE 且上一触发窗口（与 Redis 锁 TTL 同窗）
   * 之外未被领取过时，本实例才能推进 lastTriggerTime 并获得触发权；
   * affected=0 表示另一实例（或旧 Leader 残余定时器、或另一条触发路径）已
   * 领取，跳过本次触发。
   *
   * R126-A1 之前它只作为「Redis 抛错时的兜底」被调用，于是 Redis 健康的那条
   * 路径完全不读 lastTriggerTime——两条路径不同源，部分 Redis 故障时同一窗口
   * 会派两次。现在它与 Redis 锁的可用性无关：Redis 锁是快筛，本方法是判决。
   * 语义仍与 Redis 锁的"不释放、靠 TTL 去重"保持一致（窗口同源）。
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

  /**
   * OBS-01: 追踪开启时为新建执行生成 trace 根并返回 traceId（落库）。
   * disabled 恒返回 null——零行为变化。
   */
  private newExecutionTraceId(): string | null {
    const traceparent = this.tracing?.startTrace() ?? null;
    return this.tracing?.extractContext(traceparent) ?? null;
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
    // F-1: 注册指纹随注册本体一并清理（保持「timers/cronTasks 有 ⇒ 指纹有」
    // 的不变式，防 inactive 任务在指纹表残留泄漏）。
    this.registeredFingerprints.delete(taskId);
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
      // F-1: 记录本次注册依据的触发配置指纹（对账轮据此与 DB 侧比对）。
      // 放在 stop 之后（stop 会清指纹）且与注册本体同步——即使后续因非法
      // cron 等原因未注册成功，指纹也只是「无注册的孤儿」，对账轮按
      // 「本地未注册」跳过，missingIds 路径下一轮会重试注册。
      this.registeredFingerprints.set(task.id, taskTriggerFingerprint(task));

      // FIX-1.3: active 任务缺触发配置的日志面暴露——写面配对校验
      // （task.service.assertTriggerConfigConsistent）落地前创建的存量行、或
      // 内部调用方绕过 DTO 的行，会走到这里**静默不注册任何定时器**：任务在
      // UI 显示「计划中」却永不触发，misfire 补偿也因 lastTriggerTime 恒空而
      // 失明。warn 让该配置缺陷每次 reload 都可见（reload 每分钟重扫）。
      if (
        task.triggerType === TaskTriggerType.CRON &&
        !task.cronExpression?.trim()
      ) {
        this.logger.warn(
          `Task "${task.name}" (${task.id}) is active with triggerType=cron but has no cronExpression — NOT scheduling, it will never fire`,
        );
      }
      if (
        task.triggerType === TaskTriggerType.FIXED_RATE &&
        !(task.fixedRate && task.fixedRate >= 1)
      ) {
        this.logger.warn(
          `Task "${task.name}" (${task.id}) is active with triggerType=fixed_rate but has no fixedRate — NOT scheduling, it will never fire`,
        );
      }

      if (task.triggerType === TaskTriggerType.FIXED_RATE && task.fixedRate) {
        const taskId = task.id;
        const timer = setInterval(
          async () => {
            // INCIDENT-2026-10-28 §2.5：在**回调开始时刻**取代际快照（不是注册
            // 时刻）。demote 之前注册的定时器在 demote 之后照常触发是期望行为
            // （正是 P0-1 要保住的落点）；只有"回调已开始、跨过 demote 才恢复"
            // 的那一次才应放弃。
            const generationAtFire = this.runGeneration;
            // B-04: Prevent re-entry
            if (this.runningTasks.get(taskId)) {
              this.logger.warn(
                `Fixed_rate task "${task.name}" still running, skipping trigger`,
              );
              return;
            }
            // CORE-06：计划触发时刻——回调第一行取样，延迟含事件循环滞后 +
            // findOne + 去重锁 + 入队全链
            const fireTime = Date.now();
            this.runningTasks.set(taskId, true);
            try {
              const latest = await this.taskRepo.findOne({
                where: { id: taskId, status: TaskStatus.ACTIVE },
              });
              // INCIDENT-2026-10-28 §2.5：demote 会让本代作废——旧回调恢复后
              // 不得再入队，否则与 demote 后的新落点叠加成重复执行。
              if (this.runGeneration !== generationAtFire) {
                this.logger.warn(
                  `Fixed_rate "${task.name}" fire abandoned: generation changed ` +
                    `(${generationAtFire} -> ${this.runGeneration}) while the ` +
                    `callback was in flight — superseded by demote`,
                );
                return;
              }
              if (latest) await this.enqueue(latest, "fixed_rate", fireTime);
            } finally {
              this.runningTasks.delete(taskId);
            }
          },
          Math.min(task.fixedRate * 1000, MAX_TIMER_DELAY_MS),
        );
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
        // INCIDENT-2026-10-28 §3.3：改用 createTask（不自动 start）——schedule()
        // 会同步 start()，导致首拍 execution:missed 事件无人接收。
        const cronTask = nodeCron.createTask(
          task.cronExpression,
          async () => {
            // INCIDENT-2026-10-28 §2.5：回调开始时刻的代际快照（非注册时刻，
            // 理由见 fixed_rate 分支同名注释）。
            const generationAtFire = this.runGeneration;
            // B-04: Prevent re-entry — mirror the fixed_rate branch. When a
            // previous cron tick is still inside its findOne/enqueue chain, a
            // close-spaced schedule must not fire a second overlapping DB query
            // and enqueue attempt (enqueue's own dedupe still double-guards).
            if (this.runningTasks.get(taskId)) {
              this.logger.warn(
                `Cron task "${task.name}" still running, skipping trigger`,
              );
              return;
            }
            const fireTime = Date.now();
            this.runningTasks.set(taskId, true);
            try {
              const latest = await this.taskRepo.findOne({
                where: { id: taskId, status: TaskStatus.ACTIVE },
              });
              // INCIDENT-2026-10-28 §2.5：demote 会让本代作废——旧回调恢复后
              // 不得再入队，否则与 demote 后的新落点叠加成重复执行。
              if (this.runGeneration !== generationAtFire) {
                this.logger.warn(
                  `Cron "${task.name}" fire abandoned: generation changed ` +
                    `(${generationAtFire} -> ${this.runGeneration}) while the ` +
                    `callback was in flight — superseded by demote`,
                );
                return;
              }
              if (latest) await this.enqueue(latest, "cron", fireTime);
            } finally {
              this.runningTasks.delete(taskId);
            }
          },
          {
            ...this.getCronOptions(task),
            // INCIDENT-2026-10-28 §3.2：漏跑容错窗口。引擎默认 1s，生产上事件
            // 循环被钉住 28~40s，1s 窗口形同虚设——落点被静默丢弃。
            missedExecutionTolerance: computeMissedToleranceMs(task),
            // 挂了 execution:missed 监听后引擎不再自打 warn（node-cron.js:577），
            // 由我们的监听器统一走结构化日志 + 指标。
            suppressMissedWarning: true,
          },
        );

        // INCIDENT-2026-10-28 §3.2：漏跑落点显式记账。context.date 是丢失的
        // 那个落点。这是本次事故唯一"丢了就一定能看到"的信号——12:00 丢点时
        // task_executions 无行、misfire 告警静默、日志里什么都没有。
        cronTask.on("execution:missed", (ctx) => {
          const missedAt =
            ctx.date instanceof Date ? ctx.date : new Date(ctx.date);
          const lagMs = Date.now() - missedAt.getTime();
          this.logger.warn(
            `Cron fire point MISSED for "${task.name}" at ${missedAt.toISOString()} ` +
              `(expression=${task.cronExpression}, late by ${lagMs}ms — event loop was blocked)`,
          );
          this.schedulerMetrics.recordCronSlotMissed();
        });

        // 先挂监听再启动（§3.3：createTask 不自动 start）
        void cronTask.start();
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
