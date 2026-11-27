import { Logger, Module } from "@nestjs/common";
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
      useFactory: (ds: DataSource) => {
        const logger = new Logger("TokenSamplePortAdapter");
        return createTokenSamplePort(
          {
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
            // 成本线 P1（第 93 轮）：顶层 dualBasis 金额折算的 token 样本源。
            // 企业总账单口径：不按 sessionId 关联、不做份额分摊；只取 provider/model
            // 齐全且确有 token 的组；bigint 由 Port 层归一为 number。
            // 第 94 轮：与 stats 的激活次数同源——from/to 均为闭区间、参数化过滤
            // agent_steps."createdAt"；两者缺省时条件整段不追加（全局累计，零回归）。
            // ⚠ ORDER BY 必须用聚合表达式：PG 在表达式里把 "in"/"out" 当输入列名，
            //   用 SELECT 输出别名会报 column "in" does not exist（真 PG 实测）。
            selectTokenByProviderModel: async (from?: Date, to?: Date) => {
              const params: string[] = [];
              const window: string[] = [];
              if (from) {
                // agent_steps."createdAt" 是 @CreateDateColumn() 默认的
                // timestamp WITHOUT time zone（与 activation_log 显式 timestamptz 不同）。
                // ⚠ 不能加 ::timestamptz：PG 会把 naive 列值按会话 TZ 解释为 timestamptz
                //   再比较，闭区间端点整体漂移（真 PG 实测边界行漏算）。这里与
                //   applyWindow 一致传 ISO 字符串、无强转，由 PG 按列类型解析。
                params.push(from.toISOString());
                window.push(`"createdAt" >= $${params.length}`);
              }
              if (to) {
                params.push(to.toISOString());
                window.push(`"createdAt" <= $${params.length}`);
              }
              const where = [
                "provider IS NOT NULL",
                "model IS NOT NULL",
                '("tokensIn" > 0 OR "tokensOut" > 0)',
                ...window,
              ].join(" AND ");
              return ds.query(
                `SELECT provider, model, SUM("tokensIn")::bigint AS "in", SUM("tokensOut")::bigint AS "out", COUNT(*)::int AS steps
FROM agent_steps
WHERE ${where}
GROUP BY provider, model ORDER BY SUM("tokensIn") + SUM("tokensOut") DESC`,
                params,
              );
            },
          },
          {
            // SQL 失败必须留痕，否则 Port 的 fail-soft 会把错误伪装成「诚实标缺」。
            onAggregateError: (err: unknown) =>
              logger.warn(
                `[showback] 全局 token 聚合查询失败，按空样本标缺：${
                  err instanceof Error ? err.message : String(err)
                }`,
              ),
          },
        );
      },
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
