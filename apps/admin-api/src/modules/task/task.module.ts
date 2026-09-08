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
// OBS-04: execution_reports 读侧（metrics 模块实体跨模块注册——TypeORM
// forFeature 只取连接与元数据，无运行时依赖环；MetricsModule 同样只注册）
import { ExecutionReport } from "../metrics/entities/execution-report.entity";
import { LogRetentionCleanupService } from "./log-retention/log-retention-cleanup.service"; // Stream D/DB-002
import { ExecutorModule } from "../executor/executor.module";
import { AiModule } from "../ai/ai.module";
import { NotificationModule } from "../notification/notification.module";
import { AuditModule } from "../audit/audit.module";
import { SchedulerModule } from "../scheduler/scheduler.module";
import { SystemConfigModule } from "../config/config.module";
// SEC-02: 任务级 secrets 落库加密（无状态 provider，task/executor 两模块共用）
import { SecretsCryptoService } from "../../common/utils/secret-crypto.util.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Task,
      TaskExecution,
      ExecutionLogLine,
      TaskVersion,
      // OBS-04: 执行报告读侧（execution_reports 表；写方 MetricsService）
      ExecutionReport,
    ]),
    BullModule.registerQueue({ name: "task-queue" }),
    // forwardRef：SEC-02 起 ExecutorModule 反向 import 本模块（取
    // SecretsCryptoService export），与既有 ExecutorModule 引用成环——
    // 两端模块级 forwardRef 解开（详见 executor.module 同位置注释）。
    forwardRef(() => ExecutorModule),
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
    // SEC-02: secrets 加密服务（Key 生命周期：env SEC_SECRETS_KEY，未配置降级明文）
    SecretsCryptoService,
    LogRetentionCleanupService,
    // N32: callback 401 分类计数（controller 埋点，MetricsModule 的
    // Prometheus 抓取端读取快照——单一实例经 exports 共享）。
    ExecutionCallbackMetricsService,
  ],
  exports: [TaskService, ExecutionCallbackMetricsService, SecretsCryptoService],
})
export class TaskModule {}
