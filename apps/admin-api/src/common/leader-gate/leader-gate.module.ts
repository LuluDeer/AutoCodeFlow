import { Global, Module } from "@nestjs/common";
import { SchedulerModule } from "../../modules/scheduler/scheduler.module";
import { LeaderGateService } from "./leader-gate.service";

/**
 * ARCH-31 §5: cron 维护任务统一 Leader 门禁模块（@Global——门禁遍布
 * executor/task/application/artifacts/audit/auth 等模块，各模块无需逐一 import；
 * 先例同 TracingModule）。
 *
 * RedisLockService 由 SchedulerModule 提供（providers + exports），本模块
 * import SchedulerModule 复用同一实例/同一 Redis 客户端——绝不重复注册
 * RedisLockService（那会创建第二个 ioredis 连接）。
 */
@Global()
@Module({
  imports: [SchedulerModule],
  providers: [LeaderGateService],
  exports: [LeaderGateService],
})
export class LeaderGateModule {}
