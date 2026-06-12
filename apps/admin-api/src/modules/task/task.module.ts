import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { BullModule } from "@nestjs/bull";
import { TaskController } from "./task.controller";
import { TaskBatchController } from "./task-batch.controller";
import { ExecutionCallbackController } from "./execution-callback.controller";
import { TaskService } from "./task.service";
import { TaskProcessor } from "./task.processor";
import { Task } from "./entities/task.entity";
import { TaskExecution } from "./entities/task-execution.entity";
import { ExecutionLogLine } from "./entities/execution-log-line.entity";
import { TaskVersion } from "./entities/task-version.entity";
import { ExecutorModule } from "../executor/executor.module";
import { AiModule } from "../ai/ai.module";
import { NotificationModule } from "../notification/notification.module";
import { AuditModule } from "../audit/audit.module";
import { SchedulerModule } from "../scheduler/scheduler.module";

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
  ],
  controllers: [TaskController, TaskBatchController, ExecutionCallbackController],
  providers: [TaskService, TaskProcessor],
  exports: [TaskService],
})
export class TaskModule {}
