/**
 * N10 workbench Part 模型：12 类判别联合 + generation / share / blob 的纯类型与投影层。
 *
 * 纪律：
 * - 零 Nest / DB / I/O 依赖；不读时钟、不读随机，同一入参永远得到同一投影。
 * - generation 与 N23 capability generation swap 同口径：opaque string token，
 *   相等即同代；缺失（null/undefined）判旧（fail-closed），空串是合法 token。
 * - 大字段用 BlobRef 做类型标记（本层不写存储）；会话 share 用 SessionShare
 *   做可见性标记（本层不做鉴权）。
 */

/** 与 capability 侧 generation-swap.ts 对齐的不透明代际 token（16-hex 字符串）。 */
export type GenerationToken = string;

/** 任何带代际标记的结构的最小面，供 isStaleGeneration 消费。 */
export interface GenerationMarked {
  generation?: GenerationToken | null;
}

/** opencode Part 的 12 类判别取值（对应 v1/session.ts:357-383 的 Part union）。 */
export const WORKBENCH_PART_KINDS = [
  "text",
  "reasoning",
  "tool",
  "step-start",
  "step-finish",
  "file",
  "agent",
  "subtask",
  "compaction",
  "snapshot",
  "patch",
  "retry",
] as const;

export type WorkbenchPartKind = (typeof WORKBENCH_PART_KINDS)[number];

/**
 * 大字段的逻辑引用。blobKey 是稳定派生的 key（形如 part:<id>:<field>），
 * byteLength 供上层核对；本层只标记，不读写任何存储。
 */
export interface BlobRef {
  blobKey: string;
  byteLength: number;
  mimeType?: string;
}

/** 天然带大字段的 Part 类别（tool 输出 / file 内容 / compaction 摘要 / patch 文本）。 */
export const BLOB_BACKED_KINDS = [
  "tool",
  "file",
  "compaction",
  "patch",
] as const;
export type BlobBackedKind = (typeof BLOB_BACKED_KINDS)[number];

/** 会话级 share 标记：private 仅所有者可见；session 同会话可见。 */
export type ShareVisibility = "private" | "session";

export interface SessionShare {
  visibility: ShareVisibility;
  /** 可选分享 token；本层只做标记，不校验。 */
  token?: string | null;
}

/** 所有 Part 的公共面。 */
export interface WorkbenchPartBase extends GenerationMarked {
  id: string;
  sessionId: string;
  /** 会话级 share 标记；缺省按 private 处理。 */
  share?: SessionShare | null;
  /** 大字段入 blob 后的引用列表；缺省为空。 */
  blobRefs?: readonly BlobRef[];
}

export interface TextPart extends WorkbenchPartBase {
  kind: "text";
  text: string;
}

export interface ReasoningPart extends WorkbenchPartBase {
  kind: "reasoning";
  text: string;
  signature?: string;
}

export interface ToolPart extends WorkbenchPartBase {
  kind: "tool";
  toolCallId: string;
  toolName: string;
  state: "pending" | "running" | "completed" | "error";
  /** 工具输出为大字段：只经 blobRefs 标记引用，本层不内联内容。 */
}

export interface StepStartPart extends WorkbenchPartBase {
  kind: "step-start";
  step: number;
}

export interface StepFinishPart extends WorkbenchPartBase {
  kind: "step-finish";
  step: number;
  reason?: string;
  cost?: number;
  tokens?: number;
}

export interface FilePart extends WorkbenchPartBase {
  kind: "file";
  mime: string;
  filename?: string;
  /** 文件内容为大字段：只经 blobRefs 标记引用，本层不内联内容。 */
}

export interface AgentPart extends WorkbenchPartBase {
  kind: "agent";
  name: string;
  prompt?: string;
}

export interface SubtaskPart extends WorkbenchPartBase {
  kind: "subtask";
  subtaskId: string;
  description?: string;
}

export interface CompactionPart extends WorkbenchPartBase {
  kind: "compaction";
  /** 压缩摘要为大字段：只经 blobRefs 标记引用，本层不内联内容。 */
}

export interface SnapshotPart extends WorkbenchPartBase {
  kind: "snapshot";
  snapshotId: string;
  messageCount?: number;
}

export interface PatchPart extends WorkbenchPartBase {
  kind: "patch";
  hash: string;
  files: readonly string[];
  /** patch diff 为大字段：只经 blobRefs 标记引用，本层不内联内容。 */
}

export interface RetryPart extends WorkbenchPartBase {
  kind: "retry";
  attempt: number;
  reason?: string;
}

/** 12 类 Part 的判别联合；kind 为判别字段。 */
export type WorkbenchPart =
  | TextPart
  | ReasoningPart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | FilePart
  | AgentPart
  | SubtaskPart
  | CompactionPart
  | SnapshotPart
  | PatchPart
  | RetryPart;

/**
 * 代际陈旧判定（fail-closed）。part 缺失、part.generation 缺失
 * （严格 null/undefined）、或与 currentGeneration 不等即为陈旧。
 * 空串是合法 opaque token，按严格 === 比较，不视为缺失。
 */
export function isStaleGeneration(
  part: GenerationMarked | null | undefined,
  currentGeneration: GenerationToken,
): boolean {
  if (part == null) return true;
  const generation = part.generation;
  if (generation === null || generation === undefined) return true;
  return generation !== currentGeneration;
}

/** 该 Part 类别是否天然带大字段（用于上层决定走 blob 投影）。 */
export function isBlobBackedKind(kind: WorkbenchPartKind): boolean {
  return (BLOB_BACKED_KINDS as readonly string[]).includes(kind);
}

/** 会话级 share 的可见性判定：session  anyone-in-session；private 仅所有者。 */
export function isPartVisible(
  part: WorkbenchPart,
  viewerIsOwner: boolean,
): boolean {
  const visibility = part.share?.visibility ?? "private";
  return visibility === "session" || viewerIsOwner;
}

export interface ProjectionContext {
  currentGeneration: GenerationToken;
  viewerIsOwner: boolean;
}

/** 投影结果：可见面 + 陈旧判定 + blob 引用标记，全部为纯数据。 */
export interface PartProjection {
  id: string;
  sessionId: string;
  kind: WorkbenchPartKind;
  generation: GenerationToken | null;
  stale: boolean;
  visible: boolean;
  blobRefs: readonly BlobRef[];
}

/** 纯投影：不写存储、不做鉴权，只按入参计算可见面与陈旧标记。 */
export function projectPart(
  part: WorkbenchPart,
  ctx: ProjectionContext,
): PartProjection {
  return {
    id: part.id,
    sessionId: part.sessionId,
    kind: part.kind,
    generation: part.generation ?? null,
    stale: isStaleGeneration(part, ctx.currentGeneration),
    visible: isPartVisible(part, ctx.viewerIsOwner),
    blobRefs: part.blobRefs ?? [],
  };
}
