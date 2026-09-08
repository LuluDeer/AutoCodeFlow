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
 *   MAX_OUTBOX_ATTEMPTS 落 event_subscription_dead_letters 并置
 *   deadLettered=true（行终态）。进程重启后扫描自然恢复——不丢任何已落库
 *   待投事件（at-least-once；订阅方须幂等）。
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
  Inject,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { IsNull, LessThan, Repository } from "typeorm";
import { randomUUID } from "node:crypto";
import { EventSubscription } from "./entities/event-subscription.entity";
import { EventOutbox } from "./entities/event-outbox.entity";
import { EventSubscriptionDeadLetter } from "./entities/event-subscription-dead-letter.entity";
import {
  MAX_OUTBOX_ATTEMPTS,
  OUTBOX_RETRY_BASE_DELAY_MS,
  outboxRetryDelayMs,
} from "./event-subscription.util";

/** 扫描间隔（毫秒）。 */
export const OUTBOX_SCAN_INTERVAL_MS = 5_000;
/** 单轮扫描最多取行数（防积压瞬间打满出站）。 */
export const OUTBOX_BATCH_SIZE = 50;

/**
 * FEAT-19 依赖方向说明（与 OUTBOX_DISPATCHER_TOKEN 对称）：OutboundEventDispatcher
 * （快速路径）import 本类做构造器注入同样会成环——环上两处注入全部走令牌：
 * - 本服务 → OutboundEventDispatcher：OUTBOUND_DISPATCHER_TOKEN（@Optional，
 *   缺席时补投跳过投递、仅回写终态——测试/降级场景安全）。
 * - OutboundEventDispatcher → 本服务：OUTBOX_DISPATCHER_TOKEN（@Optional，
 *   缺席时只走内存快速路径——FEAT-07 原行为）。
 * 两令牌在本模块 providers 中以 useFactory 别名到真实实例，DI 图无环。
 */
export const OUTBOUND_DISPATCHER_TOKEN = Symbol("OUTBOUND_DISPATCHER_TOKEN");

/** OutboundEventDispatcher 的结构最小面（本服务消费的入口）。 */
interface OutboundDispatcherLike {
  deliverToSubscribers(
    eventName: string,
    payload: { event: string; occurredAt: string; data: Record<string, unknown> },
  ): Promise<void>;
}

