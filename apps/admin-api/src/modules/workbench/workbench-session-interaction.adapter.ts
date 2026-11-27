/**
 * Workbench 交互端口的生产适配器。
 *
 * 惰性解析 AgentModule 导出的真实服务（与 workbench.module.ts 既有 RELEASE_*
 * 端口同款时机约束：useFactory 在模块实例化期执行，那时代理服务可能还是空壳，
 * 必须调用时才 moduleRef.get）。当前文件在 AgentEventStreamService 尚未在
 * 索引中出现时也能编译——它只依赖本地窄端口类型，具体类通过 Nest token 字符串
 * 解析；w1-agent-realtime 切片把 provider 以类名注册到 AgentModule 并导出即可。
 */
import type { ModuleRef } from "@nestjs/core";
import { getQueueToken } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { DataSource } from "typeorm";

import { AgentEventStreamService } from "../agent/runtime/agent-event-stream.service";
import { AgentSessionService } from "../agent/runtime/agent-session.service";
import { AgentApprovalsService } from "../agent/runtime/agent-approvals.service";
import {
  AGENT_QUEUE_NAME,
  type AgentJobData,
} from "../agent/runtime/agent.processor";
import { manualResumeJobOptions } from "../agent/runtime/agent-job-options";
import type {
  WorkbenchCreateInteractiveInput,
  WorkbenchDecideApprovalInput,
  WorkbenchInteractiveSessionRow,
  WorkbenchSendMessageInput,
  WorkbenchSessionInteractionPort,
  WorkbenchStreamInput,
} from "./workbench-session-interaction.port";

/**
 * AgentEventStreamService 的本地结构面（跨切片契约，由 w1-agent-realtime 提供）：
 * - streamSession(sessionId, {fromSeq?, res, signal?})
 * - requestAbort(sessionId, actor?)
 * - sendMessageAndResume(sessionId, {content, mode?, actor})
 *
 * 真实类由 AgentModule 以 class provider 注册并导出；这里用 ModuleRef 惰性
 * get(class, {strict:false}) 解析，避免 useFactory 实例化期取到空壳。
 */

export function createWorkbenchSessionInteractionPort(
  moduleRef: ModuleRef,
): WorkbenchSessionInteractionPort {
  const sessions = () => moduleRef.get(AgentSessionService, { strict: false });
  const approvals = () => moduleRef.get(AgentApprovalsService, { strict: false });
  const stream = () => moduleRef.get(AgentEventStreamService, { strict: false });
  const queue = () =>
    moduleRef.get<Queue<AgentJobData>>(getQueueToken(AGENT_QUEUE_NAME), {
      strict: false,
    });
  const dataSource = () => moduleRef.get(DataSource, { strict: false });

  async function resumeSession(sessionId: string, reason: string): Promise<boolean> {
    const session = await sessions().findById(sessionId);
    if (!session || session.status !== "waiting_input") return false;
    if (await approvals().hasPendingForSession(sessionId)) return false;
    await queue().add("run", { sessionId, reason }, manualResumeJobOptions(sessionId, session.totalSteps));
    return true;
  }

  return {
    createSession: async (input: WorkbenchCreateInteractiveInput) => {
      const created = await sessions().create(input);
      return { id: created.id, status: created.status };
    },

    findById: async (id: string): Promise<WorkbenchInteractiveSessionRow | null> => {
      const row = await sessions().findById(id);
      if (!row) return null;
      return {
        id: row.id,
        kind: row.kind,
        status: row.status,
        createdBy: row.createdBy ?? null,
        title: row.title ?? null,
      };
    },

    sendMessage: async (input: WorkbenchSendMessageInput) => {
      await stream().sendMessageAndResume(input.sessionId, {
        content: input.content,
        mode: input.mode,
        actor: input.actor,
      });
    },

    streamSession: async (input: WorkbenchStreamInput) => {
      await stream().streamSession(input.sessionId, {
        fromSeq: input.fromSeq,
        res: input.res,
        signal: input.signal,
      });
    },

    requestAbort: async (sessionId: string, actor?: string) => {
      const result = await stream().requestAbort(sessionId, actor);
      return Boolean(result);
    },

    decideApproval: async (input: WorkbenchDecideApprovalInput) => {
      const approval = await approvals().findByKey(input.approvalKey);
      if (!approval || approval.sessionId !== input.sessionId) {
        // 审批单不存在或与会话不匹配：fail-closed。
        return false;
      }
      const decision =
        input.decision === "withdraw" || input.decision === "deny"
          ? "denied"
          : "granted";
      const decidedBy =
        input.decision === "withdraw"
          ? `withdraw:${input.actor}`
          : input.username || input.actor;
      const row = await approvals().decide(input.approvalKey, decision, decidedBy);
      if (!row) return false;
      return resumeSession(input.sessionId, `resume:${input.decision}`);
    },

    listOwn: async ({ createdBy, createdByAlias, isAdmin, page, pageSize }) => {
      const safePage = Math.max(1, Math.trunc(Number(page) || 1));
      const safePageSize = Math.min(50, Math.max(1, Math.trunc(Number(pageSize) || 20)));
      const offset = (safePage - 1) * safePageSize;
      const alias = createdByAlias || createdBy;
      // ADMIN 可看全部；USER 只看自己。kind 限交互面三类。
      const where = isAdmin
        ? `s.kind IN ('chat','plan','sop_authoring')`
        : `s."createdBy" IN ($1, $2) AND s.kind IN ('chat','plan','sop_authoring')`;
      const params = isAdmin ? [safePageSize, offset] : [createdBy, alias, safePageSize, offset];
      const countParams = isAdmin ? [] : [createdBy, alias];
      const [rows, countRows] = await Promise.all([
        dataSource().query(
          `SELECT s.id, s.status, s.title, s.kind, s."createdAt"
             FROM agent_sessions s
            WHERE ${where}
            ORDER BY s."createdAt" DESC, s.id DESC
            LIMIT ${isAdmin ? "$1" : "$3"} OFFSET ${isAdmin ? "$2" : "$4"}`,
          params,
        ),
        dataSource().query(
          `SELECT COUNT(*)::int AS total FROM agent_sessions s WHERE ${where}`,
          countParams,
        ),
      ]);
      return {
        items: rows.map((row: Record<string, unknown>) => ({
          sessionId: String(row.id),
          status: String(row.status),
          title: row.title == null ? null : String(row.title),
          kind: String(row.kind),
          createdAt: (row.createdAt as Date | string | null) ?? null,
        })),
        total: Number(countRows?.[0]?.total ?? 0),
      };
    },
  };
}
