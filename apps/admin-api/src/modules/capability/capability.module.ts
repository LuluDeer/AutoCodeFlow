import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuditModule } from "../audit/audit.module";
import { Capability } from "./entities/capability.entity";
import { CapabilityService } from "./capability.service";
import { CapabilityController } from "./capability.controller";

/**
 * ADR-040 / P1：Capability 注册表模块。
 *
 * 依赖单向：只 import TypeOrmModule（本表 repo）与 AuditModule（写面落证），
 * 不反向被其它业务模块依赖。AuditService 在 service 内 @Optional，缺审计模块时
 * fail-open（单测内存替身无需装配审计）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([Capability]), AuditModule],
  controllers: [CapabilityController],
  providers: [CapabilityService],
  exports: [CapabilityService],
})
export class CapabilityModule {}
