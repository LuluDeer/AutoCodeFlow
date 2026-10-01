/**
 * FEAT-07: 出站事件派发器。
 *
 * 接入形态（ADR-011）：注册 domain bus 监听器消费事件，主链零改动。
 * 总线 fail-open（监听器抛错不影响 emit 方），本派发器内部再逐订阅兜底：
 * 任何单订阅的签名/HTTP/落库失败都不影响其他订阅，更不影响事件源。
 *
 * 签名约定（与 applications 发版 webhook 入站校验逐字节一致，订阅方按此校验）：
 * - POST url，Content-Type: application/json
 * - X-AutoCodeFlow-Event: 事件名（如 execution.failed）
 * - X-AutoCodeFlow-Timestamp: 毫秒时间戳（订阅方应校验 ±5min 窗）
 * - X-Hub-Signature-256: "sha256=" + hex(HMAC-SHA256(secret, `${timestamp}.${rawBody}`))
 *   ——注意签名输入是 `${timestamp}.` 前缀拼接**原始请求体字节**，与
 *   application.controller.ts webhook 端点的 expected 计算完全一致。
 *
 * at-least-once 决策（FEAT-19 升级为跨进程 outbox 兜底）：事件到达即
 * ① 同步落一行 event_outbox（OutboxDispatcher.enqueue，写成功即事件"已接收"
 * ——进程重启不丢，OutboxDispatcher 周期扫描补投，at-least-once，订阅方幂等），
 * ② 内存快照待发订阅列表走**单次首投**。
 *
 * ARCH-31 #8 收口（2026-09-27）：快速路径不再做进程内重试（原 3 次尝试 +
 * setTimeout 退避的 pendingTimers 是纯实例状态——崩溃丢重试、与扫描器并存
 * 时有重复投递窗口）。首投失败即把行留给 outbox 扫描器：重试/退避/死信全部
 * 归扫描器的租约 + attempts 机制（跨进程、崩溃安全）。终败时扫描器负责把
 * 订阅死信（运维面，可重放）与独立 outbox 死信（归档）都写齐。
 */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { InjectRepository } from "@nestjs/typeorm";
import { createHmac } from "node:crypto";
import axios from "axios";
import { Repository } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { DomainEventBus } from "../../common/services/domain-event-bus.service";
import {
  DOMAIN_EVENTS,
  DomainEventName,
  EVENT_SCHEMA_VERSION,
} from "../../common/events/domain-events";
import {
  assertAndPinHttpUrl,
  PinnedHttpTarget,
  pinnedAxiosConfig,
} from "../../common/utils/safe-http.util";
import { EventSubscription } from "./entities/event-subscription.entity";
import { EventSubscriptionDeadLetter } from "./entities/event-subscription-dead-letter.entity";
import { EventSubscriptionService } from "./event-subscription.service";
import {
  buildEventPayload,
  OUTBOUND_TIMEOUT_MS,
  SUBSCRIBABLE_EVENTS,
  subscriptionMatches,
} from "./event-subscription.util";

/**
 * FEAT-19 依赖方向说明：OutboxDispatcher（补投方）复用本类派发面；本类对
 * OutboxDispatcher 只经令牌引用（OUTBOX_DISPATCHER_TOKEN，刻意不 import 其
 * 模块——循环依赖会让 TS 的 design:paramtypes 在模块求值序的不利侧拿到
 * undefined，Nest 解析报错；先例/机理见 task.service↔executor.service 的
 * forwardRef 注释）。**令牌不做构造器注入**（useFactory 别名互相等对方实体
 * 会在 DI graph 上成解析期环，Nest 挂死）——改经 ModuleRef 运行时懒取，
 * 首次用到 enqueue 才解析；令牌缺席按 null 降级（FEAT-07 原行为）。
 */
export const OUTBOX_DISPATCHER_TOKEN = Symbol("OUTBOX_DISPATCHER_TOKEN");

