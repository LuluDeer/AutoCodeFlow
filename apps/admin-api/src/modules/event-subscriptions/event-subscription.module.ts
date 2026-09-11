import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { EventSubscription } from "./entities/event-subscription.entity";
import { EventSubscriptionDeadLetter } from "./entities/event-subscription-dead-letter.entity";
import { EventOutbox } from "./entities/event-outbox.entity";
import { EventOutboxDeadLetter } from "./entities/event-outbox-dead-letter.entity";
import { EventSubscriptionService } from "./event-subscription.service";
import { EventSubscriptionController } from "./event-subscription.controller";
import {
  OutboundEventDispatcher,
  OUTBOX_DISPATCHER_TOKEN,
} from "./outbound-event-dispatcher.service";
import {
  OutboxDispatcher,
  OUTBOUND_DISPATCHER_TOKEN,
} from "./outbox-dispatcher.service";

/**
 * FEAT-07: 出站事件订阅模块（新独占模块）。
 *
 * 依赖方向单向：本模块只消费 @Global 的 DomainEventBus（ADR-011 接入形态——
 * 注册 execution.* / executor.offline / deployment.completed 监听器，事件源
 * task.service / executor.service / app-deployment.service 零改动、零感知）。
 * 无任何业务模块反向依赖本模块，不成环。
 *
 * FEAT-19: 新增 OutboxDispatcher（event_outbox 落库 + 周期扫描补投）——
 * OutboundEventDispatcher 派发入口同步落 outbox 行（跨进程 at-least-once
 * 兜底），补投复用其 deliverToSubscribers 派发面。两服务互不 import（循环
 * import 会让 TS design:paramtypes 在模块求值不利侧为 undefined，Nest 解析
 * 失败/挂起）：各自经 Symbol 令牌 @Optional 注入对方，此处用 useFactory
 * 把令牌别名到真实实例——DI 图无环、同实例。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      EventSubscription,
      EventSubscriptionDeadLetter,
      EventOutbox,
      EventOutboxDeadLetter,
    ]),
  ],
  controllers: [EventSubscriptionController],
  providers: [
    EventSubscriptionService,
    OutboundEventDispatcher,
    OutboxDispatcher,
    // 令牌别名：OutboundEventDispatcher @Optional @Inject(OUTBOX_DISPATCHER_TOKEN)
    // 拿到同一 OutboxDispatcher 实例（落 outbox 行）。
    {
      provide: OUTBOX_DISPATCHER_TOKEN,
      useFactory: (d: OutboxDispatcher) => d,
      inject: [OutboxDispatcher],
    },
    // 令牌别名：OutboxDispatcher @Optional @Inject(OUTBOUND_DISPATCHER_TOKEN)
    // 拿到同一 OutboundEventDispatcher 实例（补投复用派发面）。
    {
      provide: OUTBOUND_DISPATCHER_TOKEN,
      useFactory: (d: OutboundEventDispatcher) => d,
      inject: [OutboundEventDispatcher],
    },
  ],
  exports: [EventSubscriptionService],
})
export class EventSubscriptionModule {}
