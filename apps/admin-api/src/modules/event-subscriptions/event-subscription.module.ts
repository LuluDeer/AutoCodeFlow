import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { EventSubscription } from "./entities/event-subscription.entity";
import { EventSubscriptionDeadLetter } from "./entities/event-subscription-dead-letter.entity";
import { EventSubscriptionService } from "./event-subscription.service";
import { EventSubscriptionController } from "./event-subscription.controller";
import { OutboundEventDispatcher } from "./outbound-event-dispatcher.service";

/**
 * FEAT-07: 出站事件订阅模块（新独占模块）。
 *
 * 依赖方向单向：本模块只消费 @Global 的 DomainEventBus（ADR-011 接入形态——
 * 注册 execution.* / executor.offline / deployment.completed 监听器，事件源
 * task.service / executor.service / app-deployment.service 零改动、零感知）。
 * 无任何业务模块反向依赖本模块，不成环。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([EventSubscription, EventSubscriptionDeadLetter]),
  ],
  controllers: [EventSubscriptionController],
  providers: [EventSubscriptionService, OutboundEventDispatcher],
  exports: [EventSubscriptionService],
})
export class EventSubscriptionModule {}
