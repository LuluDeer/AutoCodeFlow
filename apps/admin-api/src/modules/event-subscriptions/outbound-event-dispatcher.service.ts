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
 * ② 内存快照待发订阅列表走首投 + 最多 3 次尝试指数退避（setTimeout 队列，
 * 纯进程内快速路径）→ 终败落 event_subscription_dead_letters + 更新订阅失败
 * 统计。两路并行：快速路径低延迟，outbox 兜底跨进程不丢。
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
import { DomainEventBus } from "../../common/services/domain-event-bus.service";
import {
  DOMAIN_EVENTS,
  DomainEventName,
} from "../../common/events/domain-events";
import { assertSafeHttpUrl } from "../../common/utils/safe-http.util";
import { EventSubscription } from "./entities/event-subscription.entity";
import { EventSubscriptionDeadLetter } from "./entities/event-subscription-dead-letter.entity";
import { EventSubscriptionService } from "./event-subscription.service";
import {
  buildEventPayload,
  MAX_DELIVERY_ATTEMPTS,
  OUTBOUND_TIMEOUT_MS,
  retryDelayMs,
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
  enqueue(eventType: string, payload: Record<string, unknown>): Promise<void>;
}

/**
 * Aggregate outcome of one outbox redelivery pass.  A dead letter counts as
 * settled only when its persistence succeeded; persistence failures remain
 * explicitly visible to the outbox caller so the source row stays retryable.
 */
export interface DeliveryAggregate {
  targetCount: number;
  deliveredCount: number;
  deadLetteredCount: number;
  deadLetterPersistenceFailures: number;
}

type DeliveryOutcome =
  | { kind: "delivered" }
  | { kind: "dead-lettered" }
  | { kind: "dead-letter-persistence-failure" };

