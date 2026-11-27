import { Module } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { getQueueToken } from "@nestjs/bullmq";
import { DataSource } from "typeorm";
import type { Queue } from "bullmq";

import { AuditModule } from "../audit/audit.module";
import { AuditService } from "../audit/audit.service";
import { AgentSessionService } from "../agent/runtime/agent-session.service";
import { AgentApprovalsService } from "../agent/runtime/agent-approvals.service";
import {
  AGENT_QUEUE_NAME,
  type AgentJobData,
} from "../agent/runtime/agent.processor";
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
import {
  WORKBENCH_SESSIONS_PORT,
  type WorkbenchSessionSummary,
  type WorkbenchSessionsPort,
} from "./workbench-sessions.port";

type WorkbenchSessionDetailRead = Omit<WorkbenchSessionSummary, "artifacts"> & {
  toolCalls: Array<{
    toolName: string;
    status: string;
    errorSummary: string | null;
    createdAt: Date | string | null;
  }>;
  approvalItems: Array<{
    approvalKey: string;
    toolName: string;
    status: string;
    reason: string | null;
    decidedBy: string | null;
    createdAt: Date | string | null;
  }>;
  artifacts: Array<{
    id: string;
    name: string;
    size: number;
    createdAt: Date | string | null;
    downloadUrl: string | null;
  }>;
};

type WorkbenchSessionsRuntimePort = WorkbenchSessionsPort & {
  readSummary(id: string): Promise<WorkbenchSessionDetailRead>;
  listOwn(input: {
    createdBy: string;
    createdByAlias?: string | null;
    page: number;
    pageSize: number;
  }): Promise<{
    items: Array<{
      sessionId: string;
      status: string;
      title: string | null;
      createdAt: Date | string | null;
      sopId: string | null;
    }>;
    total: number;
  }>;
};

function clipText(value: unknown, max = 200): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed;
}

function toolErrorSummary(row: {
  errorMessage?: unknown;
  resultJson?: unknown;
}): string | null {
  const direct = clipText(row.errorMessage);
  if (direct) return direct;
  const result = row.resultJson;
  if (!result || typeof result !== "object") return null;
  const body = result as Record<string, unknown>;
  return clipText(body.error ?? body.message ?? body.detail);
}

