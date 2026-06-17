import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ConfigModule } from "@nestjs/config";
import { ExecutorPackage } from "./executor-package.entity";
import { ExecutorPackageService } from "./executor-package.service";
import { ExecutorPackageController } from "./executor-package.controller";
import { ExecutorModule } from "../executor/executor.module";
import { SystemConfigModule } from "../config/config.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([ExecutorPackage]),
    ExecutorModule,
    ConfigModule,
    SystemConfigModule,
  ],
  controllers: [ExecutorPackageController],
  providers: [ExecutorPackageService],
  exports: [ExecutorPackageService],
})
export class ExecutorPackageModule {}
