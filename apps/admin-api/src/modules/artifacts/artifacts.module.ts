import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ConfigModule } from "@nestjs/config";
import { TaskExecution } from "../task/entities/task-execution.entity";
import { ExecutorModule } from "../executor/executor.module";
import { SystemConfigModule } from "../config/config.module";
import { ArtifactsService } from "./artifacts.service";
import { ArtifactsController } from "./artifacts.controller";
import { ArtifactsRetentionService } from "./artifacts-retention.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([TaskExecution]),
    ExecutorModule,
    ConfigModule,
    SystemConfigModule,
  ],
  controllers: [ArtifactsController],
  providers: [ArtifactsService, ArtifactsRetentionService],
  exports: [ArtifactsService],
})
export class ArtifactsModule {}