function artifactDownloadUrl(executionId: unknown, name: unknown): string | null {
  if (typeof executionId !== "string" || !executionId) return null;
  if (typeof name !== "string" || !name) return null;
  return `/api/tasks/executions/${encodeURIComponent(executionId)}/artifacts/${encodeURIComponent(name)}`;
}

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
    // 「运行我的草稿」会话端口：真实 AgentSessionService + agent-jobs 队列。
    // 生产装配恒真；裁剪部署里没有 AgentModule 时，注入会在启动期立即失败
    // （fail-fast），绝不回一个假端口让业务用户的会话静默不执行。
    {
      provide: WORKBENCH_SESSIONS_PORT,
      inject: [ModuleRef],
      useFactory: (moduleRef: ModuleRef): WorkbenchSessionsRuntimePort => {
        // 惰性取真服务：与 RELEASE_* 端口同款时机约束——useFactory 在模块
        // 实例化期执行，那时 AgentModule 的 provider 可能还是空壳；调用时才 get。
        const sessions = () =>
          moduleRef.get(AgentSessionService, { strict: false });
        const queue = () =>
          moduleRef.get<Queue<AgentJobData>>(getQueueToken(AGENT_QUEUE_NAME), {
            strict: false,
          });
        return {
          create: (input) => sessions().create(input),
          enqueue: async (sessionId, reason) => {
            await queue().add(
              "run",
              { sessionId, reason },
              {
                jobId: sessionId,
                attempts: 1,
                removeOnComplete: true,
                removeOnFail: false,
              },
            );
          },
          findById: (id) => sessions().findById(id),
          listOwn: async ({ createdBy, createdByAlias, page, pageSize }) => {
            const dataSource = moduleRef.get(DataSource, { strict: false });
            const safePage = Math.max(1, Math.trunc(Number(page) || 1));
            const safePageSize = Math.min(20, Math.max(1, Math.trunc(Number(pageSize) || 20)));
            const offset = (safePage - 1) * safePageSize;
            const alias = createdByAlias || createdBy;
            const where = `s."createdBy" IN ($1, $2) AND s.kind = 'sop_authoring'`;
            const [rows, totalRows] = await Promise.all([
              dataSource.query(
                `SELECT s.id, s.status, s.title, s."createdAt",
                        s."scopeJson"::jsonb -> 'sops' ->> 0 AS "sopId"
                   FROM agent_sessions s
                  WHERE ${where}
                  ORDER BY s."createdAt" DESC, s.id DESC
                  LIMIT $3 OFFSET $4`,
                [createdBy, alias, safePageSize, offset],
              ),
              dataSource.query(
                `SELECT COUNT(*)::int AS total
                   FROM agent_sessions s
                  WHERE ${where}`,
                [createdBy, alias],
              ),
            ]);
            return {
              items: rows.map((row: Record<string, unknown>) => ({
                sessionId: String(row.id),
                status: String(row.status),
                title: row.title == null ? null : String(row.title),
                createdAt: row.createdAt ?? null,
                sopId: row.sopId == null ? null : String(row.sopId),
              })),
              total: Number(totalRows?.[0]?.total ?? 0),
            };
          },
          readSummary: async (id) => {
            const svc = sessions();
            const [steps, toolCalls, approvals] = await Promise.all([
              svc.listSteps(id),
              svc.listToolCalls(id),
              moduleRef
                .get(AgentApprovalsService, { strict: false })
                .listForSession(id),
            ]);
            // 产物摘要：task_executions.agentSessionId → execution_artifacts。
            // 用 DataSource 直读窄投影，避免反向依赖 ArtifactsModule；读失败
            // 降级为空数组（产物是附加信息，不能让会话详情整页 500）。
            let artifacts: Array<{
              id: string;
              name: string;
              size: number;
              createdAt: Date | string | null;
              downloadUrl: string | null;
            }> = [];
            try {
              const dataSource = moduleRef.get(DataSource, { strict: false });
              const rows = await dataSource.query(
                `SELECT a.id, a.name, a.size, a."createdAt", a."executionId"
                   FROM execution_artifacts a
                   JOIN task_executions e ON e.id = a."executionId"
                  WHERE e."agentSessionId" = $1
                  ORDER BY a."createdAt" DESC
                  LIMIT 20`,
                [id],
              );
              artifacts = rows.map((r: Record<string, unknown>) => ({
                id: String(r.id),
                name: String(r.name),
                size: Number(r.size),
                createdAt: r.createdAt ?? null,
                downloadUrl: artifactDownloadUrl(r.executionId, r.name),
              }));
            } catch {
              // 读面降级：产物摘要缺席必须可见（空数组），不伪造内容。
            }
            const approvalCounts: Record<string, number> = {};
            for (const a of approvals) {
              approvalCounts[a.status] = (approvalCounts[a.status] ?? 0) + 1;
            }
            return {
              stepCount: steps.length,
              steps: steps.slice(-5).map((s) => ({
                seq: Number(s.seq),
                role: String(s.role),
                contentPreview:
                  typeof s.content === "string"
                    ? s.content.slice(0, 200)
                    : null,
                createdAt: s.createdAt ?? null,
              })),
              toolCallCount: toolCalls.length,
              toolCalls: toolCalls.map((tc) => ({
                toolName: String(tc.toolName),
                status: String(tc.status),
                errorSummary: toolErrorSummary(tc),
                createdAt: tc.createdAt ?? null,
              })),
              approvals: approvalCounts,
              approvalItems: approvals.map((a) => ({
                approvalKey: String(a.approvalKey),
                toolName: String(a.toolName),
                status: String(a.status),
                reason: clipText(a.reason),
                decidedBy: a.decidedBy ?? null,
                createdAt: a.createdAt ?? null,
              })),
              artifacts,
            };
          },
        };
      },
    },
  ],
})
export class WorkbenchModule {}
