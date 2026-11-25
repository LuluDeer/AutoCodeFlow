import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ConfigModule } from "@nestjs/config";
import { ExecutorPackage } from "./executor-package.entity";
import { ExecutorPackageService } from "./executor-package.service";
import { ExecutorPackageController } from "./executor-package.controller";
import { ExecutorModule } from "../executor/executor.module";
import { SystemConfigModule } from "../config/config.module";
// P1 鉴权修复：download 的管理 JWT 通道内联复用 UsersService（UsersModule 已导出）。
import { UsersModule } from "../users/users.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([ExecutorPackage]),
    ExecutorModule,
    ConfigModule,
    SystemConfigModule,
    UsersModule,
  ],
  controllers: [ExecutorPackageController],
  providers: [ExecutorPackageService],
  exports: [ExecutorPackageService],
})
export class ExecutorPackageModule {}
