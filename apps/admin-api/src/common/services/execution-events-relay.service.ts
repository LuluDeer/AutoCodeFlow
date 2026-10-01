import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomBytes } from "node:crypto";
import Redis from "ioredis";
import { DomainEventBus } from "./domain-event-bus.service";
import {
  DOMAIN_EVENTS,
  DomainEventName,
  ExecutionTerminalEventPayload,
} from "../events/domain-events";

/**
 * 第四轮审计（A3）: 执行终态事件的**跨实例 relay**（Redis pub/sub 广播）。
 *
 * ## 要解决的问题
 * 领域事件总线是进程内的：handleCallback / killExecution 只在**处理回调的那
 * 一个实例**上 emit。HA 多副本下，连接在另一副本上的 GET /executions/stream
 * SSE 客户端永远收不到 execution.completed/failed/killed——终态推送漏事件，
 * 页面只能退化为轮询。
 *
 * ## 形态（对齐 ExecutorTokenCacheSyncService 的双连接 pub/sub 先例）
 * - 发布侧：本服务订阅本地总线三个终态事件，任何一条 emit 都 PUBLISH 到
 *   固定 channel（信封带本进程 instanceId）。fire-and-forget fail-open：
 *   PUBLISH 失败只 warn，不影响主链（主链早已落库完毕——事件即既成事实）。
 * - 订阅侧：每实例订阅同一 channel；收到**非本实例**的消息后向本地总线
 *   补发同一载荷（`viaRelay: true` 标记）——SSE 控制器等订阅方零改动；
 *   本实例自己的消息按 instanceId 去重跳过（本地 emit 已派发过，避免双投）。
 *   订阅态连接不能再执行普通命令，故订阅/发布各占一条独立连接（惰性创建）。
 *
 * ## 副作用恰好一次（viaRelay 契约）
 * 终态事件的**副作用订阅方**（通知 ExecutionEventsListener、出站 webhook
 * OutboundEventDispatcher、Agent 触发 AgentTriggerService）在起源实例本地
 * emit 时已经执行；relay 补发只服务于「跨实例读面」（SSE）。因此三者对
 * `viaRelay === true` 的载荷直接跳过，否则多副本下双倍告警/双份 outbox。
 * relay 自身对补发进总线的事件也不再二次广播（防回声环）。
 *
 * ## Redis 不可用（fail-open）
 * 单实例语义与改造前完全一致（本地 emit → 本地 SSE）；订阅端初始化/订阅
 * 失败、PUBLISH 失败一律 warn 不抛。恢复后 ioredis 自动重放 subscribe。
 */

export const EXECUTION_EVENTS_RELAY_CHANNEL = "acf:execution-events:relay";

/** relay 覆盖的终态事件（与 SSE 流转发面一致；只增不改——载荷形状同族）。 */
const RELAYED_EVENTS: readonly DomainEventName[] = [
  DOMAIN_EVENTS.EXECUTION_COMPLETED,
  DOMAIN_EVENTS.EXECUTION_FAILED,
  DOMAIN_EVENTS.EXECUTION_KILLED,
];

/** Redis 信封（pub/sub 消息体）。 */
interface RelayEnvelope {
  instanceId: string;
  event: string;
  payload: ExecutionTerminalEventPayload;
}

