import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Application } from "./entities/application.entity";
import { AppDeployment } from "./entities/app-deployment.entity";
import { ApplicationVersion } from "./entities/application-version.entity";
// MUTEX-01：互斥组配置实体（组 CRUD + 应用挂组）。
import { MutexGroup } from "./entities/mutex-group.entity";
import { ApplicationService } from "./application.service";
import { ApplicationController } from "./application.controller";
import { AppDeploymentService } from "./app-deployment.service";
import { AppDeploymentController } from "./app-deployment.controller";
import { MutexGroupService } from "./mutex-group.service";
import { MutexGroupController } from "./mutex-group.controller";
import { TaskModule } from "../task/task.module";
import { ExecutorModule } from "../executor/executor.module";
import { AiModule } from "../ai/ai.module";
// DEP-04: 审批决策审计（deployment.approve/reject/cancel 留痕）。
import { AuditModule } from "../audit/audit.module";
// DEEP-AUDIT B·4.3: 应用删除的执行器清理扇出失败附通知（NotificationModule
// 无环：仅依赖 AuditModule/TypeOrm/Config，不回指 application 域）。
import { NotificationModule } from "../notification/notification.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Application,
      AppDeployment,
      ApplicationVersion,
      MutexGroup,
    ]),
    forwardRef(() => TaskModule),
    ExecutorModule,
    AiModule,
    AuditModule,
    NotificationModule,
  ],
  controllers: [
    ApplicationController,
    AppDeploymentController,
    MutexGroupController,
  ],
  providers: [ApplicationService, AppDeploymentService, MutexGroupService],
  exports: [ApplicationService, AppDeploymentService],
})
export class ApplicationModule {}
