import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { BullModule } from "@nestjs/bullmq";
import { Task } from "../task/entities/task.entity";
import { TaskExecution } from "../task/entities/task-execution.entity";
import { Executor } from "../executor/entities/executor.entity";
import { ExecutionReport } from "./entities/execution-report.entity";
import { MetricsService } from "./metrics.service";
import { PrometheusMetricsService } from "./prometheus-metrics.service";
import { MetricsController } from "./metrics.controller";
import { MetricsStreamController } from "./metrics-stream.controller";
// FEAT-16：执行列表终态推送流（事件转发自 ARCH-21 DomainEventBus，零 DB 查询）
import { ExecutionsStreamController } from "./executions-stream.controller";
import { MetricsStreamSlotService } from "./metrics-stream-slot.service";
import { SchedulerModule } from "../scheduler/scheduler.module";
import { TaskModule } from "../task/task.module";

/**
 * BullModule.registerQueue 与 task/scheduler 模块同名注册（BullMQ 允许
 * 多处注册同一队列名，共享同一底层连接配置），用于读取队列深度 gauge。
 * SchedulerModule（forwardRef）提供 SchedulerService：进程内调度计数器
 * 与 getSchedulerMetrics/getQueueDepth 的唯一事实来源；无模块环
 * （无任何模块反向依赖 MetricsModule）。
 * N32: TaskModule 提供 ExecutionCallbackMetricsService（callback 401 分类
 * 计数的唯一实例，controller 埋点 → 本模块 Prometheus 快照映射）。
 * TaskModule 及其依赖链均不引用 MetricsModule，普通 import 无环。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Task, TaskExecution, Executor, ExecutionReport]),
    BullModule.registerQueue({ name: "task-queue" }),
    forwardRef(() => SchedulerModule),
    TaskModule,
  ],
  providers: [
    MetricsService,
    PrometheusMetricsService,
    MetricsStreamSlotService,
  ],
  controllers: [
    MetricsController,
    MetricsStreamController,
    ExecutionsStreamController,
  ],
  exports: [MetricsService, PrometheusMetricsService],
})
export class MetricsModule {}
