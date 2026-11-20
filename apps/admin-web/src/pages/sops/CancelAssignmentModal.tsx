import { Form, Input, Modal, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import type { SopAssignment } from '../../api/sops';
import {
  CANCEL_ASSIGNMENT_FIELD_ID,
  CANCEL_ASSIGNMENT_REASON_MAX,
} from './useCancelAssignment';

const { Paragraph } = Typography;

export interface CancelAssignmentModalProps {
  target: SopAssignment | null;
  reason: string;
  onReasonChange: (value: string) => void;
  submitting: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}

/**
 * R289：单条 SOP 指派取消二次确认弹窗（从 `SopsPage` 外提，守体量棘轮）。
 *
 * 可选填取消原因（上限 500 字），服务端经脱敏后记入 `sop.assignment.cancel` 审计明细。
 */
export default function CancelAssignmentModal({
  target,
  reason,
  onReasonChange,
  submitting,
  onSubmit,
  onCancel,
}: CancelAssignmentModalProps) {
  const { t } = useTranslation();

  return (
    <Modal
      title={t('sops.assignmentCancel.title')}
      open={target !== null}
      onOk={onSubmit}
      onCancel={onCancel}
      confirmLoading={submitting}
      okText={t('sops.assignmentCancel.confirmBtn')}
      cancelText={t('sops.cancel')}
      okButtonProps={{ danger: true }}
      width={520}
      destroyOnHidden
    >
      <Form layout="vertical" component={false}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Paragraph style={{ marginBottom: 4 }}>
            {t('sops.assignmentCancel.desc', {
              id: target ? `${target.id.slice(0, 8)}…` : '',
              version: target?.sopVersion ?? '',
            })}
          </Paragraph>
          <Form.Item
            label={t('sops.field.cancelReason')}
            htmlFor={CANCEL_ASSIGNMENT_FIELD_ID.reason}
            style={{ marginBottom: 0 }}
          >
            <Input.TextArea
              id={CANCEL_ASSIGNMENT_FIELD_ID.reason}
              rows={3}
              maxLength={CANCEL_ASSIGNMENT_REASON_MAX}
              showCount
              placeholder={t('sops.assignmentCancel.reasonPlaceholder')}
              value={reason}
              onChange={(e) => onReasonChange(e.target.value)}
            />
          </Form.Item>
        </div>
      </Form>
    </Modal>
  );
}
