import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ConfigModule } from "@nestjs/config";
import { TaskExecution } from "../task/entities/task-execution.entity";
import { ExecutorModule } from "../executor/executor.module";
import { SystemConfigModule } from "../config/config.module";
import { ArtifactsService } from "./artifacts.service";
import { ArtifactsController } from "./artifacts.controller";
import { ArtifactsRetentionService } from "./artifacts-retention.service";
// ARTIFACTS-INDEX-46: 产物元数据索引表（GET /artifacts 查询面 + 回调写点双轨写）。
import { ExecutionArtifactRow } from "./entities/execution-artifact.entity";
// A-2: 下载成功路径的 artifact.download 审计落证（AuditService 注入面）
import { AuditModule } from "../audit/audit.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([TaskExecution, ExecutionArtifactRow]),
    ExecutorModule,
    ConfigModule,
    SystemConfigModule,
    AuditModule,
  ],
  controllers: [ArtifactsController],
  providers: [ArtifactsService, ArtifactsRetentionService],
  exports: [ArtifactsService],
})
export class ArtifactsModule {}
