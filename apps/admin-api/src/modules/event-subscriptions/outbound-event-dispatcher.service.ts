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
 * at-least-once 决策（进程内最低正确形态）：事件到达即同步快照待发订阅列表，
 * 首投 + 最多 3 次尝试指数退避（setTimeout 队列，纯进程内）→ 终败落
 * event_subscription_dead_letters + 更新订阅失败统计。进程重启即丢在途重试
 * （at-most-once for in-flight retries）——跨进程 outbox 属后续轮。
 */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { createHmac } from "node:crypto";
import { setTimeout as sleepSetTimeout } from "node:timers/promises";
import axios from "axios";
import { Repository, In } from "typeorm";
import { DomainEventBus } from "../../common/services/domain-event-bus.service";
import {
  DOMAIN_EVENTS,
  DomainEventName,
  ExecutionTerminalEventPayload,
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

@Injectable()
export class OutboundEventDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboundEventDispatcher.name);
  /** 在途重试 timer 句柄（模块销毁时统一 clearTimeout，优雅关闭）。 */
  private readonly pendingTimers = new Set<NodeJS.Timeout>();
  private readonly busListeners: Array<
    [DomainEventName, (p: unknown) => unknown]
  > = [];

  constructor(
    private readonly bus: DomainEventBus,
    private readonly subService: EventSubscriptionService,
    @InjectRepository(EventSubscription)
    private readonly subRepo: Repository<EventSubscription>,
    @InjectRepository(EventSubscriptionDeadLetter)
    private readonly deadLetterRepo: Repository<EventSubscriptionDeadLetter>,
  ) {}

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

  /** 事件入口：快照匹配订阅 → 每订阅独立派发（含重试）。 */
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
    const targets = subs.filter((s) => subscriptionMatches(s.eventTypes, eventName));
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
  ): Promise<void> {
    let lastError = "unknown error";
    for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        const delay = retryDelayMs(attempt - 1);
        await this.waitMs(delay);
      }
      try {
        await this.deliverOnce(sub, eventName, payload);
        await this.safeRecordSuccess(sub);
        return;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Outbound delivery attempt ${attempt}/${MAX_DELIVERY_ATTEMPTS} failed for subscription ${sub.id} (${eventName}): ${lastError}`,
        );
      }
    }
    await this.parkDeadLetter(sub, eventName, payload, lastError);
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
        .update(Buffer.concat([Buffer.from(`${timestamp}.`), Buffer.from(body, "utf8")]))
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

  /** 终败：死信落库 + 订阅失败统计 + warn 日志（全部兜底，不再外抛）。 */
  private async parkDeadLetter(
    sub: EventSubscription,
    eventName: string,
    payload: ReturnType<typeof buildEventPayload>,
    lastError: string,
  ): Promise<void> {
    const error = lastError.slice(0, 1024);
    this.logger.warn(
      `Outbound delivery to subscription ${sub.id} (${eventName}) dead-lettered after ${MAX_DELIVERY_ATTEMPTS} attempts: ${error}`,
    );
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
      await this.deliverOnce(
        subscription,
        deadLetter.eventType,
        payload,
      );
    } catch (err: unknown) {
      const error = (err instanceof Error ? err.message : String(err)).slice(0, 1024);
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
