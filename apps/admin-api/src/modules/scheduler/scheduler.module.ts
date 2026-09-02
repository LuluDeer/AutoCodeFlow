import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { BullModule } from "@nestjs/bullmq";
import { ScheduleModule } from "@nestjs/schedule";
import { SchedulerService } from "./scheduler.service";
import { SchedulerMetricsService } from "./scheduler-metrics.service";
import { Task } from "../task/entities/task.entity";
import { TaskExecution } from "../task/entities/task-execution.entity";
import { TaskModule } from "../task/task.module";
import { RedisLockService } from "../../common/services/redis-lock.service";

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([Task, TaskExecution]),
    BullModule.registerQueue({ name: "task-queue" }),
    forwardRef(() => TaskModule),
  ],
  providers: [SchedulerService, SchedulerMetricsService, RedisLockService],
  exports: [SchedulerService, SchedulerMetricsService, RedisLockService],
})
export class SchedulerModule {}
