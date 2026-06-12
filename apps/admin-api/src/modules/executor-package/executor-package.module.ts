import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ExecutorPackage } from "./executor-package.entity";
import { ExecutorPackageService } from "./executor-package.service";
import { ExecutorPackageController } from "./executor-package.controller";

@Module({
  imports: [TypeOrmModule.forFeature([ExecutorPackage])],
  controllers: [ExecutorPackageController],
  providers: [ExecutorPackageService],
  exports: [ExecutorPackageService],
})
export class ExecutorPackageModule {}