/** OutboxDispatcher 的结构最小面（本类消费的入口），避免 import 其模块。 */
export interface OutboxDispatcherLike {
  /**
   * 落一行 outbox（跨进程兜底）。返回**行 id**（落库失败/未启用时 null）——
   * 快速路径全成功后用它收口该行，避免补投扫描再投一遍。
   */
  enqueue(
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<string | null>;
  /**
   * 快速路径收口：把该行标记为已投递（`dispatchedAt`）。条件 UPDATE 保证
   * 「无活跃租约」才收口——补投扫描正在处理这一行时不抢（此时重复投递仍是
   * at-least-once 的既定语义）。可选：老实现缺席时退化为「照旧可能重复」。
   */
  markFastPathDelivered?(rowId: string): Promise<boolean>;
}

/**
 * Aggregate outcome of one outbox redelivery pass.  A dead letter counts as
 * settled only when its persistence succeeded; persistence failures remain
 * explicitly visible to the outbox caller so the source row stays retryable.
 */
export interface DeliveryAggregate {
  targetCount: number;
  deliveredCount: number;
  /**
   * ARCH-31 #8 单次投递语义下本调用**不再产生**死信（终败死信由扫描器
   * 经 deadLetterToSubscribers 落运维面）——恒为 0，保留字段仅为扫描器
   * 聚合消费面的接口稳定。
   */
  deadLetteredCount: number;
}

@Injectable()
export class OutboundEventDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboundEventDispatcher.name);
  /** 在途重试 timer 句柄（模块销毁时统一 clearTimeout，优雅关闭）。 */
  private readonly busListeners: Array<
    [DomainEventName, (p: unknown) => unknown]
  > = [];
  /** outbox 兜底面懒解析缓存：undefined=未解析，null=缺席。 */
  private resolvedOutbox: OutboxDispatcherLike | null | undefined;

  constructor(
    private readonly bus: DomainEventBus,
    private readonly subService: EventSubscriptionService,
    private readonly moduleRef: ModuleRef,
    private readonly config: ConfigService,
    @InjectRepository(EventSubscription)
    private readonly subRepo: Repository<EventSubscription>,
    @InjectRepository(EventSubscriptionDeadLetter)
    private readonly deadLetterRepo: Repository<EventSubscriptionDeadLetter>,
  ) {}

  /**
   * 运行时懒取 outbox 兜底面（见类头注释：构造器注入令牌会成解析期环）。
   * 经 ModuleRef 解析 OUTBOX_DISPATCHER_TOKEN（模块 useFactory 别名到真实
   * OutboxDispatcher）；令牌缺席/取不到时按 null 降级（FEAT-07 原行为）。
   */
  private getOutbox(): OutboxDispatcherLike | null {
    if (this.resolvedOutbox === undefined) {
      try {
        this.resolvedOutbox =
          this.moduleRef?.get<OutboxDispatcherLike>(OUTBOX_DISPATCHER_TOKEN, {
            strict: false,
          }) ?? null;
      } catch {
        this.resolvedOutbox = null;
      }
    }
    return this.resolvedOutbox;
  }

  onModuleInit(): void {
    // 幂等护栏：本实例经 OUTBOUND_DISPATCHER_TOKEN useFactory 别名后在同一
    // 模块的 provider 表里挂了两个 wrapper，Nest 生命周期迭代器对每个暴露
    // onModuleInit 的 wrapper 都会调一次——重复 init 会把总线监听器注册翻倍
    // （后果：每个出站事件被派发两次、outbox 行双写，test:arch31-outbox-dup
    // 真机实证）。二次 init 在此短路。
    if (this.busListeners.length > 0) return;
    this.subscribe(DOMAIN_EVENTS.EXECUTION_COMPLETED);
    this.subscribe(DOMAIN_EVENTS.EXECUTION_FAILED);
    // FEAT-07 补的发布点：executor.service 三路 OFFLINE 翻转 /
    // app-deployment.service 心跳确认 RUNNING 落库后 emit。总线同刻无发布点
    // 时订阅是纯 no-op，发布点补上即自动生效。
    this.subscribe(DOMAIN_EVENTS.EXECUTOR_OFFLINE);
    this.subscribe(DOMAIN_EVENTS.DEPLOYMENT_COMPLETED);
  }

  onModuleDestroy(): void {
    for (const [event, listener] of this.busListeners) {
      this.bus.off(event, listener);
    }
    this.busListeners.length = 0;
  }

  private subscribe(eventName: DomainEventName): void {
    const listener = (payload: unknown): void => {
      // dispatchAsync 内部全程兜底（逐订阅 try/catch），此处再包一层保险丝。
      try {
        this.dispatch(eventName, payload);
      } catch (err: unknown) {
        this.logger.error(
          `Outbound dispatch setup for "${eventName}" failed (fail-open): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    };
    this.bus.on(eventName, listener);
    this.busListeners.push([eventName, listener]);
  }

  /** 事件入口：落 outbox（跨进程兜底）→ 快照匹配订阅 → 每订阅独立派发（含重试）。 */
  private async dispatch(
    eventName: DomainEventName,
    raw: unknown,
  ): Promise<void> {
    // 第四轮审计（A3）: 跨实例 relay 补发的载荷跳过——outbox 行与首投在起源
    // 实例本地 emit 时已执行，多副本下不跳过 = 双份 webhook（viaRelay 契约见
    // execution-events-relay.service.ts）。
    if ((raw as { viaRelay?: boolean } | null)?.viaRelay) return;
    if (!(SUBSCRIBABLE_EVENTS as readonly string[]).includes(eventName)) return;
    const occurredAt = new Date().toISOString();
    const payload = buildEventPayload(
      eventName,
      (raw ?? {}) as Record<string, unknown>,
      occurredAt,
    );
    // FEAT-19: 先落 outbox 再走内存快速路径——落库成功即事件"已接收"，
    // 进程重启后由 OutboxDispatcher 扫描补投（at-least-once；落库失败仅记
    // 日志 fail-open，快速路径照常）。
    //
    // 收口（本轮）：快速路径**全部订阅都投递成功**时，把 outbox 行标记为已
    // 投递——否则补投扫描必然再投一遍（不是"可能重复"，而是**每次成功事件都
    // 重复投一次**，订阅方平白承担双倍流量）。部分失败/死信时**不收口**：
    // 这一行必须留给扫描重试，代价是已成功的订阅会再收一次（at-least-once
    // 的既定语义，订阅方仍需幂等）。收口本身是旁路 best-effort，失败只记日志。
    const outbox = this.getOutbox();
    let outboxRowId: string | null = null;
    if (outbox) {
      outboxRowId = await outbox.enqueue(
        eventName,
        payload as unknown as Record<string, unknown>,
      );
    }
    let subs: EventSubscription[];
    try {
      subs = await this.subRepo.find({
        where: { enabled: true },
        select: {
          id: true,
          url: true,
          secret: true,
          eventTypes: true,
          consecutiveFailures: true,
        },
      });
    } catch (err: unknown) {
      // 订阅表读失败：出站是旁路，fail-open 吞掉（总线已是 fail-open，双保险）。
      this.logger.error(
        `Outbound dispatch "${eventName}": failed to load subscriptions (skip): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    const targets = subs.filter((s) =>
      subscriptionMatches(s.eventTypes, eventName),
    );
    if (targets.length === 0) return;
    this.logger.log(
      `Outbound event "${eventName}" → ${targets.length} subscription(s)`,
    );
    // ARCH-31 #8：首投一次，不进程内重试——失败即交棒 outbox 扫描器
    // （重试/退避/死信的单一事实源，跨进程崩溃安全）。
    const outcomes = await Promise.all(
      targets.map((sub) => this.deliverOnceAndRecord(sub, eventName, payload)),
    );
    const deliveredCount = outcomes.filter(Boolean).length;
    // 全部订阅都投递成功才收口 outbox 行（部分失败必须留给扫描重试）
    if (outboxRowId && deliveredCount === targets.length) {
      try {
        await outbox?.markFastPathDelivered?.(outboxRowId);
      } catch (err: unknown) {
        this.logger.warn(
          `Outbox fast-path settle failed for row ${outboxRowId} (scan will redeliver): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } else {
      this.logger.warn(
        `Outbound event "${eventName}": ${targets.length - deliveredCount}/${
          targets.length
        } delivery failed on fast path — outbox scanner owns retries`,
      );
    }
  }

  /** 首投一次 + 成功统计。失败上抛（调用方聚合；重试归 outbox 扫描器）。 */
  private async deliverOnceAndRecord(
    sub: EventSubscription,
    eventName: string,
    payload: ReturnType<typeof buildEventPayload>,
  ): Promise<boolean> {
    try {
      await this.deliverOnce(sub, eventName, payload);
      await this.safeRecordSuccess(sub);
      return true;
    } catch (err: unknown) {
      this.logger.warn(
        `Outbound delivery failed for subscription ${sub.id} (${eventName}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }

  /** 单次投递：SSRF 复核（订阅 url 可能被并发 PATCH，出站前再验一次）→ 签名 POST。 */
  private async deliverOnce(
    sub: EventSubscription,
    eventName: string,
    payload: ReturnType<typeof buildEventPayload>,
  ): Promise<void> {
    let pinned: PinnedHttpTarget;
    try {
      // ARCH-31（2026-09-13）: 出站前 SSRF 复核带私网豁免开关（与订阅创建/
      // 更新校验同源 eventWebhook.allowPrivateNetwork——开关关闭时内网 url
      // 在创建面就会被拒，此处兜底并发 PATCH 进来的内网地址）。
      // F-3（SEC-NEW）: 复核同时把目标 pin 到校验通过的 IP（Host/SNI 保留），
      // 关闭 DNS rebinding 窗口。
      pinned = await assertAndPinHttpUrl(sub.url, {
        allowPrivateNetwork:
          this.config.get<boolean>("eventWebhook.allowPrivateNetwork") === true,
      });
    } catch (err: unknown) {
      // 订阅 url 被 SSRF 拒：确定性失败，重试无意义，直接终败。
      throw new Error(
        `URL rejected by SSRF policy: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const body = JSON.stringify(payload);
    const timestamp = Date.now().toString();
    const signature =
      "sha256=" +
      createHmac("sha256", sub.secret)
        .update(
          Buffer.concat([
            Buffer.from(`${timestamp}.`),
            Buffer.from(body, "utf8"),
          ]),
        )
        .digest("hex");
    const pinCfg = pinnedAxiosConfig(pinned);
    // 原始 URL 原样传给 axios（new URL 归一化会加尾部斜杠，破坏订阅方 URL 的
    // 字节级契约）；pin 由 pinCfg 的 agent.lookup 完成。
    await axios.post(sub.url, body, {
      timeout: OUTBOUND_TIMEOUT_MS,
      // 与 notification WebhookChannel 同纪律：禁 3xx 跟随——首跳是唯一经
      // SSRF 校验的地址，302 可把请求重定向到内网/元数据端点。
      maxRedirects: 0,
      headers: {
        "Content-Type": "application/json",
        "X-AutoCodeFlow-Event": eventName,
        // PK-14: 载荷 schema 主版本（与信封体 schemaVersion 同值），订阅方
        // 据此在 HTTP 头层快速识别载荷形状演进，无需先解 body。
        "X-AutoCodeFlow-Event-Version": String(
          payload.schemaVersion ?? EVENT_SCHEMA_VERSION,
        ),
        "X-AutoCodeFlow-Timestamp": timestamp,
        "X-Hub-Signature-256": signature,
      },
      ...pinCfg,
      // axios 接收 string body 时按原样发送，避免二次序列化差异破坏签名。
      transformRequest: [(data) => data],
    });
  }

  private async safeRecordSuccess(sub: EventSubscription): Promise<void> {
    try {
      await this.subService.recordDeliverySuccess(sub);
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to reset failure stats for subscription ${sub.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // ─── FEAT-19: outbox 补投复用的派发面 ──────────────────────────────────────

  /**
   * 给定事件与完整出站信封，对当前 enabled 订阅中匹配该事件的每一订阅执行
   * **单次**派发（签名/SSRF 复核/超时纪律与快速路径同源）。
   *
   * OutboxDispatcher 扫描补投时调用（ARCH-31 #8：重试节奏由扫描器的
   * 租约 + attempts 机制统一持有，本方法不再做进程内退避/死信）。失败不
   * 外抛、计入 deliveredCount 缺口——由 outbox 侧行退避重试；终败死信
   * 由扫描器经 deadLetterToSubscribers 落运维面。本方法拒绝（reject）仅当
   * 订阅快照读取失败（DB 抖动等），由 outbox 侧行退避重试。
   */
  async deliverToSubscribers(
    eventName: string,
    payload: ReturnType<typeof buildEventPayload>,
  ): Promise<DeliveryAggregate> {
    let subs: EventSubscription[];
    try {
      subs = await this.subRepo.find({
        where: { enabled: true },
        select: {
          id: true,
          url: true,
          secret: true,
          eventTypes: true,
          consecutiveFailures: true,
        },
      });
    } catch (err: unknown) {
      throw new Error(
        `Outbound redeliver "${eventName}": failed to load subscriptions: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const targets = subs.filter((s) =>
      subscriptionMatches(s.eventTypes, eventName),
    );
    if (targets.length === 0) {
      return { targetCount: 0, deliveredCount: 0, deadLetteredCount: 0 };
    }
    const outcomes = await Promise.all(
      targets.map((sub) => this.deliverOnceAndRecord(sub, eventName, payload)),
    );
    return {
      targetCount: targets.length,
      deliveredCount: outcomes.filter(Boolean).length,
      deadLetteredCount: 0,
    };
  }

  /**
   * 终败死信落运维面（OutboxDispatcher 扫描在行终态时调用，ARCH-31 #8）：
   * 对当前匹配该事件的每个 enabled 订阅写一条 event_subscription_dead_letters
   * （运维死信列表 + 手动重放的数据源）并累计失败统计。逐订阅 fail-open：
   * 单条失败只记日志，不影响其他订阅与行终态（独立 outbox 死信已由扫描器
   * 先行落库归档）。
   */
  async deadLetterToSubscribers(
    eventName: string,
    payload: ReturnType<typeof buildEventPayload>,
    error: string,
    attempts: number,
  ): Promise<{ targetCount: number; deadLetteredCount: number }> {
    let subs: EventSubscription[];
    try {
      subs = await this.subRepo.find({
        where: { enabled: true },
        select: {
          id: true,
          url: true,
          secret: true,
          eventTypes: true,
          consecutiveFailures: true,
        },
      });
    } catch (err: unknown) {
      this.logger.error(
        `Terminal dead-letter "${eventName}": failed to load subscriptions (operator surface missed): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { targetCount: 0, deadLetteredCount: 0 };
    }
    const targets = subs.filter((s) =>
      subscriptionMatches(s.eventTypes, eventName),
    );
    let deadLettered = 0;
    for (const sub of targets) {
      try {
        await this.deadLetterRepo.save(
          this.deadLetterRepo.create({
            subscriptionId: sub.id,
            eventType: eventName,
            payload: payload as unknown as Record<string, unknown>,
            error: error.slice(0, 1024),
            attempts,
          }),
        );
        deadLettered += 1;
      } catch (err: unknown) {
        this.logger.error(
          `Failed to persist dead letter for subscription ${sub.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      try {
        await this.subService.recordDeliveryFailure(sub, error.slice(0, 1024));
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to update failure stats for subscription ${sub.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return { targetCount: targets.length, deadLetteredCount: deadLettered };
  }

  // ─── replay（controller 经 service 校验属主后调用）──────────────────────────
  /**
   * 手动重放一行死信：以订阅当前 url/secret 重新签名派发**一次**（不自动重试
   * ——人工动作，失败原因直接返回给调用方）。成功返回 true；失败返回错误
   * 文本且死信保留（供再次重放）。
   */
  async replayDeadLetter(
    subscription: EventSubscription,
    deadLetter: EventSubscriptionDeadLetter,
  ): Promise<{ ok: boolean; error?: string }> {
    const payload = deadLetter.payload as unknown as ReturnType<
      typeof buildEventPayload
    >;
    try {
      await this.deliverOnce(subscription, deadLetter.eventType, payload);
    } catch (err: unknown) {
      const error = (err instanceof Error ? err.message : String(err)).slice(
        0,
        1024,
      );
      await this.subService
        .recordDeliveryFailure(subscription, error)
        .catch(() => undefined);
      return { ok: false, error };
    }
    try {
      await this.subService.recordDeliverySuccess(subscription);
    } catch {
      /* stats best-effort */
    }
    await this.subService.deleteDeadLetter(deadLetter.id);
    return { ok: true };
  }
}
