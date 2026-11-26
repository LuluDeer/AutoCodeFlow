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
import {
  CAPABILITY_SCOPE_GATE,
  capabilityScopeGate,
} from "./capability-scope.gate";
import { CapabilityActivationLog } from "./entities/activation-log.entity";
import { PriceService } from "./price.service";
import { TokenSamplePort, createTokenSamplePort } from "./token-sample.port";
import { DataSource } from "typeorm";

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
    // 成本归责：managed 价目表（system_configs 零迁移）+ 按 sessionId 诚实采样端口
    PriceService,
    {
      provide: TokenSamplePort,
      inject: [DataSource],
      useFactory: (ds: DataSource) =>
        createTokenSamplePort({
          selectAgentSessionTotals: async (sessionId) => {
            const rows = await ds.query(
              'SELECT id, "totalTokensIn", "totalTokensOut" FROM agent_sessions WHERE id = $1 LIMIT 1',
              [sessionId],
            );
            return rows[0] ?? null;
          },
          selectStepUsages: async (agentSessionId) =>
            ds.query(
              'SELECT "tokensIn", "tokensOut" FROM agent_steps WHERE "sessionId" = $1 AND "tokensIn" > 0',
              [agentSessionId],
            ),
        }),
    },
    {
      provide: QUOTA_HARD_LIMIT_GATE,
      useFactory: (moduleRef: ModuleRef): QuotaHardLimitGate => ({
        evaluateHardLimit: (dto) =>
          moduleRef.get(QuotaService, { strict: false }).evaluateHardLimit(dto),
      }),
      inject: [ModuleRef],
    },
    // N19 scope 闸：纯判定实现无 Nest/DB 依赖，直接 useValue 绑定；export
    // 出去供 workbench（useExisting 前置 fail-close）与 api-keys 联动复用。
    // service 侧是 @Optional 注入，裁剪部署/极简装配缺席即跳过，不阻断主链。
    { provide: CAPABILITY_SCOPE_GATE, useValue: capabilityScopeGate },
  ],
  exports: [CapabilityActivationService, QuotaService, CAPABILITY_SCOPE_GATE],
})
export class CapabilityActivationModule {}
