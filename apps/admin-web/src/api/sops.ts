import { client } from './client';

/**
 * P5/P6：SOP 协议 API（对齐 admin-api sop.controller.ts，全 ADMIN-only）。
 * 协作面（agent-collab）由执行器 Agent 走机器鉴权调用，不经本模块。
 */

export interface Sop {
  id: string;
  slug: string;
  title: string;
  currentVersion: string | null;
  status: 'draft' | 'published' | 'deprecated';
  applicationId: string | null;
  frontMatterJson: Record<string, unknown> | null;
  bodyMarkdown: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface SopVersion {
  id: string;
  sopId: string;
  version: string;
  frontMatterJson: Record<string, unknown>;
  bodyMarkdown: string;
  changelog: string | null;
  contentHash: string;
  publishedBy: string;
  publishedAt: string;
  createdAt: string;
}

export interface SopAssignment {
  id: string;
  sopId: string;
  sopVersion: string;
  targetExecutorId: string | null;
  targetAgentSessionId: string | null;
  status: 'assigned' | 'in_progress' | 'blocked' | 'completed' | 'failed' | 'cancelled' | 'stalled';
  clarificationRound: number;
  maxRounds: number;
  resultJson: Record<string, unknown> | null;
  parentSessionId: string | null;
  pulledAt: string | null;
  lastProgressAt: string | null;
  progressJson: Record<string, unknown> | null;
  attempt: number;
  capabilitySnapshotJson: Record<string, unknown> | null;
  permissionProfileAtPull: string | null;
  assignedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface SopClarification {
  id: string;
  clientClarificationId: string | null;
  assignmentId: string;
  round: number;
  question: string;
  questionContextJson: Record<string, unknown> | null;
  answer: string | null;
  resolution: 'answered' | 'sop_amended' | 'escalated_to_human' | null;
  newSopVersion: string | null;
  mediaRefsJson: Array<{ kind: string; url: string; note?: string }> | null;
  reviewSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const sopsApi = {
  list: (params?: { status?: string; page?: number; pageSize?: number }) =>
    client.get('/sop', { params }) as Promise<{ items: Sop[]; total: number }>,
  get: (id: string) => client.get(`/sop/${id}`) as Promise<Sop>,
  draft: (data: {
    slug: string;
    title: string;
    frontMatterYaml?: string;
    bodyMarkdown?: string;
    applicationId?: string;
  }) => client.post('/sop', data) as Promise<Sop>,
  updateDraft: (id: string, data: { title?: string; frontMatterYaml?: string; bodyMarkdown?: string }) =>
    client.patch(`/sop/${id}`, data) as Promise<Sop>,
  publish: (id: string, data?: { bump?: 'patch' | 'minor' | 'major'; changelog?: string }) =>
    client.post(`/sop/${id}/publish`, data ?? {}) as Promise<{ sop: Sop; version: SopVersion }>,
  assign: (
    id: string,
    data: { version?: string; executorId?: string; executorAddress?: string },
  ) => client.post(`/sop/${id}/assign`, data) as Promise<SopAssignment>,
  versions: (id: string) => client.get(`/sop/${id}/versions`) as Promise<SopVersion[]>,
  assignments: (id: string) => client.get(`/sop/${id}/assignments`) as Promise<SopAssignment[]>,
  assignment: (assignmentId: string) =>
    client.get(`/sop/assignments/${assignmentId}`) as Promise<{
      assignment: SopAssignment;
      clarifications: SopClarification[];
    }>,
  /** 人工回复澄清（P6 升级环收口：与中台 Agent 共用同一道服务层闸门）。 */
  replyClarification: (
    assignmentId: string,
    clarificationId: string,
    data: {
      resolution: 'answered' | 'sop_amended';
      answer: string;
      amendedFrontMatterYaml?: string;
      amendedBodyMarkdown?: string;
      changelog?: string;
    },
  ) =>
    client.post(
      `/sop/assignments/${assignmentId}/clarifications/${clarificationId}/reply`,
      data,
    ) as Promise<{ ok: boolean; newSopVersion?: string }>,
};
