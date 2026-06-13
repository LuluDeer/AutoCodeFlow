import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ExecutorController } from "./executor.controller";
import { ExecutorService } from "./executor.service";
import { InstallCmdController } from "./install-cmd.controller";
import { Executor } from "./entities/executor.entity";
import { Task } from "../task/entities/task.entity";
import { TaskExecution } from "../task/entities/task-execution.entity";
import { NotificationModule } from "../notification/notification.module";
import { SystemConfigModule } from "../config/config.module";

@Module({
  imports: [TypeOrmModule.forFeature([Executor, Task, TaskExecution]), NotificationModule, SystemConfigModule],
  controllers: [ExecutorController, InstallCmdController],
  // ConfigService is global (ConfigModule.forRoot isGlobal:true) so no extra import needed
  providers: [ExecutorService],
  exports: [ExecutorService],
})
export class ExecutorModule {}
