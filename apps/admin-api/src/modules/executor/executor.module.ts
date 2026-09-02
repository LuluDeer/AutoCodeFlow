import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { BullModule } from "@nestjs/bullmq";
import { ExecutorController } from "./executor.controller";
import { ExecutorService } from "./executor.service";
import { Executor } from "./entities/executor.entity";
import { Task } from "../task/entities/task.entity";
import { TaskExecution } from "../task/entities/task-execution.entity";
import { NotificationModule } from "../notification/notification.module";
import { SystemConfigModule } from "../config/config.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([Executor, Task, TaskExecution]),
    BullModule.registerQueue({ name: "task-queue" }),
    NotificationModule,
    SystemConfigModule,
  ],
  // 注：原 InstallCmdController 与 ExecutorController 重复注册了
  // GET /executors/install-cmd（前者运行时不可达），已作为死代码删除，
  // 其 shell 转义实现合并进 ExecutorService.getInstallCmd()。
  controllers: [ExecutorController],
  // ConfigService is global (ConfigModule.forRoot isGlobal:true) so no extra import needed
  providers: [ExecutorService],
  exports: [ExecutorService],
})
export class ExecutorModule {}
