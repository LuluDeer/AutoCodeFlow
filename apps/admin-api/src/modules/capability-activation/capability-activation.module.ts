import { Module } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { TypeOrmModule } from "@nestjs/typeorm";
import { SystemConfigModule } from "../config/config.module";
import { NotificationModule } from "../notification/notification.module";
import { CapabilityActivationController } from "./capability-activation.controller";
import { CapabilityActivationService } from "./capability-activation.service";
import { QuotaService } from "./quota.service";
import {
  QUOTA_HARD_LIMIT_GATE,
  type QuotaHardLimitGate,
} from "./quota-limit.gate";
import { CapabilityActivationLog } from "./entities/activation-log.entity";

/**
 * N15 / GCO §11：运行时能力审计模块。
 *
 * 依赖单向：只 import 本表 repo（TypeOrmModule.forFeature），**不依赖
 * AuditModule**——激活日志是独立高频审计面，不进 audit_logs（见 service 头注）。
 * Export service 供 capability/workbench 等内部调用方未来直接注入记录激活，
 * 不必绕 HTTP。
 *
 * N20：配额配置存 SystemConfigService（SystemConfigModule），软阈值告警走
 * NotificationService.sendWebhook（NotificationModule 导出面，内部即
 * webhook.channel.send）。两者都不反向依赖本模块，无循环。
 *
 * 硬阈闸：activation.service 只 @Optional 注入结构面 token，真实实现是
 * QuotaService.evaluateHardLimit；token 的 useFactory **不直接 inject
 * QuotaService**（那会在解析期形成 quota→activation→gate→quota 的环），
 * 改用 ModuleRef 在每次调用时惰性取；取不到时抛错由 activation fail-open。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([CapabilityActivationLog]),
    SystemConfigModule,
    NotificationModule,
  ],
  controllers: [CapabilityActivationController],
  providers: [
    CapabilityActivationService,
    QuotaService,
    {
      provide: QUOTA_HARD_LIMIT_GATE,
      useFactory: (moduleRef: ModuleRef): QuotaHardLimitGate => ({
        evaluateHardLimit: (dto) =>
          moduleRef.get(QuotaService, { strict: false }).evaluateHardLimit(dto),
      }),
      inject: [ModuleRef],
    },
  ],
  exports: [CapabilityActivationService, QuotaService],
})
export class CapabilityActivationModule {}
