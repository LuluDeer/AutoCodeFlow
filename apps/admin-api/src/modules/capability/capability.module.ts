import { Module, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuditModule } from "../audit/audit.module";
import { Capability } from "./entities/capability.entity";
import { CapabilityService } from "./capability.service";
import { CapabilityController } from "./capability.controller";
import { CapabilityGenerationRegistry } from "./capability-generation.registry";

/**
 * ADR-040 / P1：Capability 注册表模块。
 *
 * 依赖单向：只 import TypeOrmModule（本表 repo）与 AuditModule（写面落证），
 * 不反向被其它业务模块依赖。AuditService 在 service 内 @Optional，缺审计模块时
 * fail-open（单测内存替身无需装配审计）。
 *
 * N23：registry provider 持有 generation swap 状态机；DomainEventModule 是 @Global，
 * bus 在 registry 内 @Optional 注入。生命周期钩子只做订阅/退订，不改 resolve 契约。
 */
@Module({
  imports: [TypeOrmModule.forFeature([Capability]), AuditModule],
  controllers: [CapabilityController],
  providers: [CapabilityService, CapabilityGenerationRegistry],
  exports: [CapabilityService],
})
export class CapabilityModule implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly generation: CapabilityGenerationRegistry) {}

  onModuleInit(): void {
    this.generation.subscribe();
  }

  onModuleDestroy(): void {
    this.generation.unsubscribe();
  }
}
