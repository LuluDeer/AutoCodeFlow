/**
 * Workbench 交互端口的生产适配器。
 *
 * 惰性解析 AgentModule 导出的真实服务（与 workbench.module.ts 既有 RELEASE_*
 * 端口同款时机约束：useFactory 在模块实例化期执行，那时代理服务可能还是空壳，
 * 必须调用时才 moduleRef.get）。当前文件在 AgentEventStreamService 尚未在
 * 索引中出现时也能编译——它只依赖本地窄端口类型，具体类通过 Nest token 字符串
 * 解析；w1-agent-realtime 切片把 provider 以类名注册到 AgentModule 并导出即可。
 */
import { Logger } from "@nestjs/common";
import type { ModuleRef } from "@nestjs/core";
import { getQueueToken } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { DataSource } from "typeorm";

import { AppError } from "../../common/errors/app-error";
import { AgentEventStreamService } from "../agent/runtime/agent-event-stream.service";
import { AgentSessionService } from "../agent/runtime/agent-session.service";
import {
  AgentApprovalsService,
  type ApprovalDecisionKind,
} from "../agent/runtime/agent-approvals.service";
import {
  appendToolCallStatusChangedEvent,
  isApprovalSelfDecision,
} from "../agent/runtime/agent-approval-wakeup.service";
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

/**
 * 终态会话追加消息的拒绝标记（跨切片契约：`sendMessageAndResume` 返回
 * `action='rejected_terminal'` + reason）。port 的 sendMessage 签名是 void，
 * 无法把结构化结果返回给 controller；用带字段的 Error 如实把 reason 带上去，
 * controller 捕获后回 `{ok:false, action:'rejected_terminal', reason}`。
 */
export class WorkbenchTerminalRejectedError extends Error {
  readonly action = "rejected_terminal" as const;
  constructor(
    readonly reason: string,
    readonly status: string,
  ) {
    super(reason);
    this.name = "WorkbenchTerminalRejectedError";
  }
}

/**
 * 工作台审批强制四眼：controller 已无条件拦建单人（grant），适配层用同一口径
 * 兜底（深链/其他调用方绕过 controller 时也拦）。工作台没有单独的
 * `blockSelfApproval` 开关——四眼在工作台是策略不变量，故 config stub 恒 true。
 */
const WORKBENCH_SELF_APPROVAL_CONFIG = {
  get<T>(key: string): T | undefined {
    return key === "agent.policy.blockSelfApproval" ? (true as T) : undefined;
  },
};

/** controller 传进来的 actor 形如 `user:<id>`；提取 id 供建单人（user:<id> 口径）判定。 */
function userIdFromActor(actor: string): string | null {
  const match = /^user:(\d+)$/.exec(actor);
  return match ? match[1] : null;
}

export function createWorkbenchSessionInteractionPort(
  moduleRef: ModuleRef,
): WorkbenchSessionInteractionPort {
  const logger = new Logger("WorkbenchSessionInteraction");
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
      const result = await stream().sendMessageAndResume(input.sessionId, {
        content: input.content,
        mode: input.mode,
        actor: input.actor,
      });
      // 终态拒绝（跨切片契约 action='rejected_terminal'）必须如实上抛给 controller，
      // 让上层回 {ok:false, reason}；不能吞成 void 再让 controller 谎报 ok:true。
      if (result?.action === "rejected_terminal") {
        throw new WorkbenchTerminalRejectedError(
          result.reason ?? `会话已处于终态（${result.status}），不能继续追加消息`,
          result.status,
        );
      }
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
      // result 是 AgentAbortResult（{sessionId,status,aborted}），恒 truthy；
      // Boolean(result) 会把终态会话假报成取消成功。只认显式布尔字段。
      return result?.aborted === true;
    },

    decideApproval: async (input: WorkbenchDecideApprovalInput) => {
      const approval = await approvals().findByKey(input.approvalKey);
      if (!approval || approval.sessionId !== input.sessionId) {
        // 审批单不存在或与会话不匹配：fail-closed。
        return false;
      }
      // 已处置（granted/denied/consumed/expired）⇒ 本次零副作用返回 false，
      // 不进 decide（那条路会抛 409），让 controller 能如实回 ok:false。
      if (approval.status !== "pending") return false;

      const isGrant = input.decision === "grant";
      const isWithdraw = input.decision === "withdraw";
      const decisionKind: ApprovalDecisionKind = isGrant
        ? "grant"
        : isWithdraw
          ? "withdraw"
          : "deny";

      if (isGrant) {
        // 四眼兜底：建单人不得批准自己发起的会话（controller 已有一层，深链/
        // 直接调端口也必须拦）。判定在任何写库之前 ⇒ 拒绝即零副作用。
        const session = await sessions().findById(input.sessionId);
        if (
          isApprovalSelfDecision({
            createdBy: session?.createdBy,
            username: input.username,
            userId: userIdFromActor(input.actor),
            toolName: approval.toolName,
            config: WORKBENCH_SELF_APPROVAL_CONFIG,
          })
        ) {
          throw new AppError("AGENT_APPROVAL_SELF_DENIED");
        }
      }

      const decidedBy = isWithdraw
        ? `withdraw:${input.actor}`
        : input.username || input.actor;
      let row;
      try {
        row = await approvals().decide(
          input.approvalKey,
          isGrant ? "granted" : "denied",
          decidedBy,
          decisionKind,
        );
      } catch (err: unknown) {
        // 并发下另一处置方抢先命中条件写：与前置 status 检查同义，返回 false。
        // AppError 按 status 改挂 Nest 原型（409 ⇒ ConflictException），故只能按
        // errorCode 判，不能用 instanceof AppError。
        if (
          err &&
          typeof err === "object" &&
          (err as { errorCode?: unknown }).errorCode ===
            "AGENT_APPROVAL_ALREADY_DECIDED"
        ) {
          return false;
        }
        throw err;
      }
      if (!row) return false;

      if (!isGrant) {
        // 与 agent 主线 applyApprovalDecisionEffects 的 deny 分支逐字同款：
        // 先按 approvalKey 结算 awaiting_approval 台账行；只有真的命中行才补
        // tool_call_status_changed（causedBySeq 指向刚落的 approval_decided）。
        const settled = await sessions().settleToolCallByApprovalId(
          input.approvalKey,
          "denied",
          `已被 ${decidedBy} 人工${isWithdraw ? "撤回" : "拒绝"}（审批单 ${input.approvalKey}）——不得重试同一调用`,
        );
        if (settled > 0) {
          await appendToolCallStatusChangedEvent(
            sessions(),
            logger,
            input.sessionId,
            input.approvalKey,
          );
        }
      }

      // 恢复入队是旁路：决定已落库即本次处置成功，返回值只对 controller 的
      // `ok` 负责（不再把 resumeSession 的布尔当成整个处置的成败）。
      await resumeSession(input.sessionId, `resume:${input.decision}`);
      return true;
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
