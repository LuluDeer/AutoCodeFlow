/**
 * 工作台交互端口：把「创建会话 / 首条消息 / SSE 流 / 中止 / 审批处置」从
 * AgentModule 的具体服务借出来，控制器只依赖这个窄接口。
 *
 * 生产由 WorkbenchModule 的适配器用 ModuleRef 惰性解析 AgentModule 导出的
 * `AgentEventStreamService`（跨切片契约：streamSession/requestAbort/
 * sendMessageAndResume）+ AgentSessionService + AgentApprovalsService；
 * 单测用内存替身，不碰 Redis / PG / BullMQ。
 */
import type { Response } from "express";
import type { AgentSessionKind, AgentSessionStatus } from "../agent/entities/agent-session.entity";
import type {
  WorkbenchApprovalDecision,
  WorkbenchMessageMode,
} from "./dto/workbench-interactive.dto";

export const WORKBENCH_SESSION_INTERACTION_PORT = "WORKBENCH_SESSION_INTERACTION_PORT";

export interface WorkbenchInteractiveSessionRow {
  id: string;
  kind: AgentSessionKind;
  status: AgentSessionStatus;
  createdBy: string | null;
  title?: string | null;
}

export interface WorkbenchCreateInteractiveInput {
  kind: AgentSessionKind;
  title: string;
  createdBy: string;
  triggerSource: string;
  context: Record<string, unknown>;
  scope: Record<string, unknown>;
}

export interface WorkbenchSendMessageInput {
  sessionId: string;
  content: string;
  mode: WorkbenchMessageMode;
  actor: string;
}

export interface WorkbenchStreamInput {
  sessionId: string;
  fromSeq?: number;
  res: Response;
  signal?: AbortSignal;
}

export interface WorkbenchDecideApprovalInput {
  sessionId: string;
  approvalKey: string;
  decision: WorkbenchApprovalDecision;
  actor: string;
  username: string;
}

export interface WorkbenchSessionInteractionPort {
  createSession(input: WorkbenchCreateInteractiveInput): Promise<{
    id: string;
    status: AgentSessionStatus;
  }>;
  findById(id: string): Promise<WorkbenchInteractiveSessionRow | null>;
  sendMessage(input: WorkbenchSendMessageInput): Promise<void>;
  streamSession(input: WorkbenchStreamInput): Promise<void>;
  requestAbort(sessionId: string, actor?: string): Promise<boolean>;
  decideApproval(input: WorkbenchDecideApprovalInput): Promise<boolean>;
  listOwn(input: {
    createdBy: string;
    createdByAlias?: string | null;
    isAdmin?: boolean;
    page: number;
    pageSize: number;
  }): Promise<{
    items: Array<{
      sessionId: string;
      status: string;
      title: string | null;
      kind: string;
      createdAt: Date | string | null;
    }>;
    total: number;
  }>;
}
