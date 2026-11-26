import { Module } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";

import { ConfigCacheSyncService } from "../config/config-cache-sync.service";
import { SystemConfigModule } from "../config/config.module";
import { SystemConfigService } from "../config/config.service";
import { CapabilityActivationModule } from "../capability-activation/capability-activation.module";
import { CapabilityActivationService } from "../capability-activation/capability-activation.service";
import { QUOTA_HARD_LIMIT_GATE } from "../capability-activation/quota-limit.gate";
import { QuotaService } from "../capability-activation/quota.service";
import { SopModule } from "../sop/sop.module";
import {
  PolicyConfigStore,
  PolicyGenerationInvalidator,
  PolicyGenerationService,
} from "./policy-generation.service";
import {
  CapabilityActivationRecorder,
  WorkbenchController,
} from "./workbench.controller";

/**
 * 最小方案卡面：preview 纯内存；commit 先过硬阈闸（超限 429、不落 draft），
 * 再经 SopService 落 draft 行（不发布），最后通过 CapabilityActivationModule
 * 导出的 service 记一条能力激活审计（fail-open）。
 * alias provider 把真实 service 映射到控制器的本地 token（控制器因此不值 import
 * typeorm 依赖，内存替身单测可只 mock 基础装饰器）。
 *
 * N14+/持久化：PolicyGenerationService 的版本存 system_configs。这里 import
 * SystemConfigModule（导出 SystemConfigService）并用 alias 把它接到最小结构面
 * PolicyConfigStore；失效广播用 ModuleRef 惰性取 ConfigCacheSyncService 桥接
 * （它未在 SystemConfigModule 导出，strict:false 从全局容器取；缺席即 no-op，
 * 与 config.service.ts 自身对 cacheSync 的 @Optional 姿态一致）。
 */
@Module({
  imports: [SopModule, CapabilityActivationModule, SystemConfigModule],
  controllers: [WorkbenchController],
  providers: [
    {
      provide: CapabilityActivationRecorder,
      useExisting: CapabilityActivationService,
    },
    // 第四道闸（N20 硬阈值）：capability-activation.module 只 export 了
    // QuotaService（evaluateHardLimit 即 gate 真实实现），未 export gate token。
    // 这里在本模块用 useExisting 把 token 别名到 QuotaService——不写 gate 模块
    // 源码、不新增 DI 环（QuotaService 依赖 activation/config/notification，
    // 均不反向依赖 workbench）。
    { provide: QUOTA_HARD_LIMIT_GATE, useExisting: QuotaService },
    { provide: PolicyConfigStore, useExisting: SystemConfigService },
    {
      provide: PolicyGenerationInvalidator,
      useFactory: (moduleRef: ModuleRef): PolicyGenerationInvalidator => ({
        publishInvalidate: (key?: string): void => {
          try {
            const sync = moduleRef.get(ConfigCacheSyncService, {
              strict: false,
            });
            void sync.publishInvalidate(key);
          } catch {
            // 同步服务缺席（裁剪部署/极简装配）→ no-op，绝不阻断 bump。
          }
        },
      }),
      inject: [ModuleRef],
    },
    // N14：DomainEventModule 是 @Global（AppModule 已 import），其 DomainEventBus
    // 可直接注入；本服务构造时订阅 capability.changed 并 bump 运行时代际。
    PolicyGenerationService,
  ],
})
export class WorkbenchModule {}
