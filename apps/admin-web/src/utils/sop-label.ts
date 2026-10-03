/**
 * SOP 域枚举 → i18n 展示标签的**读面唯一事实源**。
 *
 * UX-06 第二扫治理：SopsPage 此前四处直接渲染后端裸枚举——
 *  - SOP 状态：`<Tag color={color}>{status}</Tag>`（draft/published/deprecated 全裸）；
 *  - 指派（工单）状态：`<Tag color={map[status]}>{status}</Tag>`（7 值全裸）；
 *  - 澄清处置：`{c.resolution ?? 'pending'}`（answered/sop_amended/escalated_to_human
 *    与 null 态的 'pending' 全裸）；
 *  - 澄清附件类型：`{ref.kind}`（video/screenshot/other 全裸）。
 *
 * 取值来源（与前端 api/sops.ts 的类型同源）：
 *  - admin-api sop.entity.ts：SOP_STATUSES
 *  - admin-api sop-assignment.entity.ts：SOP_ASSIGNMENT_STATUSES
 *  - admin-api sop-clarification.entity.ts：SOP_CLARIFICATION_RESOLUTIONS /
 *    SopClarificationMediaRef.kind
 *
 * 未知值回退**原始 token**（不显示"未知"）：保留可诊断信息——与
 * trigger-label.ts / agent-label.ts 同策。后端新增取值而本表未跟时，
 * 页面露出的是可搜索的后端值，而不是渲染成 i18n 键名。
 */

/** Sop.status 的已知取值（SOP 生命周期，见 sop.entity.ts SOP_STATUSES）。 */
export const SOP_STATUS_T_KEYS: Record<string, string> = {
  draft: 'sops.status.draft',
  published: 'sops.status.published',
  deprecated: 'sops.status.deprecated',
};

/** Tag 配色：与 SopsPage 既有观感一致（提取时原样保留，不改视觉）。 */
export const SOP_STATUS_COLOR: Record<string, string> = {
  draft: 'gold',
  published: 'green',
  deprecated: 'default',
};

/** SopAssignment.status 的已知取值（工单状态机，见 sop-assignment.entity.ts）。 */
export const SOP_ASSIGNMENT_STATUS_T_KEYS: Record<string, string> = {
  assigned: 'sops.assignmentStatus.assigned',
  in_progress: 'sops.assignmentStatus.inProgress',
  blocked: 'sops.assignmentStatus.blocked',
  completed: 'sops.assignmentStatus.completed',
  failed: 'sops.assignmentStatus.failed',
  cancelled: 'sops.assignmentStatus.cancelled',
  stalled: 'sops.assignmentStatus.stalled',
};

/** Tag 配色：与 SopsPage 既有观感一致（提取时原样保留，不改视觉）。 */
export const SOP_ASSIGNMENT_STATUS_COLOR: Record<string, string> = {
  assigned: 'blue',
  in_progress: 'processing',
  blocked: 'orange',
  completed: 'green',
  failed: 'red',
  cancelled: 'default',
  stalled: 'volcano',
};

/**
 * SopClarification.resolution 的已知取值（澄清处置，见 sop-clarification.entity.ts
 * SOP_CLARIFICATION_RESOLUTIONS）。NULL = 待中台 Agent 复核（前端伪态 pending，
 * 调用方负责判空后用 t('sops.clarResolution.pending') 兜底）。
 */
export const SOP_CLAR_RESOLUTION_T_KEYS: Record<string, string> = {
  answered: 'sops.clarResolution.answered',
  sop_amended: 'sops.clarResolution.sopAmended',
  escalated_to_human: 'sops.clarResolution.escalatedToHuman',
};

/** SopClarificationMediaRef.kind 的已知取值（澄清附件类型，闭集）。 */
export const SOP_MEDIA_KIND_T_KEYS: Record<string, string> = {
  video: 'sops.mediaKind.video',
  screenshot: 'sops.mediaKind.screenshot',
  other: 'sops.mediaKind.other',
};

function labelOf(
  map: Record<string, string>,
  value: string | null | undefined,
  t: (key: string) => string,
): string {
  if (value === null || value === undefined || value === '') return '';
  const key = map[value];
  return key ? t(key) : value;
}

export function sopStatusLabel(
  status: string | null | undefined,
  t: (key: string) => string,
): string {
  return labelOf(SOP_STATUS_T_KEYS, status, t);
}

export function sopAssignmentStatusLabel(
  status: string | null | undefined,
  t: (key: string) => string,
): string {
  return labelOf(SOP_ASSIGNMENT_STATUS_T_KEYS, status, t);
}

export function sopClarResolutionLabel(
  resolution: string | null | undefined,
  t: (key: string) => string,
): string {
  return labelOf(SOP_CLAR_RESOLUTION_T_KEYS, resolution, t);
}

export function sopMediaKindLabel(
  kind: string | null | undefined,
  t: (key: string) => string,
): string {
  return labelOf(SOP_MEDIA_KIND_T_KEYS, kind, t);
}
