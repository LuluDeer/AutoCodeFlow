/**
 * 工作台会话端口：把「创建会话 + 入队 + 读回会话」的窄能力从 AgentModule
 * 借出来，而不让 WorkbenchController 直接依赖 BullMQ / agent provider 的
 * 具体装配。生产由 WorkbenchModule 的适配器把真实 AgentSessionService 与
 * agent-jobs 队列接上；单测可以只提供内存替身。
 *
 * 刻意只有四个方法：
 * - create()：建会话（服务端钉死 kind/scope/creator/trigger）；
 * - enqueue()：把会话入 agent-jobs 队列（一次且仅一次，jobId=sessionId 去重）；
 * - findById()：读会话行（归属判定 + 详情回显）；
 * - readSummary()：步骤/工具调用/审批摘要（读回端点用）。
 *
 * 端口本身不决定任何权限或业务语义——那些都在 controller 里。
 */
import type { AgentSession } from "../agent/entities/agent-session.entity";
import type {
  AgentSessionKind,
  AgentSessionStatus,
} from "../agent/entities/agent-session.entity";

export const WORKBENCH_SESSIONS_PORT = "WORKBENCH_SESSIONS_PORT";

export interface WorkbenchCreateSessionInput {
  kind: AgentSessionKind;
  triggerSource: string;
  title?: string;
  createdBy: string;
  context: Record<string, unknown>;
  scope: Record<string, unknown>;
}

export interface WorkbenchSessionSummary {
  stepCount: number;
  steps: Array<{
    seq: number;
    role: string;
    contentPreview: string | null;
    createdAt: Date | string | null;
  }>;
  toolCallCount: number;
  approvals: Record<string, number>;
  artifacts: Array<{
    id: string;
    name: string;
    size: number;
    createdAt: Date | string | null;
  }>;
}

export interface WorkbenchSessionsPort {
  create(input: WorkbenchCreateSessionInput): Promise<{
    id: string;
    status: AgentSessionStatus;
  }>;
  enqueue(sessionId: string, reason: string): Promise<void>;
  findById(id: string): Promise<AgentSession | null>;
  readSummary(id: string): Promise<WorkbenchSessionSummary>;
}