@Injectable()
export class OutboxDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxDispatcher.name);
  private scanTimer: NodeJS.Timeout | null = null;
  /** 重入锁：上一轮扫描未结束时跳过本轮（串行化补投，降低重复投递窗口）。 */
  private scanning = false;
  private readonly enabled: boolean;

  constructor(
    @Optional()
    @Inject(OUTBOUND_DISPATCHER_TOKEN)
    private readonly dispatcher: OutboundDispatcherLike | null,
    private readonly configService: ConfigService,
    @InjectRepository(EventOutbox)
    private readonly outboxRepo: Repository<EventOutbox>,
    @InjectRepository(EventSubscription)
    private readonly subRepo: Repository<EventSubscription>,
    @InjectRepository(EventSubscriptionDeadLetter)
    private readonly deadLetterRepo: Repository<EventSubscriptionDeadLetter>,
  ) {
    // ConfigService 缺席（极简单测装配）时按默认开启兜底。
    this.enabled =
      this.configService?.get<boolean>("eventOutbox.enabled") !== false;
  }

  onModuleInit(): void {
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
      // 应投 = 未派发 + 非死信 + （无退避指针 或 退避指针已到期）。
      // TypeORM where 数组=OR 语义；每个分支自带 deadLettered=false 守卫。
      const now = new Date();
      const rows = await this.outboxRepo.find({
        where: [
          {
            dispatchedAt: IsNull(),
            deadLettered: false,
            nextAttemptAt: IsNull(),
          },
          {
            dispatchedAt: IsNull(),
            deadLettered: false,
            nextAttemptAt: LessThan(now),
          },
        ],
        order: { createdAt: "ASC" },
        take: OUTBOX_BATCH_SIZE,
      });
      for (const row of rows) {
        try {
          await this.processRow(row);
        } catch (err: unknown) {
          // 单行失败隔离：记日志继续下一行（processRow 内部已兜底，这里是
          // 最外层保险丝）。
          this.logger.warn(
            `Outbox row ${row.id} (${row.eventType}) processing failed (skip): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
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
  private async processRow(row: EventOutbox): Promise<void> {
    const subs = await this.subRepo.find({
      where: { enabled: true },
      select: ["id", "eventTypes"],
    });
    const targets = subs.filter((s) =>
      Array.isArray(s.eventTypes) && s.eventTypes.includes(row.eventType),
    );
    if (targets.length === 0) {
      // 当前订阅集无匹配者：快速路径此刻同样无人可投——视为投递完毕，
      // 回写终态避免 outbox 无限积压。
      await this.markDispatched(row);
      return;
    }
    if (!this.dispatcher) {
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
      await this.dispatcher.deliverToSubscribers(
        row.eventType,
        row.payload as never,
      );
      await this.markDispatched(row);
    } catch (err: unknown) {
      await this.handleFailure(row, err);
    }
  }

  /** 成功（或无订阅）终态：回写 dispatchedAt、清退避指针。 */
  private async markDispatched(row: EventOutbox): Promise<void> {
    try {
      await this.outboxRepo.update(
        { id: row.id },
        { dispatchedAt: new Date(), nextAttemptAt: null },
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
      // 终态回写与死信落库解耦：先收敛行（不再扫描），死信落库 best-effort
      // ——dead_letters.subscriptionId 有 FK（哨兵 id 无对应订阅行时插入被
      // 拒），若两者同 try，死信失败会拖住终态导致该行无限重投。
      try {
        await this.outboxRepo.update(
          { id: row.id },
          { deadLettered: true, attempts, nextAttemptAt: null },
        );
      } catch (dbErr: unknown) {
        this.logger.error(
          `Failed to finalize outbox row ${row.id}: ${
            dbErr instanceof Error ? dbErr.message : String(dbErr)
          }`,
        );
      }
      try {
        await this.deadLetterRepo.save(
          this.deadLetterRepo.create({
            subscriptionId: OutboxDispatcher.OUTBOX_SUBSCRIPTION_ID,
            eventType: row.eventType,
            payload: row.payload,
            error: message,
            attempts,
          }),
        );
      } catch (dbErr: unknown) {
        this.logger.error(
          `Failed to persist outbox dead letter for row ${row.id}: ${
            dbErr instanceof Error ? dbErr.message : String(dbErr)
          }`,
        );
      }
      return;
    }
    const delay = outboxRetryDelayMs(attempts);
    try {
      await this.outboxRepo.update(
        { id: row.id },
        {
          attempts,
          nextAttemptAt: new Date(Date.now() + delay),
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
  ): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.outboxRepo.save(
        this.outboxRepo.create({
          eventId: `${eventType}:${randomUUID()}`.slice(0, 64),
          eventType,
          payload,
          dispatchedAt: null,
          attempts: 0,
          nextAttemptAt: null,
          deadLettered: false,
        }),
      );
    } catch (err: unknown) {
      // 落库失败：outbox 兜底失效——只记日志（fail-open，快速路径已尽力）。
      this.logger.error(
        `Failed to enqueue outbox row for "${eventType}" (in-flight only): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** 测试/诊断辅助：当前重入锁状态。 */
  isScanning(): boolean {
    return this.scanning;
  }

  /**
   * outbox 死信的归属标记：outbox 行不属于任何单一订阅（按事件落库，逐行
   * 投给多个订阅），落 event_subscription_dead_letters 需要一个 subscriptionId
   * ——用全零 uuid 哨兵（不在 FK 校验范围内则依赖调用方自行处理；PG 侧
   * dead_letters 表有 FK，无对应订阅行时插入会被拒——落库失败仅记日志，
   * outbox 行由 deadLettered 终态自行收敛，语义不受影响）。
   */
  static readonly OUTBOX_SUBSCRIPTION_ID =
    "00000000-0000-4000-8000-000000000000";
}
