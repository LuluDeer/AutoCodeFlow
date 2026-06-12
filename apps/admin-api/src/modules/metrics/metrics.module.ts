import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Task } from "../task/entities/task.entity";
import { TaskExecution } from "../task/entities/task-execution.entity";
import { Executor } from "../executor/entities/executor.entity";
import { ExecutionReport } from "./entities/execution-report.entity";
import { MetricsService } from "./metrics.service";
import { MetricsController } from "./metrics.controller";

@Module({
  imports: [
    TypeOrmModule.forFeature([Task, TaskExecution, Executor, ExecutionReport]),
  ],
  providers: [MetricsService],
  controllers: [MetricsController],
})
export class MetricsModule {}
