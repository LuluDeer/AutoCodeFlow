/**
 * R309（TTFV §7.6 第 2 条）：install_completed 漏斗埋点 listener。
 *
 * 订阅 executor.registered（executor.service 首次注册落库后 emit，已派生匿名
 * installId），经 FunnelEventsService 写入漏斗事实表的 install 分母。事件载荷
 * 无设备指纹，故无需回查执行器；不进跨实例 relay 白名单，viaRelay 仅作防御性
 * 过滤。opt-in 单一闸门在 funnel.record 内，本 listener 不重复判定。
 *
 * 副作用 listener 全程 fail-open：缺数据诚实跳过（不伪造 ID/时间），任何写入
 * 异常只 warn，绝不回灌总线或注册主链。
 */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";

import {
  DOMAIN_EVENTS,
  ExecutorRegisteredEventPayload,
} from "../../../common/events/domain-events";
import { DomainEventBus } from "../../../common/services/domain-event-bus.service";
import { FunnelEventsService } from "./funnel-events.service";

@Injectable()
export class FunnelInstallListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FunnelInstallListener.name);

  constructor(
    private readonly bus: DomainEventBus,
    private readonly funnel: FunnelEventsService,
  ) {}

  onModuleInit(): void {
    this.bus.on(DOMAIN_EVENTS.EXECUTOR_REGISTERED, this.onRegistered);
  }

  onModuleDestroy(): void {
    this.bus.off(DOMAIN_EVENTS.EXECUTOR_REGISTERED, this.onRegistered);
  }

  onRegistered = async (
    event: ExecutorRegisteredEventPayload,
  ): Promise<void> => {
    try {
      // 防御性：新事件不在 RELAYED_EVENTS 白名单（纯本地），但多副本语义一旦
      // 演进也不得让非起源实例重复写 install 分母。
      if (
        (event as ExecutorRegisteredEventPayload & { viaRelay?: boolean })
          ?.viaRelay
      ) {
        return;
      }
      // 缺数据诚实跳过：installId 是服务端 HMAC 派生结果，空值不得伪造。
      if (!event?.installId) return;
      const ts = new Date(event.observedAt);
      if (Number.isNaN(ts.getTime())) return;

      await this.funnel.record({
        installId: event.installId,
        eventName: "install_completed",
        dedupeKey: `install-completed:${event.installId}`,
        ts,
      });
    } catch (err: unknown) {
      this.logger.warn(
        `TTFV install_completed listener failed for ${
          event?.installId ?? "?"
        }: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
}
