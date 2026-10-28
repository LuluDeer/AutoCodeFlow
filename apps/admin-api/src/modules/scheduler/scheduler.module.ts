import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { BullModule } from "@nestjs/bullmq";
import { ScheduleModule } from "@nestjs/schedule";
import { SchedulerService } from "./scheduler.service";
import { SchedulerMetricsService } from "./scheduler-metrics.service";
import { Task } from "../task/entities/task.entity";
import { TaskExecution } from "../task/entities/task-execution.entity";
import { TaskModule } from "../task/task.module";
import { ExecutorModule } from "../executor/executor.module";
import { RedisLockService } from "../../common/services/redis-lock.service";
import { EventLoopLagService } from "../../common/metrics/event-loop-lag.service";

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([Task, TaskExecution]),
    BullModule.registerQueue({ name: "task-queue" }),
    forwardRef(() => TaskModule),
    // P2: stale sweep 重试兑现需要 ExecutorService（预算判定 / 与 restart
    // 路径共享的重试模式 / kill 通知）。ExecutorModule 不依赖 Scheduler/Task
    // 模块，无循环。
    ExecutorModule,
  ],
  providers: [
    SchedulerService,
    SchedulerMetricsService,
    RedisLockService,
    // INCIDENT-2026-10-28（P1-2）：事件循环阻塞监控。放这里是因为它消费
    // SchedulerMetricsService（同模块，无额外依赖），且与调度域的可观测性
    // 同属一组。
    EventLoopLagService,
  ],
  exports: [
    SchedulerService,
    SchedulerMetricsService,
    RedisLockService,
    EventLoopLagService,
  ],
})
export class SchedulerModule {}
