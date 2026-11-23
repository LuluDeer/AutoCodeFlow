import { INBOX_REFRESH_EVENT } from '../../api/inbox';
import type { SopAssignment } from '../../api/sops';

/**
 * R289：单条取消允许的前置状态集合，与后端条件写 `WHERE status IN (...)` 逐字一致。
 *
 * `stalled` 属于活跃非终态（执行器心跳可将其恢复为 `in_progress`，且会阻断 SOP 归档），
 * 因此必须纳入可取消集合。
 */
export const CANCELLABLE_ASSIGNMENT_STATUSES: readonly SopAssignment['status'][] = [
  'assigned',
  'in_progress',
  'blocked',
  'stalled',
];

/** 允许换机重派的工单状态集合（终态失败/取消，以及长时间停滞可另起新单）。 */
export const REASSIGNABLE_ASSIGNMENT_STATUSES: readonly SopAssignment['status'][] = [
  'failed',
  'stalled',
  'cancelled',
];

/** 禁止人工答复澄清的指派状态（与后端 `SopController.humanReply` 守卫一致）。 */
const NON_REPLYABLE_ASSIGNMENT_STATUSES: readonly SopAssignment['status'][] = [
  'cancelled',
  'completed',
];

export function isCancellableAssignmentStatus(status: SopAssignment['status']): boolean {
  return CANCELLABLE_ASSIGNMENT_STATUSES.includes(status);
}

export function isReassignableAssignmentStatus(status: SopAssignment['status']): boolean {
  return REASSIGNABLE_ASSIGNMENT_STATUSES.includes(status);
}

export function isReplyableAssignmentStatus(status: SopAssignment['status']): boolean {
  return !NON_REPLYABLE_ASSIGNMENT_STATUSES.includes(status);
}

export interface SopDeepLinkTarget {
  sopId: string | null;
  assignmentId: string | null;
  /** 去重键：同 SOP 切换不同 assignmentId 时也视为新的深链目标。 */
  key: string | null;
  initialTab: 'contract' | 'assignments';
}

/**
 * 指派工单 id 是 UUID（后端 `@IsUUID()`）。深链参数先做形状校验：
 * 非法/残缺值直接忽略，不带着坏 id 去拉详情、也不静默留空高亮。
 */
const ASSIGNMENT_UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeAssignmentId(raw: string | null): string | null {
  if (!raw || !ASSIGNMENT_UUID_SHAPE.test(raw)) return null;
  return raw;
}

/** 解析 `/sops?sop=<sopId>&assignment=<assignmentId>` 查询参数。 */
export function resolveSopDeepLink(searchParams: URLSearchParams): SopDeepLinkTarget {
  const sopId = searchParams.get('sop')?.trim() || null;
  const rawAssignment = searchParams.get('assignment')?.trim() || null;
  // 形状校验只作用于「高亮/定位用的 id」；页签仍按参数是否存在切换到指派 Tab
  // （非法 id 静默降级停在指派 Tab、不高亮，是 R289 B 既有契约）。
  const assignmentId = normalizeAssignmentId(rawAssignment);
  return {
    sopId,
    assignmentId,
    key: sopId ? `${sopId}::${assignmentId ?? rawAssignment ?? ''}` : null,
    initialTab: rawAssignment ? 'assignments' : 'contract',
  };
}

/** 指派表格目标行的 DOM id，供 `scrollToSectionWhenReady` 精准滚动。 */
export function assignmentRowDomId(assignmentId: string): string {
  return `sop-assignment-${assignmentId}`;
}

/** 从 Axios / AppError 响应体中提取后端业务错误码。 */
export function extractApiErrorCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const axiosCode = (err as { response?: { data?: { errorCode?: unknown } } })
    ?.response?.data?.errorCode;
  if (typeof axiosCode === 'string' && axiosCode.trim()) return axiosCode.trim();
  const directCode = (err as { errorCode?: unknown }).errorCode;
  if (typeof directCode === 'string' && directCode.trim()) return directCode.trim();
  return null;
}

/**
 * 单条取消遇到「已终态（HTTP 400 `SOP_ASSIGNMENT_TERMINAL`）」或「指派不存在
 * （HTTP 404 `SOP_ASSIGNMENT_NOT_FOUND`）」时，说明本地视图已过期：
 * 应关闭弹窗并刷新抽屉与收件箱计数，而不是把用户困在已失效的确认弹窗里。
 */
export function shouldRefreshOnCancelError(err: unknown): boolean {
  const code = extractApiErrorCode(err);
  return code === 'SOP_ASSIGNMENT_TERMINAL' || code === 'SOP_ASSIGNMENT_NOT_FOUND';
}

/** 通知顶栏 `InboxBadge` 立即重拉计数（单条/批量取消指派后同步扣减阻塞工单计数）。 */
export function dispatchInboxRefresh(): void {
  window.dispatchEvent(new CustomEvent(INBOX_REFRESH_EVENT));
}
