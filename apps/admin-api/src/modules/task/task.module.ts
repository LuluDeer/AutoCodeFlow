import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { BullModule } from "@nestjs/bullmq";
import { TaskController } from "./task.controller";
import { TaskBatchController } from "./task-batch.controller";
import { ExecutionCallbackController } from "./execution-callback.controller";
import { ExecutionCallbackMetricsService } from "./execution-callback-metrics.service";
import { TaskService } from "./task.service";
import { TaskProcessor } from "./task.processor";
import { Task } from "./entities/task.entity";
import { TaskExecution } from "./entities/task-execution.entity";
import { ExecutionLogLine } from "./entities/execution-log-line.entity";
import { TaskVersion } from "./entities/task-version.entity";
import { LogRetentionCleanupService } from "./log-retention/log-retention-cleanup.service"; // Stream D/DB-002
import { ExecutorModule } from "../executor/executor.module";
import { AiModule } from "../ai/ai.module";
import { NotificationModule } from "../notification/notification.module";
import { AuditModule } from "../audit/audit.module";
import { SchedulerModule } from "../scheduler/scheduler.module";
import { SystemConfigModule } from "../config/config.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Task,
      TaskExecution,
      ExecutionLogLine,
      TaskVersion,
    ]),
    BullModule.registerQueue({ name: "task-queue" }),
    ExecutorModule,
    AiModule,
    NotificationModule,
    AuditModule,
    forwardRef(() => SchedulerModule),
    SystemConfigModule,
  ],
  controllers: [
    TaskController,
    TaskBatchController,
    ExecutionCallbackController,
  ],
  providers: [
    TaskService,
    TaskProcessor,
    LogRetentionCleanupService,
    // N32: callback 401 分类计数（controller 埋点，MetricsModule 的
    // Prometheus 抓取端读取快照——单一实例经 exports 共享）。
    ExecutionCallbackMetricsService,
  ],
  exports: [TaskService, ExecutionCallbackMetricsService],
})
export class TaskModule {}
