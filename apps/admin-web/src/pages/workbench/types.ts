/**
 * Workbench interactive-session transitional contracts.
 *
 * The interactive endpoints are not present in the on-disk generated OpenAPI
 * types yet. These aliases are intentionally confined to the feature folder so
 * the API layer stays independent and the orchestrator can swap them to
 * `components['schemas'][...]` names listed in GENERATED_SCHEMA_NAMES after
 * the next OpenAPI regeneration.
 */

export type WorkbenchSessionKind = 'chat' | 'sop_authoring' | 'plan';
export type WorkbenchMessageMode = 'followup' | 'steer';
export type WorkbenchApprovalDecision = 'grant' | 'deny' | 'withdraw';
export type ComposerCadence = 'once' | 'daily' | 'weekly' | 'monthly' | 'hourly';

export interface WorkbenchStep {
  seq: number;
  role: string;
  content?: string | null;
  contentPreview?: string | null;
  createdAt?: string | null;
}

export interface WorkbenchToolCall {
  id?: string;
  toolName: string;
  status: string;
  argsPreview?: string | null;
  outputPreview?: string | null;
  errorSummary?: string | null;
  createdAt?: string | null;
  stateChangedAt?: string | null;
}

export interface WorkbenchApprovalItem {
  approvalKey: string;
  toolName: string;
  status: string;
  reason?: string | null;
  argsDigest?: string | null;
  decidedBy?: string | null;
  createdAt?: string | null;
  canDecide?: boolean;
  canWithdraw?: boolean;
  reviewUrl?: string | null;
}

export interface WorkbenchArtifact {
  id: string;
  name: string;
  size: number;
  createdAt?: string | null;
  downloadUrl?: string | null;
  previewUrl?: string | null;
}

export interface WorkbenchSessionDetail {
  sessionId: string;
  title?: string | null;
  kind: string;
  status: string;
  phase?: string;
  conclusion?: unknown;
  errorMessage?: string | null;
  waitingFor?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  stepCount?: number;
  steps: WorkbenchStep[];
  toolCallCount?: number;
  toolCalls: WorkbenchToolCall[];
  approvals?: Record<string, number>;
  approvalItems: WorkbenchApprovalItem[];
  artifacts: WorkbenchArtifact[];
}

export interface WorkbenchSessionListItem {
  sessionId: string;
  title: string | null;
  kind?: string | null;
  status: string;
  createdAt?: string | null;
  sopId?: string | null;
}

export interface WorkbenchCreateChatInput {
  prompt: string;
  title?: string;
  kind?: WorkbenchSessionKind;
  context?: Record<string, unknown>;
}

export interface WorkbenchSessionActionResult {
  ok: boolean;
  sessionId?: string;
  status?: string;
  resumed?: boolean;
}

export interface WorkbenchArtifactPreview {
  name: string;
  mimeType: string;
  size: number;
  truncated: boolean;
  kind: 'text' | 'image' | 'binary';
  content: string | null;
}

/** Exact schema names to switch to after `gen:api-types` picks up the new DTOs. */
export const GENERATED_SCHEMA_NAMES = [
  'CreateWorkbenchChatSessionDto',
  'WorkbenchChatSessionResponseDto',
  'PostWorkbenchMessageDto',
  'WorkbenchSessionActionResponseDto',
  'DecideWorkbenchApprovalDto',
  'ListWorkbenchInteractiveSessionsQueryDto',
  'WorkbenchSessionStepDto',
  'WorkbenchSessionToolCallDto',
  'WorkbenchSessionApprovalDto',
  'WorkbenchSessionArtifactDto',
  'WorkbenchSessionDetailResponseDto',
  'ArtifactPreviewResponseDto',
] as const;
