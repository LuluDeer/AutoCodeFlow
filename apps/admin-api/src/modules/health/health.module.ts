import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { BullModule } from "@nestjs/bullmq";
import { ConfigModule } from "@nestjs/config";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";
import { Task } from "../task/entities/task.entity";
import { Executor } from "../executor/entities/executor.entity";
import { TaskExecution } from "../task/entities/task-execution.entity";

@Module({
  imports: [
    TypeOrmModule.forFeature([Task, Executor, TaskExecution]),
    BullModule.registerQueue({ name: "task-queue" }),
    ConfigModule,
  ],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
