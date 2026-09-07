import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { BullModule } from "@nestjs/bullmq";
import { ExecutorController } from "./executor.controller";
import { ExecutorService } from "./executor.service";
import { Executor } from "./entities/executor.entity";
// FEAT-04: metrics history read side for GET /executors/:id/metrics `history`
import { ExecutorMetricsHistory } from "./entities/executor-metrics-history.entity";
import { Task } from "../task/entities/task.entity";
import { TaskExecution } from "../task/entities/task-execution.entity";
import { NotificationModule } from "../notification/notification.module";
import { SystemConfigModule } from "../config/config.module";
// SEC-02: dispatch 时解密 task.secrets 与 params 合并注入执行器 env
// （SecretsCryptoService 由 TaskModule export 提供，无需在此声明 provider）
import { TaskModule } from "../task/task.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Executor,
      Task,
      TaskExecution,
      ExecutorMetricsHistory,
    ]),
    BullModule.registerQueue({ name: "task-queue" }),
    NotificationModule,
    SystemConfigModule,
    // SEC-02: SecretsCryptoService 注入 TaskModule export 的单例（key
    // 生命周期全进程一致；本地 providers 声明在此冗余，勿加回）
    TaskModule,
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
