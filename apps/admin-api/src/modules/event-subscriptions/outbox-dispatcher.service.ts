/**
 * FEAT-19: outbox 派发器——出站 webhook 的跨进程 at-least-once 兜底。
 *
 * 与 OutboundEventDispatcher（进程内快速路径）的分工：
 * - 快速路径：事件到达 → 内存快照订阅 → 首投 + 3 次进程内退避 → 终败死信。
 *   快、但进程重启丢在途（at-most-once for in-flight retries）。
 * - outbox 路径（本服务）：同一派发入口同步落一行 event_outbox（写成功才
 *   返回），OnModuleInit 时 + 每 5s 扫描 dispatchedAt IS NULL 且
 *   deadLettered=false 的行，逐行补投；成功回写 dispatchedAt，失败
 *   attempts+1 + nextAttemptAt 指数退避（5s 基座封顶 5min），超过
 *   MAX_OUTBOX_ATTEMPTS 落 event_outbox_dead_letters 并置
 *   deadLettered=true（行终态）。进程重启后扫描自然恢复——不丢任何已落库
 *   待投事件（at-least-once；订阅方须幂等）。
 *
 *   死信表选型：outbox 行按事件落库、逐行投给多个订阅，不属于任何单一订阅，
 *   因此终态归档走独立的 event_outbox_dead_letters（无 subscriptionId FK），
 *   不再复用 event_subscription_dead_letters 的哨兵 subscriptionId（PG 侧 FK
 *   会拒收无主行，此前只能靠日志兜底）。
 *
 * 设计要点：
 * - 派发实现复用 OutboundEventDispatcher.deliverOnce（同签名/同 SSRF 复核/
 *   同超时纪律），不复制第二份 HTTP 逻辑（P2 收敛纪律同 notifyExecutorKill）。
 * - 单行失败互相隔离（逐行 try/catch），扫描周期内一次最多取 50 行防抖。
 * - 扫描自身抛错（DB 抖动）只记日志，不杀 interval——下个周期再试。
 * - EVENT_OUTBOX_ENABLED=false 时完全不落库不扫描（回退 FEAT-07 原行为）。
 * - 无订阅可投的行同样回写 dispatchedAt（事件对当前订阅集已"投递完毕"，
 *   避免冷订阅集期间 outbox 无限积压；快速路径此刻已实时投给在册订阅）。
 */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { InjectRepository } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { Cron } from "@nestjs/schedule";
import {
  DataSource,
  In,
  IsNull,
  LessThan,
  MoreThan,
  Repository,
} from "typeorm";
import { randomUUID } from "node:crypto";
import { EventSubscription } from "./entities/event-subscription.entity";
import { EventOutbox } from "./entities/event-outbox.entity";
import { EventOutboxDeadLetter } from "./entities/event-outbox-dead-letter.entity";
// ARCH-31 §5: cron 维护任务统一 Leader 门禁（@Optional——既有单测装配 gate
// 缺席 → null → 门禁不生效，先例同 log-retention-cleanup）。
import { LeaderGateService } from "../../common/leader-gate/leader-gate.service";
// NETOPT-8②: retention 分批删除的轮数/墙钟双闸（LOG-RETENTION-01 公共 helper）
import { cappedBatchedDelete } from "../../common/utils/capped-batched-delete.util";
import {
  MAX_DELIVERY_ATTEMPTS,
  MAX_OUTBOX_ATTEMPTS,
  OUTBOUND_TIMEOUT_MS,
  outboxRetryDelayMs,
  retryDelayMs,
} from "./event-subscription.util";

/** 扫描间隔（毫秒）。 */
export const OUTBOX_SCAN_INTERVAL_MS = 5_000;
/**
 * 单轮 claim 行数。单行派发最坏 3×10s HTTP timeout + 1s + 2s retry backoff
 * = 33s；**批量 + 并行处理**后，同一轮 claim 的所有行同时开始派发、共享同一
 * 租约窗口，单行最坏 33s 仍远小于 OUTBOX_LEASE_MS（60s），不会出现"后续行
 * 未开始就租约过期"的窗口（那正是旧版串行 + 批量会放大的重复投递窗）。
 * 行数调大让积压不再按"每 5s 一行"的速率消耗；下游突发由 PROCESS_CONCURRENCY
 * 限制（默认 3，见 scanOnce）。
 */