@Injectable()
export class ExecutionEventsRelayService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ExecutionEventsRelayService.name);
  /** 本进程标识：只用于过滤自己广播的消息（随机即可，无需跨重启稳定）。 */
  private readonly instanceId = randomBytes(12).toString("hex");
  private subscriber: Redis | null = null;
  private publisher: Redis | null = null;
  private readonly busListeners: Array<
    [DomainEventName, (payload: ExecutionTerminalEventPayload) => unknown]
  > = [];
  private destroyed = false;

  constructor(
    private readonly bus: DomainEventBus,
    private readonly config: ConfigService,
  ) {}

  /** 测试缝：发布端连接（enableOfflineQueue=false——迟到的终态推送没有意义）。 */
  protected createPublisherClient(): Redis {
    return new Redis({
      host: this.config.get("redis.host"),
      port: this.config.get<number>("redis.port"),
      password: this.config.get("redis.password"),
      db: this.config.get<number>("redis.db", 0),
      commandTimeout: 3000,
      retryStrategy: (times) => Math.min(times * 100, 3000),
      enableOfflineQueue: false,
      // ARCH-005: REDIS_TLS=true 时对齐 BullMQ 连接的 TLS 语义。
      ...(this.config.get("redis.tls") === true
        ? {
            tls: {
              rejectUnauthorized:
                this.config.get("redis.tlsRejectUnauthorized") !== false,
            },
          }
        : {}),
    });
  }

  /** 测试缝：订阅端连接（subscribe 模式独占连接；重连后 ioredis 自动重放）。 */
  protected createSubscriberClient(): Redis {
    return new Redis({
      host: this.config.get("redis.host"),
      port: this.config.get<number>("redis.port"),
      password: this.config.get("redis.password"),
      db: this.config.get<number>("redis.db", 0),
      retryStrategy: (times) => Math.min(times * 100, 3000),
      ...(this.config.get("redis.tls") === true
        ? {
            tls: {
              rejectUnauthorized:
                this.config.get("redis.tlsRejectUnauthorized") !== false,
            },
          }
        : {}),
    });
  }

  onModuleInit(): void {
    // ① 总线侧：终态事件 → Redis 广播。viaRelay 载荷不再二次广播
    // （防回声环：补发进总线的事件由本监听器再发一次 = 无限循环）。
    for (const eventName of RELAYED_EVENTS) {
      const listener = (payload: ExecutionTerminalEventPayload): void => {
        if (payload?.viaRelay) return;
        void this.publish(eventName, payload);
      };
      this.bus.on(eventName, listener);
      this.busListeners.push([eventName, listener]);
    }

    // ② Redis 侧：远端消息 → 本地总线补发。任何失败只 warn（fail-open）。
    try {
      this.subscriber = this.createSubscriberClient();
      this.subscriber.on("error", (err: Error) => {
        this.logger.warn(
          `execution-events relay 订阅连接错误（fail-open，单实例语义不变）: ${err.message}`,
        );
      });
      this.subscriber.on("message", (channel: string, raw: string) => {
        if (channel !== EXECUTION_EVENTS_RELAY_CHANNEL) return;
        this.handleRemoteMessage(raw);
      });
      void this.subscriber
        .subscribe(EXECUTION_EVENTS_RELAY_CHANNEL)
        .catch((err: Error) => {
          this.logger.warn(
            `execution-events relay 订阅失败（fail-open，跨实例终态推送退化为仅本实例）: ${err.message}`,
          );
        });
    } catch (err: unknown) {
      this.logger.warn(
        `execution-events relay 订阅端初始化失败（fail-open）: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    for (const [event, listener] of this.busListeners) {
      this.bus.off(event, listener);
    }
    this.busListeners.length = 0;
    for (const client of [this.publisher, this.subscriber]) {
      if (client) {
        try {
          void client.quit().catch(() => client.disconnect());
        } catch {
          client.disconnect();
        }
      }
    }
    this.publisher = null;
    this.subscriber = null;
  }

  /** 广播终态事件到 Redis。fire-and-forget：任何失败只 warn（fail-open）。 */
  private async publish(
    eventName: DomainEventName,
    payload: ExecutionTerminalEventPayload,
  ): Promise<void> {
    if (this.destroyed) return;
    try {
      if (!this.publisher || this.publisher.status === "end") {
        this.publisher = this.createPublisherClient();
        this.publisher.on("error", (err: Error) => {
          this.logger.warn(
            `execution-events relay 发布连接错误（fail-open）: ${err.message}`,
          );
        });
      }
      const envelope: RelayEnvelope = {
        instanceId: this.instanceId,
        event: eventName,
        payload,
      };
      await this.publisher.publish(
        EXECUTION_EVENTS_RELAY_CHANNEL,
        JSON.stringify(envelope),
      );
    } catch (err: unknown) {
      this.logger.warn(
        `execution-events relay 广播失败（其他实例走轮询兜底）: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 远端消息 → 本地总线补发。解析/校验失败一律忽略（记 warn）。 */
  private handleRemoteMessage(raw: string): void {
    try {
      const parsed = JSON.parse(raw) as Partial<RelayEnvelope>;
      // 自身消息去重：本实例 emit 已在本地派发过（含全部副作用订阅方）。
      if (parsed.instanceId === this.instanceId) return;
      if (
        typeof parsed.event !== "string" ||
        !RELAYED_EVENTS.includes(parsed.event as DomainEventName) ||
        typeof parsed.payload !== "object" ||
        parsed.payload === null
      ) {
        return;
      }
      const payload: ExecutionTerminalEventPayload = {
        ...parsed.payload,
        viaRelay: true,
      };
      this.bus.emit(parsed.event as DomainEventName, payload);
    } catch (err: unknown) {
      this.logger.warn(
        `execution-events relay 消息解析失败（忽略）: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
