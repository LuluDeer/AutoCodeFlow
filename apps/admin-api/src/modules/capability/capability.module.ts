import { Module, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuditModule } from "../audit/audit.module";
import { Capability } from "./entities/capability.entity";
import { CapabilityService } from "./capability.service";
import { CapabilityController } from "./capability.controller";
import { CapabilityGenerationRegistry } from "./capability-generation.registry";
import { ExternalAgentBypassWriteService } from "./external-agent-bypass.service";
import { ReachabilityProbeService } from "./reachability-probe.service";
import { safeHttpProbe } from "./reachability-probe.adapter";
import { InProcessCapabilityService } from "./inprocess-gate.service";

/**
 * ADR-040 / P1：Capability 注册表模块。
 *
 * 依赖单向：只 import TypeOrmModule（本表 repo）与 AuditModule（写面落证），
 * 不反向被其它业务模块依赖。AuditService 在 service 内 @Optional，缺审计模块时
 * fail-open（单测内存替身无需装配审计）。
 *
 * N23：registry provider 持有 generation swap 状态机；DomainEventModule 是 @Global，
 * bus 在 registry 内 @Optional 注入。生命周期钩子只做订阅/退订，不改 resolve 契约。
 *
 * N1/N9（第 66 轮）：bypass 写 service（外部 agent 配置原子改写）与 reachability
 * probe service（SSRF 校验式安全探测，默认适配器只校验不发包）注册为 provider。
 * CapabilityService 第 4 参 @Optional 注入 probe，缺席时 resolve/dump 降级字段缺席、
 * 主链逐字不变。
 */
@Module({
  imports: [TypeOrmModule.forFeature([Capability]), AuditModule],
  controllers: [CapabilityController],
  providers: [
    CapabilityService,
    CapabilityGenerationRegistry,
    ExternalAgentBypassWriteService,
    {
      provide: ReachabilityProbeService,
      useFactory: () => new ReachabilityProbeService(safeHttpProbe),
    },
    // N24：进程内能力网关（判据复用 inprocess-gate.ts 纯函数）；只追加 provider，
    // 既有四个 provider 与 exports 逐字不动。
    InProcessCapabilityService,
  ],
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