export const OUTBOX_BATCH_SIZE = 5;
/**
 * 单轮并行派发上限：批量行同时发起 HTTP 到订阅方，3 路并发把积压吞吐从
 * "每 5s 一行"提升约 3 倍，同时避免 5 行同时打向同一下游的突发。
 */
export const OUTBOX_PROCESS_CONCURRENCY = 3;
/**
 * 单行在正常派发窗口内的最长时间：每个订阅的重试是串行的，但同一 outbox
 * 行的多个订阅由 deliverToSubscribers 并行执行，因此时间上界不随订阅数相乘。
 */
export const OUTBOX_MAX_ROW_PROCESSING_MS =
  MAX_DELIVERY_ATTEMPTS * OUTBOUND_TIMEOUT_MS +
  retryDelayMs(1) +
  retryDelayMs(2);
/** 单行租约的有效期；过期后其它实例可安全回收。 */
export const OUTBOX_LEASE_MS = 60_000;

// ─── NETOPT-8②: 每日 retention ────────────────────────────────────────────
/**
 * event_outbox（含 jsonb payload）此前只增不删：enqueue 每出站事件插一行、
 * markDispatched 只回写终态、全仓对该 repo 零 delete——行永久堆积。新增每日
 * retention（@Cron 必须 LeaderGate 门禁，ARCH-31 §5 铁律）。
 */
/** 每日 03:55 清理（6 段 cron；错开 03:30/03:35/03:45 的既有维护窗） */
export const OUTBOX_RETENTION_CRON = "0 55 3 * * *";
/** 已派发终态行保留期（天）：payload 仅剩审计追溯价值 */
export const OUTBOX_DISPATCHED_RETENTION_DAYS = 30;
/** 死信保留期（天）：取更长期限 90d 保留 payload 供运维排查（无 replay 通路，
 *  与 event_subscription_dead_letters 的用户可重放语义不同，详见方法头注）。 */
export const OUTBOX_DEAD_LETTER_RETENTION_DAYS = 90;
/** retention 分批大小（对齐 LOG_RETENTION_BATCH_SIZE） */
export const OUTBOX_RETENTION_BATCH_SIZE = 5000;

if (OUTBOX_LEASE_MS <= OUTBOX_MAX_ROW_PROCESSING_MS) {
  throw new Error(
    "OUTBOX_LEASE_MS must exceed the normal worst-case single-row processing window",
  );
}

/**
 * FEAT-19 依赖方向说明（与 OUTBOX_DISPATCHER_TOKEN 对称）：OutboundEventDispatcher
 * （快速路径）与 本服务 互相需要运行时引用——但**刻意不在构造器里互相注入**
 * （那会在 DI graph 上形成解析期环：useFactory 别名互相等对方实体，Nest 会挂死）。
 * 因此两处交叉引用都改为「经构造器注入 ModuleRef，运行时首次用到才
 * moduleRef.get 取令牌」——构造期无环、同实例，@Optional 语义等价（令牌缺席
 * 或取不到时按 null 降级）。令牌本身仍在本模块 providers 中注册（useFactory
 * 别名到真实实例），只是不再作为构造器依赖被解析。
 * - 本服务 → OutboundEventDispatcher：OUTBOUND_DISPATCHER_TOKEN（缺席时补投
 *   跳过投递、仅回写终态——测试/降级场景安全）。
 * - OutboundEventDispatcher → 本服务：OUTBOX_DISPATCHER_TOKEN（缺席时只走内存
 *   快速路径——FEAT-07 原行为）。
 */
export const OUTBOUND_DISPATCHER_TOKEN = Symbol("OUTBOUND_DISPATCHER_TOKEN");

class StaleOutboxOwnerError extends Error {
  constructor() {
    super("outbox lease lost before dead-letter finalization");
    this.name = "StaleOutboxOwnerError";
  }
}