@Injectable()
export class OutboundEventDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboundEventDispatcher.name);
  /** 在途重试 timer 句柄（模块销毁时统一 clearTimeout，优雅关闭）。 */
  private readonly pendingTimers = new Set<NodeJS.Timeout>();
  private readonly busListeners: Array<
    [DomainEventName, (p: unknown) => unknown]
  > = [];
  /** outbox 兜底面懒解析缓存：undefined=未解析，null=缺席。 */
  private resolvedOutbox: OutboxDispatcherLike | null | undefined;

  constructor(
    private readonly bus: DomainEventBus,
    private readonly subService: EventSubscriptionService,
    private readonly moduleRef: ModuleRef,
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
    for (const t of this.pendingTimers) clearTimeout(t);
    this.pendingTimers.clear();
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
    if (!(SUBSCRIBABLE_EVENTS as readonly string[]).includes(eventName)) return;
    const occurredAt = new Date().toISOString();
    const payload = buildEventPayload(
      eventName,
      (raw ?? {}) as Record<string, unknown>,
      occurredAt,
    );
    // FEAT-19: 先落 outbox 再走内存快速路径——落库成功即事件"已接收"，
    // 进程重启后由 OutboxDispatcher 扫描补投（at-least-once；落库失败仅记
    // 日志 fail-open，快速路径照常）。注意：快速路径成功 + outbox 也会被
    // 补投扫描再次投递 → 订阅方可能收到重复投递，必须幂等消费。
    const outbox = this.getOutbox();
    if (outbox) {
      await outbox.enqueue(
        eventName,
        payload as unknown as Record<string, unknown>,
      );
    }
    let subs: EventSubscription[];
    try {
      subs = await this.subRepo.find({
        where: { enabled: true },
        select: ["id", "url", "secret", "eventTypes", "consecutiveFailures"],
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
    await Promise.all(
      targets.map((sub) => this.deliverWithRetries(sub, eventName, payload)),
    );
  }

  /** 单订阅派发：首投 + 最多 3 次尝试指数退避 → 终败死信。 */
  private async deliverWithRetries(
    sub: EventSubscription,
    eventName: string,
    payload: ReturnType<typeof buildEventPayload>,
  ): Promise<DeliveryOutcome> {
    let lastError = "unknown error";
    for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        const delay = retryDelayMs(attempt - 1);
        await this.waitMs(delay);
      }
      try {
        await this.deliverOnce(sub, eventName, payload);
        await this.safeRecordSuccess(sub);
        return { kind: "delivered" };
      } catch (err: unknown) {
        lastError = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Outbound delivery attempt ${attempt}/${MAX_DELIVERY_ATTEMPTS} failed for subscription ${sub.id} (${eventName}): ${lastError}`,
        );
      }
    }
    return this.parkDeadLetter(sub, eventName, payload, lastError);
  }

  /** 单次投递：SSRF 复核（订阅 url 可能被并发 PATCH，出站前再验一次）→ 签名 POST。 */
  private async deliverOnce(
    sub: EventSubscription,
    eventName: string,
    payload: ReturnType<typeof buildEventPayload>,
  ): Promise<void> {
    try {
      await assertSafeHttpUrl(sub.url);
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
    await axios.post(sub.url, body, {
      timeout: OUTBOUND_TIMEOUT_MS,
      // 与 notification WebhookChannel 同纪律：禁 3xx 跟随——首跳是唯一经
      // SSRF 校验的地址，302 可把请求重定向到内网/元数据端点。
      maxRedirects: 0,
      headers: {
        "Content-Type": "application/json",
        "X-AutoCodeFlow-Event": eventName,
        "X-AutoCodeFlow-Timestamp": timestamp,
        "X-Hub-Signature-256": signature,
      },
      // axios 接收 string body 时按原样发送，避免二次序列化差异破坏签名。
      transformRequest: [(data) => data],
    });
  }

  /** 退避等待：进程内 timer，登记句柄供优雅关闭。 */
  private waitMs(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.pendingTimers.delete(t);
        resolve();
      }, ms);
      this.pendingTimers.add(t);
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

  /**
   * 终败：死信落库 + 订阅失败统计 + warn 日志。
   *
   * The persistence result is part of the outcome.  The outbox caller must not
   * mark its source row dispatched when this write failed, otherwise the event
   * would be lost while the subscription dead-letter API still has no record.
   */
  private async parkDeadLetter(
    sub: EventSubscription,
    eventName: string,
    payload: ReturnType<typeof buildEventPayload>,
    lastError: string,
  ): Promise<DeliveryOutcome> {
    const error = lastError.slice(0, 1024);
    this.logger.warn(
      `Outbound delivery to subscription ${sub.id} (${eventName}) dead-lettered after ${MAX_DELIVERY_ATTEMPTS} attempts: ${error}`,
    );
    let persisted = false;
    try {
      await this.deadLetterRepo.save(
        this.deadLetterRepo.create({
          subscriptionId: sub.id,
          eventType: eventName,
          payload: payload as unknown as Record<string, unknown>,
          error,
          attempts: MAX_DELIVERY_ATTEMPTS,
        }),
      );
      persisted = true;
    } catch (err: unknown) {
      this.logger.error(
        `Failed to persist dead letter for subscription ${sub.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    try {
      await this.subService.recordDeliveryFailure(sub, error);
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to update failure stats for subscription ${sub.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return persisted
      ? { kind: "dead-lettered" }
      : { kind: "dead-letter-persistence-failure" };
  }

  // ─── FEAT-19: outbox 补投复用的派发面 ──────────────────────────────────────

  /**
   * 给定事件与完整出站信封，对当前 enabled 订阅中匹配该事件的每一订阅执行
   * 同款派发（含 3 次退避 + 死信 + 失败统计）。
   *
   * OutboxDispatcher 扫描补投时调用：复用既有 deliverWithRetries（签名/SSRF
   * 复核/超时纪律/死信语义零复制）。任一订阅失败不外抛（deliverWithRetries
   * 已兜底为死信落库）——本方法拒绝（reject）仅当订阅快照读取失败（DB 抖动
   * 等），由 outbox 侧行退避重试。
   */
  async deliverToSubscribers(
    eventName: string,
    payload: ReturnType<typeof buildEventPayload>,
  ): Promise<DeliveryAggregate> {
    let subs: EventSubscription[];
    try {
      subs = await this.subRepo.find({
        where: { enabled: true },
        select: ["id", "url", "secret", "eventTypes", "consecutiveFailures"],
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
      return {
        targetCount: 0,
        deliveredCount: 0,
        deadLetteredCount: 0,
        deadLetterPersistenceFailures: 0,
      };
    }
    const outcomes = await Promise.all(
      targets.map((sub) => this.deliverWithRetries(sub, eventName, payload)),
    );
    return {
      targetCount: targets.length,
      deliveredCount: outcomes.filter((o) => o.kind === "delivered").length,
      deadLetteredCount: outcomes.filter((o) => o.kind === "dead-lettered")
        .length,
      deadLetterPersistenceFailures: outcomes.filter(
        (o) => o.kind === "dead-letter-persistence-failure",
      ).length,
    };
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

  /** 测试辅助：当前在途 timer 数。 */
  pendingTimerCount(): number {
    return this.pendingTimers.size;
  }
}
