import { Global, Module } from "@nestjs/common";
import { DomainEventBus } from "./domain-event-bus.service";
import { ExecutionEventsRelayService } from "./execution-events-relay.service";

/**
 * 第四轮审计（A3）: 领域事件模块装配。
 *
 * 从 domain-event-bus.service.ts 拆出的原因：bus.ts 的 providers 引 relay、
 * relay.ts 的 DI 元数据引 bus——两文件互相 import 成环，e2e（AppModule 全量
 * boot）的模块求值顺序下 relay 在类求值期拿到 undefined 的 bus，
 * `design:paramtypes[0]` 变 undefined → Nest "can't resolve dependencies
 * of the ExecutionEventsRelayService"。单测的 import 顺序碰巧不触发，CI 的
 * api-types-drift（swagger:export 真起 AppModule）抓到。装配单独成文件后：
 * relay.ts → bus.ts 单向，本文件 → 两者，环消失。
 */

@Global()
@Module({
  providers: [DomainEventBus, ExecutionEventsRelayService],
  exports: [DomainEventBus, ExecutionEventsRelayService],
})
export class DomainEventModule {}
