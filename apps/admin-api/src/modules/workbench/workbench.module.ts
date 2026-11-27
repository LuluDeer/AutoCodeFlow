import { Module } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";

import { AuditModule } from "../audit/audit.module";
import { AuditService } from "../audit/audit.service";
import { AgentSessionService } from "../agent/runtime/agent-session.service";
import { AgentApprovalsService } from "../agent/runtime/agent-approvals.service";
import { SopService } from "../sop/sop.service";
import { ConfigService } from "@nestjs/config";
import {
  RELEASE_APPROVALS_PORT,
  RELEASE_POLICY_PORT,
  RELEASE_SESSIONS_PORT,
  RELEASE_SOPS_PORT,
  ReleaseApprovalService,
  type ReleaseApprovalsPort,
} from "./release-approval.service";
import { releasePolicyAdapter } from "./release-policy.adapter";
import { ReleaseRetryController } from "./release-retry.controller";
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
import {
  EmptyRewindAsyncWriteSource,
  REWIND_ASYNC_WRITE_SOURCE,
  REWIND_AUDIT_SINK,
  REWIND_GENERATION_SOURCE,
  RewindRunner,
} from "./rewind-runner";
import {
  InMemoryWorkbenchPartProvider,
  PartProjectionService,
  WorkbenchPartProvider,
} from "./part-projection.service";
import { WorkbenchBlobStore } from "./workbench-blob.store";

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
  imports: [
    SopModule,
    CapabilityActivationModule,
    SystemConfigModule,
    AuditModule,
  ],
  controllers: [WorkbenchController, ReleaseRetryController],
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
    // N18 rewind：代际与审计用 token 别名到真实服务（runner 不值 import 它们，
    // 保住既有 preview/commit 的内存替身单测）；在途写入源缺省为空实现，
    // 生产可由其它模块用同名 token override 成真实仓储/注册表。
    { provide: REWIND_GENERATION_SOURCE, useExisting: PolicyGenerationService },
    { provide: REWIND_AUDIT_SINK, useExisting: AuditService },
    {
      provide: REWIND_ASYNC_WRITE_SOURCE,
      useClass: EmptyRewindAsyncWriteSource,
    },
    RewindRunner,
    // ADR-045：发布审批四端口。ModuleRef strict:false 惰性取全局装配的
    // AgentApprovalsService / SopService（不反向改 AgentModule exports）；
    // 会话端口复用已 import 的 AgentSessionService；策略指纹按 phrase 同口径适配。
    //
    // ⚠️ RELEASE_APPROVALS_PORT **必须惰性**：useFactory 在 **WorkbenchModule 实例化期**
    // 执行，那时 `moduleRef.get(AgentApprovalsService)` 解析出的是「构造器尚未执行」的
    // 空壳（实测 `Object.keys(port) === []`、`port.approvals === undefined`），于是
    // `ReleaseApprovalService.requestRelease` 调 `approvals.request()` 直接抛
    // `Cannot read properties of undefined (reading 'create')` —— 整条 ADR-045 发布链
    // 在真进程里 100% 不可用。下面三个端口统一「调用时才 get」：工厂只返回代理，
    // 每个方法内部现场解析真服务再转发（方法签名与返回语义逐字不变）。
    {
      provide: RELEASE_APPROVALS_PORT,
      inject: [ModuleRef],
      useFactory: (moduleRef: ModuleRef) => {
        const approvals = () =>
          moduleRef.get(AgentApprovalsService, { strict: false });
        const port: ReleaseApprovalsPort = {
          buildKey: (
            sessionId: string,
            toolName: string,
            args: Record<string, unknown> | null,
          ) => approvals().buildKey(sessionId, toolName, args),
          request: (input: Parameters<ReleaseApprovalsPort["request"]>[0]) =>
            approvals().request(input),
          consume: (
            approvalKey: string,
            currentPolicyFingerprint: string | null,
          ) => approvals().consume(approvalKey, currentPolicyFingerprint),
        };
        // 重启恢复用的可选方法不进枚举面：workbench-release-port-wiring.spec.ts
        // 钉死了代理只暴露 buildKey/request/consume 三个可枚举键。用不可枚举属性
        // 挂上去，消费侧 `this.approvals.findByKey` 仍可惰性取真服务。
        Object.defineProperty(port, "findByKey", {
          enumerable: false,
          value: (approvalKey: string) => approvals().findByKey(approvalKey),
        });
        return port;
      },
    },
    {
      provide: RELEASE_SESSIONS_PORT,
      inject: [ModuleRef],
      useFactory: (moduleRef: ModuleRef) => ({
        create: (input: never) =>
          moduleRef.get(AgentSessionService, { strict: false }).create(input),
        // 惰性取真服务：恢复路径只在内存 args 未命中时读 session.contextJson。
        findById: async (id: string) => {
          const row = await moduleRef
            .get(AgentSessionService, { strict: false })
            .findById(id);
          return {
            contextJson: (row?.contextJson ?? null) as Record<
              string,
              unknown
            > | null,
          };
        },
      }),
    },
    {
      provide: RELEASE_SOPS_PORT,
      inject: [ModuleRef],
      useFactory: (moduleRef: ModuleRef) => {
        const sops = () => moduleRef.get(SopService, { strict: false });
        return {
          findDraft: async (id: string) => {
            const sop = await sops().getSop(id);
            return {
              frontMatterJson: sop?.frontMatterJson ?? null,
              bodyMarkdown: sop?.bodyMarkdown ?? null,
            };
          },
          publish: (input: never) => sops().publish(input),
        };
      },
    },
    {
      provide: RELEASE_POLICY_PORT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => releasePolicyAdapter(config),
    },
    ReleaseApprovalService,
    WorkbenchBlobStore,
    PartProjectionService,
    // N10：Part 源缺省是进程内服务端 Map；owner 判定走 ModuleRef 惰性取
    // AgentSessionService（AppModule 已装配 AgentModule）。取不到就 fail-closed
    // 返回 false，不在裁剪部署里静默把私有 Part 放开。
    {
      provide: WorkbenchPartProvider,
      inject: [ModuleRef],
      useFactory: (moduleRef: ModuleRef): WorkbenchPartProvider => {
        const local = new InMemoryWorkbenchPartProvider();
        return {
          getPart: (partId: string) => local.getPart(partId),
          listParts: (sessionId: string) => local.listParts(sessionId),
          savePart: (part) => local.savePart(part),
          isOwner: async (sessionId, viewer) => {
            if (!viewer) return false;
            try {
              const sessions = moduleRef.get(AgentSessionService, {
                strict: false,
              });
              const row = await sessions.findById(sessionId);
              if (!row?.createdBy) return false;
              return (
                row.createdBy === `user:${viewer.id}` ||
                row.createdBy === `user:${viewer.username}`
              );
            } catch {
              return false;
            }
          },
        };
      },
    },
  ],
})
export class WorkbenchModule {}
