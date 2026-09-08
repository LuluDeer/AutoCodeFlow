import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Application } from "./entities/application.entity";
import { AppDeployment } from "./entities/app-deployment.entity";
import { ApplicationVersion } from "./entities/application-version.entity";
import { ApplicationService } from "./application.service";
import { ApplicationController } from "./application.controller";
import { AppDeploymentService } from "./app-deployment.service";
import { AppDeploymentController } from "./app-deployment.controller";
import { TaskModule } from "../task/task.module";
import { ExecutorModule } from "../executor/executor.module";
import { AiModule } from "../ai/ai.module";
// DEP-04: 审批决策审计（deployment.approve/reject/cancel 留痕）。
import { AuditModule } from "../audit/audit.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([Application, AppDeployment, ApplicationVersion]),
    forwardRef(() => TaskModule),
    ExecutorModule,
    AiModule,
    AuditModule,
  ],
  controllers: [ApplicationController, AppDeploymentController],
  providers: [ApplicationService, AppDeploymentService],
  exports: [ApplicationService, AppDeploymentService],
})
export class ApplicationModule {}