/** OutboundEventDispatcher 的结构最小面（本服务消费的入口）。 */
interface OutboundDispatcherLike {
  deliverToSubscribers(
    eventName: string,
    payload: {
      event: string;
      occurredAt: string;
      data: Record<string, unknown>;
    },
  ): Promise<{
    targetCount: number;
    deliveredCount: number;
    deadLetteredCount: number;
    deadLetterPersistenceFailures: number;
  }>;
}

@Injectable()
export class OutboxDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxDispatcher.name);
  private scanTimer: NodeJS.Timeout | null = null;
  /** 重入锁：上一轮扫描未结束时跳过本轮（串行化补投，降低重复投递窗口）。 */
  private scanning = false;
  private readonly enabled: boolean;
  /** 派发面懒解析缓存：undefined=未解析，null=缺席（令牌取不到）。 */
  private resolvedDispatcher: OutboundDispatcherLike | null | undefined;

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
    @InjectRepository(EventOutbox)
    private readonly outboxRepo: Repository<EventOutbox>,
    @InjectRepository(EventSubscription)
    private readonly subRepo: Repository<EventSubscription>,
    @InjectRepository(EventOutboxDeadLetter)
    private readonly outboxDeadLetterRepo: Repository<EventOutboxDeadLetter>,
    // ARCH-31 §5: 多实例下 @Cron 仅 cron Leader 执行（@Global 恒提供；
    // @Optional 仅为既有单测装配兼容，先例同 log-retention-cleanup）。
    @Optional()
    private readonly leaderGate: LeaderGateService | null = null,
  ) {
    // ConfigService 缺席（极简单测装配）时按默认开启兜底。
    this.enabled =
      this.configService?.get<boolean>("eventOutbox.enabled") !== false;
  }

  /**
   * 运行时懒取派发面（见类头注释：构造器注入会成解析期环）。首次调用经
   * ModuleRef 解析 OUTBOUND_DISPATCHER_TOKEN（模块 useFactory 别名到真实
   * OutboundEventDispatcher）；令牌缺席/取不到时按 null 降级，语义与原本
   * @Optional 注入一致。结果缓存复用。
   */
  private getDispatcher(): OutboundDispatcherLike | null {
    if (this.resolvedDispatcher === undefined) {
      try {
        this.resolvedDispatcher =
          this.moduleRef?.get<OutboundDispatcherLike>(
            OUTBOUND_DISPATCHER_TOKEN,
            { strict: false },
          ) ?? null;
      } catch {
        this.resolvedDispatcher = null;
      }
    }
    return this.resolvedDispatcher;
  }

  onModuleInit(): void {
    // 幂等护栏：本实例经 OUTBOX_DISPATCHER_TOKEN useFactory 别名后挂在两个
    // provider wrapper 下，Nest 生命周期会对每个 wrapper 各调一次 onModuleInit
    // ——不设防会让扫描定时器双份（旧句柄被覆盖但仍在跑，claim 白白竞争一倍）。
    // 已启动（或显式 disabled 后被二次 init）时直接短路。
    if (this.scanTimer) return;
    if (!this.enabled) {
      this.logger.log(
        "Outbox dispatcher disabled (EVENT_OUTBOX_ENABLED=false)",
      );
      return;
    }
    // 启动即扫一轮：补投上一进程遗留的未派发行（重启恢复路径）。
    // fire-and-forget——启动扫描失败不影响应用装配。
    void this.scanOnce();
    this.scanTimer = setInterval(() => {
      void this.scanOnce();
    }, OUTBOX_SCAN_INTERVAL_MS);
    // 不因本 timer 阻止进程退出（优雅关闭由 onModuleDestroy 负责）。
    this.scanTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** 单轮扫描：取应投行 → 逐行补投。全程兜底，绝不外抛。 */
  async scanOnce(): Promise<number> {
    if (this.scanning) return 0;
    this.scanning = true;
    try {
      // claim 必须在数据库内完成：单条 UPDATE/CTE 先用 FOR UPDATE
      // SKIP LOCKED 选行再写租约，不能依赖进程内 scanning 互斥（多实例各自
      // 都会进入此处）。活动租约被跳过，过期租约可由本轮回收。
      const now = new Date();
      const leaseUntil = new Date(now.getTime() + OUTBOX_LEASE_MS);
      const rows = (await this.dataSource.query(
        `
          WITH "claimable" AS (
            SELECT "id"
            FROM "event_outbox"
            WHERE "dispatchedAt" IS NULL
              AND "deadLettered" = false
              AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= $1)
              AND ("leaseUntil" IS NULL OR "leaseUntil" <= $1)
            ORDER BY "createdAt" ASC
            LIMIT $2
            FOR UPDATE SKIP LOCKED
          )
          UPDATE "event_outbox" AS "outbox"
          SET "leaseUntil" = $3,
              "leaseToken" = md5(random()::text || clock_timestamp()::text)
          FROM "claimable"
          WHERE "outbox"."id" = "claimable"."id"
          RETURNING "outbox".*
        `,
        [now, OUTBOX_BATCH_SIZE, leaseUntil],
      )) as EventOutbox[];

      // 无行可投：提前返回，跳过空轮的订阅表查询（该查询只服务于有行时的派发）。
      if (rows.length === 0) return 0;

      // O-8（N+1）：processRow 过去对每一行都重发一次
      // subRepo.find({ enabled: true })。一轮批量（BATCH_SIZE 行 × 并发）下会
      // 重复查询同一张订阅表。这里在 claim 之后查一次启用订阅集，整轮复用——
      // 一轮扫描对同一订阅快照做派发，语义反而更一致。查询失败由外层 catch
      // 兜底（整轮中止、行保持未派发，下轮重投），绝不因快照缺失而误判"无订阅
      // 可投"把事件提前结清。
      const subs = await this.subRepo.find({
        where: { enabled: true },
        select: ["id", "eventTypes"],
      });

      // 有界并发处理：批量行并行派发（所有行同时开始 → 共享同一租约窗口，
      // 单行最坏 33s < 60s 租约），并发上限避免突发打到下游；单行失败互相
      // 隔离（processRow 内部已兜底，这里是逐行最外层保险丝）。
      let cursor = 0;
      const workers = Array.from(
        { length: Math.min(OUTBOX_PROCESS_CONCURRENCY, rows.length) },
        async () => {
          while (cursor < rows.length) {
            const idx = cursor++;
            const row = rows[idx];
            try {
              await this.processRow(row, subs);
            } catch (err: unknown) {
              this.logger.warn(
                `Outbox row ${row.id} (${row.eventType}) processing failed (skip): ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          }
        },
      );
      await Promise.all(workers);
      return rows.length;
    } catch (err: unknown) {
      this.logger.error(
        `Outbox scan failed (retry next tick): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 0;
    } finally {
      this.scanning = false;
    }
  }

  /** 单行补投：无订阅即完成；失败退避/死信；成功终态。 */
  private async processRow(
    row: EventOutbox,
    subs: EventSubscription[],
  ): Promise<void> {
    const targets = subs.filter(
      (s) =>
        Array.isArray(s.eventTypes) && s.eventTypes.includes(row.eventType),
    );
    if (targets.length === 0) {
      // 当前订阅集无匹配者：快速路径此刻同样无人可投——视为投递完毕，
      // 回写终态避免 outbox 无限积压。
      await this.markDispatched(row);
      return;
    }
    const dispatcher = this.getDispatcher();
    if (!dispatcher) {
      // 派发面缺席（极简装配/降级）：无法投递也不计失败退避——保持未派发
      // 等派发面恢复后的下一轮扫描（at-least-once 语义不受损）。
      this.logger.warn(
        `Outbox row ${row.id} skipped: outbound dispatcher unavailable`,
      );
      return;
    }
    try {
      // 复用既有派发器（进程内重试语义含 SSRF 复核/退避/死信/统计）——
      // outbox 只负责「跨进程不丢」的兜底语义。
      const aggregate = await dispatcher.deliverToSubscribers(
        row.eventType,
        row.payload as never,
      );
      // Marking dispatched is only safe when every target is either delivered
      // or represented by a reliably persisted subscription dead letter. A
      // persistence failure (or an incomplete/malformed aggregate) keeps the
      // source row retryable so the event cannot disappear silently.
      const settledTargetCount =
        (aggregate?.deliveredCount ?? 0) + (aggregate?.deadLetteredCount ?? 0);
      const persistenceFailures = aggregate?.deadLetterPersistenceFailures ?? 0;
      const aggregateSettled =
        persistenceFailures === 0 &&
        (aggregate?.targetCount === 0 ||
          aggregate?.targetCount === settledTargetCount);
      if (!aggregateSettled) {
        this.logger.warn(
          `Outbox row ${row.id} kept retryable: delivery aggregate is not settled ` +
            `(targets=${aggregate?.targetCount ?? "unknown"}, settled=${settledTargetCount}, ` +
            `persistenceFailures=${persistenceFailures})`,
        );
        await this.handleFailure(
          row,
          new Error(
            `delivery aggregate unsettled (dead letter persistence failures: ${persistenceFailures})`,
          ),
        );
        return;
      }
      await this.markDispatched(row);
    } catch (err: unknown) {
      await this.handleFailure(row, err);
    }
  }

  /** 成功（或无订阅）终态：仅租约持有者可回写并释放租约。 */
  private async markDispatched(row: EventOutbox): Promise<void> {
    try {
      await this.outboxRepo.update(
        {
          id: row.id,
          dispatchedAt: IsNull(),
          deadLettered: false,
          leaseToken: row.leaseToken,
          leaseUntil: MoreThan(new Date()),
        },
        {
          dispatchedAt: new Date(),
          nextAttemptAt: null,
          leaseUntil: null,
          leaseToken: null,
        },
      );
    } catch (err: unknown) {
      // 终态回写失败：行保持未派发 → 下轮重投（at-least-once 允许重复）。
      this.logger.warn(
        `Outbox row ${row.id} dispatched but state write failed (will re-deliver): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** 失败路径：attempts+1、指数退避（封顶 5min）；超阈值落死信 + 行终态。 */
  private async handleFailure(row: EventOutbox, err: unknown): Promise<void> {
    const message = (err instanceof Error ? err.message : String(err)).slice(
      0,
      1024,
    );
    const attempts = (row.attempts ?? 0) + 1;
    if (attempts > MAX_OUTBOX_ATTEMPTS) {
      this.logger.warn(
        `Outbox row ${row.id} (${row.eventType}) dead-lettered after ${attempts} attempts: ${message}`,
      );
      // Persist the independent outbox dead letter first. Only after that
      // succeeds may the guarded source-row update make the event terminal.
      // This intentionally leaves the row retryable when persistence fails.
      try {
        await this.dataSource.transaction(async (manager) => {
          await manager.getRepository(EventOutboxDeadLetter).save(
            manager.getRepository(EventOutboxDeadLetter).create({
              outboxId: row.id,
              eventType: row.eventType,
              payload: row.payload,
              attempts,
              lastError: message,
              deadLetteredAt: new Date(),
            }),
          );
          const result = await manager.getRepository(EventOutbox).update(
            {
              id: row.id,
              dispatchedAt: IsNull(),
              deadLettered: false,
              leaseToken: row.leaseToken,
              leaseUntil: MoreThan(new Date()),
            },
            {
              deadLettered: true,
              attempts,
              nextAttemptAt: null,
              leaseUntil: null,
              leaseToken: null,
            },
          );
          if (result.affected !== 1) throw new StaleOutboxOwnerError();
        });
      } catch (dbErr: unknown) {
        if (dbErr instanceof StaleOutboxOwnerError) {
          this.logger.warn(
            `Outbox row ${row.id} dead-letter finalize skipped: lease lost`,
          );
          return;
        }
        this.logger.error(
          `Failed to persist/finalize outbox row ${row.id}: ${
            dbErr instanceof Error ? dbErr.message : String(dbErr)
          }`,
        );
        // The transaction rolls back both operations, leaving the source row
        // retryable and allowing a later scan to retry the dead-letter write.
      }
      return;
    }
    const delay = outboxRetryDelayMs(attempts);
    try {
      await this.outboxRepo.update(
        {
          id: row.id,
          dispatchedAt: IsNull(),
          deadLettered: false,
          leaseToken: row.leaseToken,
          leaseUntil: MoreThan(new Date()),
        },
        {
          attempts,
          nextAttemptAt: new Date(Date.now() + delay),
          leaseUntil: null,
          leaseToken: null,
        },
      );
    } catch (dbErr: unknown) {
      this.logger.warn(
        `Failed to back off outbox row ${row.id} (will retry next scan): ${
          dbErr instanceof Error ? dbErr.message : String(dbErr)
        }`,
      );
    }
  }

  /**
   * OutboundEventDispatcher 的派发入口改为「写 outbox 行」后（FEAT-19 接线），
   * 本服务提供统一的落库入口供其调用：行落库成功才算事件"已接收"——
   * 进程重启后由扫描补投，不丢。
   */
  async enqueue(
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<string | null> {
    if (!this.enabled) return null;
    try {
      const saved = await this.outboxRepo.save(
        this.outboxRepo.create({
          eventId: `${eventType}:${randomUUID()}`.slice(0, 64),
          eventType,
          payload,
          dispatchedAt: null,
          attempts: 0,
          nextAttemptAt: null,
          leaseUntil: null,
          leaseToken: null,
          deadLettered: false,
        }),
      );
      // 回传行 id：调用方（快速路径）全投成功时用它收口，避免补投扫描重复投递
      return saved.id ?? null;
    } catch (err: unknown) {
      // 落库失败：outbox 兜底失效——只记日志（fail-open，快速路径已尽力）。
      this.logger.error(
        `Failed to enqueue outbox row for "${eventType}" (in-flight only): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /**
   * 快速路径收口（FEAT-19 补强）：把该 outbox 行标记为已投递。
   *
   * 为什么需要：事件到达时既走内存快速路径、又落 outbox 兜底行；兜底行只有
   * 被收口或由扫描投递后才算结清——**不收口就等于每次成功事件都必然被补投
   * 扫描再投一遍**（订阅方流量翻倍 + 幂等压力）。快速路径全部订阅投递成功后
   * 调本方法把行结清，重复投递收敛为「部分失败/死信/租约竞态」三种情形。
   *
   * 并发安全：条件 UPDATE 带「无活跃租约」谓词——若补投扫描已 claim 该行
   * （leaseToken 非空且未过期）就**不抢**，让扫描按自己的语义完成投递；此时
   * 订阅方仍会收到一次重复（at-least-once，已在文档声明需幂等）。
   * 幂等：已 `dispatchedAt` 的行 affected=0，重复调用无副作用。
   */
  async markFastPathDelivered(rowId: string): Promise<boolean> {
    if (!this.enabled || !rowId) return false;
    try {
      const res = await this.outboxRepo
        .createQueryBuilder()
        .update(EventOutbox)
        .set({ dispatchedAt: () => "now()" })
        .where("id = :id", { id: rowId })
        .andWhere('"dispatchedAt" IS NULL')
        .andWhere('"deadLettered" = false')
        .andWhere('("leaseUntil" IS NULL OR "leaseUntil" <= now())')
        .execute();
      return (res.affected ?? 0) > 0;
    } catch (err: unknown) {
      // 旁路 best-effort：收口失败只记日志，扫描照旧会（重复）投递一次
      this.logger.warn(
        `Failed to settle fast-path outbox row ${rowId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }

  /** 测试/诊断辅助：当前重入锁状态。 */
  isScanning(): boolean {
    return this.scanning;
  }

  // ─── NETOPT-8②: 每日 retention（@Cron Leader 门禁） ─────────────────────

  /**
   * 每日 03:55 retention 清理；失败只记日志，等下一轮 cron 重试（与扫描
   * 互补：扫描管「未派发行的投递」，本任务管「终态行的堆积」）。
   */
  @Cron(OUTBOX_RETENTION_CRON)
  async handleDailyRetention(): Promise<void> {
    // ARCH-31 §5: 多实例下仅 cron Leader 执行
    if (this.leaderGate && !this.leaderGate.isLeader) return;
    try {
      const deleted = await this.cleanupDispatchedRows();
      if (deleted > 0) {
        this.logger.log(
          `NETOPT-8②: 清理 ${deleted} 行已派发超过 ${OUTBOX_DISPATCHED_RETENTION_DAYS} 天的 outbox 行`,
        );
      }
    } catch (err) {
      this.logger.error(
        `NETOPT-8②: dispatched 行 retention 清理失败: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    try {
      const deadDeleted = await this.cleanupExpiredDeadLetters();
      if (deadDeleted > 0) {
        this.logger.log(
          `NETOPT-8②: 清理 ${deadDeleted} 行超过 ${OUTBOX_DEAD_LETTER_RETENTION_DAYS} 天的 outbox 死信（含源行）`,
        );
      }
    } catch (err) {
      this.logger.error(
        `NETOPT-8②: outbox 死信 retention 清理失败: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * 清理 dispatchedAt 非空且早于保留期截止的 outbox 行，返回清理总行数。
   * 未派发行（dispatchedAt IS NULL，含 deadLettered 源行——它们由死信清理
   * 路径连带源行一起删）与近期行绝不在删除集内。分批 DELETE + 轮数/墙钟
   * 双闸（LOG-RETENTION-01），now 可注入便于测试。
   */
  async cleanupDispatchedRows(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(
      now.getTime() - OUTBOX_DISPATCHED_RETENTION_DAYS * 86_400_000,
    );
    return cappedBatchedDelete({
      batchSize: OUTBOX_RETENTION_BATCH_SIZE,
      logLabel: "NETOPT-8②",
      logger: this.logger,
      executeBatch: async () => {
        const result = await this.outboxRepo
          .createQueryBuilder()
          .delete()
          .where(
            `"id" IN (
              SELECT "victim"."id" FROM "event_outbox" "victim"
              WHERE "victim"."dispatchedAt" IS NOT NULL
                AND "victim"."dispatchedAt" < :cutoff
              ORDER BY "victim"."id"
              LIMIT :batchSize
            )`,
            { cutoff, batchSize: OUTBOX_RETENTION_BATCH_SIZE },
          )
          .execute();
        return result.affected ?? 0;
      },
    });
  }

  /**
   * 清理超过死信保留期的 event_outbox_dead_letters 行及其源 outbox 行，
   * 返回清理的死信行数。
   *
   * 期限取 90d（长于 dispatched 行的 30d）：死信 payload 是投递终败的唯一
   * 完整存档，供运维排查。与 event_subscription_dead_letters「用户可重放
   * 资产」（replay 端点存在、行删除即资产灭失）不同，outbox 死信没有 replay
   * 通路，仅作检查窗——90d 后随源行一起清。
   *
   * FK（dead_letters.outboxId → event_outbox.id，迁移 1790000000013）要求
   * 同一事务内先删死信行再删源行（先删源行会被 FK 拒绝），两删原子——
   * 半途失败整体回滚，下轮 cron 重试。now 可注入便于测试。
   */
  async cleanupExpiredDeadLetters(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(
      now.getTime() - OUTBOX_DEAD_LETTER_RETENTION_DAYS * 86_400_000,
    );
    return cappedBatchedDelete({
      batchSize: OUTBOX_RETENTION_BATCH_SIZE,
      logLabel: "NETOPT-8② dead-letter",
      logger: this.logger,
      executeBatch: async () => {
        const victims = await this.outboxDeadLetterRepo.find({
          select: ["id", "outboxId"],
          where: { deadLetteredAt: LessThan(cutoff) },
          order: { id: "ASC" },
          take: OUTBOX_RETENTION_BATCH_SIZE,
        });
        if (victims.length === 0) return 0;
        await this.dataSource.transaction(async (manager) => {
          await manager
            .getRepository(EventOutboxDeadLetter)
            .delete({ id: In(victims.map((v) => v.id)) });
          await manager
            .getRepository(EventOutbox)
            .delete({ id: In(victims.map((v) => v.outboxId)) });
        });
        return victims.length;
      },
    });
  }
}
