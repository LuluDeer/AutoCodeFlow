import { Button, Space, Tooltip } from 'antd';
import { useTranslation } from 'react-i18next';
import type { SopAssignment } from '../../api/sops';
import {
  isCancellableAssignmentStatus,
  isReassignableAssignmentStatus,
} from './sop-deeplink';

export interface AssignmentActionCellProps {
  assignment: SopAssignment;
  hasEscalatedClarification: boolean;
  onCancel: (assignment: SopAssignment) => void;
  onReassign: (assignment: SopAssignment) => void;
}

/**
 * R289：指派列表行尾操作单元格（从 `SopsPage` 外提，守体量棘轮）。
 *
 * - 4 个活跃非终态（`assigned | in_progress | blocked | stalled`）：提供「取消指派」；
 * - 可重派态（`failed | stalled | cancelled`）：提供「重派」（升级终态行附提示）；
 * - `stalled` 同时具备两种动作（先取消防复活心跳，或直接换机重派）；`completed` 返回 null。
 */
export default function AssignmentActionCell({
  assignment,
  hasEscalatedClarification,
  onCancel,
  onReassign,
}: AssignmentActionCellProps) {
  const { t } = useTranslation();
  const canCancel = isCancellableAssignmentStatus(assignment.status);
  const canReassign = isReassignableAssignmentStatus(assignment.status);

  if (!canCancel && !canReassign) return null;

  const reassignButton = canReassign ? (
    <Button
      size="small"
      data-testid={`sop-assignment-reassign-${assignment.id}`}
      onClick={() => onReassign(assignment)}
    >
      {t('sops.reassign')}
    </Button>
  ) : null;

  return (
    <Space size={4} wrap>
      {canCancel && (
        <Button
          size="small"
          danger
          data-testid={`sop-assignment-cancel-${assignment.id}`}
          onClick={() => onCancel(assignment)}
        >
          {t('sops.assignmentCancel.btn')}
        </Button>
      )}
      {reassignButton && (
        hasEscalatedClarification ? (
          <Tooltip title={t('sops.reassignEscalatedHint')}>{reassignButton}</Tooltip>
        ) : (
          reassignButton
        )
      )}
    </Space>
  );
}
