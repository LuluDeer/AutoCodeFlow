import { Button, Tag, Tooltip, Typography, theme } from 'antd';
import { useTranslation } from 'react-i18next';
import { sopsApi, type SopAssignment, type SopClarification, type SopMedia } from '../../api/sops';
import { message } from '../../utils/toast';
import { formatDateTime } from '../../utils/timeFormat';
import { sopClarResolutionLabel, sopMediaKindLabel } from '../../utils/sop-label';
import {
  isReassignableAssignmentStatus,
  isReplyableAssignmentStatus,
} from './sop-deeplink';

const { Text, Paragraph } = Typography;

export interface AssignmentClarificationsListProps {
  assignments: SopAssignment[];
  clarifications: Record<string, SopClarification[]>;
  media: Record<string, SopMedia[]>;
  highlightedAssignmentId: string | null;
  onReply: (assignmentId: string, clarificationId: string) => void;
  onViewMedia: (platformPath: string) => void;
}

/**
 * R289：指派回传媒体与澄清列表（从 `SopsPage` 外提，守体量棘轮）。
 *
 * - 每条澄清标注所属指派短 ID，深链命中目标指派时高亮展示，避免多工单混排看不清归属；
 * - `cancelled | completed` 指派隐藏「回复」入口（对齐后端 `humanReply` 守卫）；
 *   保留 `failed | stalled` 的既有接管答复与「答复不投递、重派恢复」提示口径。
 */
export default function AssignmentClarificationsList({
  assignments,
  clarifications,
  media,
  highlightedAssignmentId,
  onReply,
  onViewMedia,
}: AssignmentClarificationsListProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const hasMedia = assignments.some((a) => (media[a.id]?.length ?? 0) > 0);
  const hasClarifications = assignments.some((a) => (clarifications[a.id]?.length ?? 0) > 0);

  if (!hasMedia && !hasClarifications) {
    return null;
  }

  return (
    <>
      {hasMedia && (
        <div style={{ marginTop: 16 }}>
          <Text strong>{t('sops.mediaTitle')}</Text>
          {assignments
            .filter((a) => (media[a.id]?.length ?? 0) > 0)
            .flatMap((a) =>
              (media[a.id] ?? []).map((m) => (
                <div key={m.id} style={{ marginTop: 4 }}>
                  <Button
                    size="small"
                    onClick={() => void sopsApi.viewMedia(m.id).catch(() => message.error(t('sops.mediaViewFailed')))}
                  >
                    {t('sops.mediaView')}
                  </Button>
                  <Text style={{ marginLeft: 8 }}>
                    {m.name} · {Math.round(m.sizeBytes / 1024)}KB · {formatDateTime(m.createdAt)}
                  </Text>
                </div>
              )),
            )}
        </div>
      )}
      {hasClarifications && (
        <div style={{ marginTop: 16 }}>
          {assignments
            .filter((a) => (clarifications[a.id]?.length ?? 0) > 0)
            .flatMap((a) => {
              const isHighlighted = highlightedAssignmentId === a.id;
              const canReply = isReplyableAssignmentStatus(a.status);
              return (clarifications[a.id] ?? []).map((c) => (
                <div
                  key={c.id}
                  data-testid={`sop-clarification-${c.id}`}
                  data-assignment-id={a.id}
                  data-highlighted={isHighlighted ? 'true' : undefined}
                  style={{
                    marginBottom: 12,
                    padding: isHighlighted ? 8 : 0,
                    borderRadius: isHighlighted ? token.borderRadius : 0,
                    backgroundColor: isHighlighted ? token.colorPrimaryBg : undefined,
                    border: isHighlighted ? `1px solid ${token.colorPrimaryBorder}` : undefined,
                  }}
                >
                  <Tag style={{ marginRight: 6 }}>{a.id.slice(0, 8)}…</Tag>
                  {isHighlighted && (
                    <Tag color="processing" style={{ marginRight: 6 }}>
                      {t('sops.assignmentCancel.targetTag')}
                    </Tag>
                  )}
                  <Text strong>
                    #{c.round} · {c.resolution ? sopClarResolutionLabel(c.resolution, t) : t('sops.clarResolution.pending')}
                  </Text>
                  {c.newSopVersion && <Tag style={{ marginLeft: 8 }}>→ {c.newSopVersion}</Tag>}
                  {/* P7d 双端 ACK：游标推进过该行才算执行器已确认 */}
                  {c.resolution !== null && (
                    a.lastReplyDeliveredAt !== null &&
                    new Date(a.lastReplyDeliveredAt).getTime() >= new Date(c.updatedAt).getTime()
                      ? <Tag style={{ marginLeft: 8 }} color="green">{t('sops.replyAcked')}</Tag>
                      : <Tag style={{ marginLeft: 8 }} color="orange">{t('sops.replyAwaitingAck')}</Tag>
                  )}
                  {/* R289：已取消/已完成指派隐藏答复入口，与后端 humanReply 守卫一致 */}
                  {canReply && (c.resolution === null || c.resolution === 'escalated_to_human') && (
                    <Button
                      size="small"
                      style={{ marginLeft: 8 }}
                      onClick={() => onReply(a.id, c.id)}
                    >
                      {t('sops.reply')}
                    </Button>
                  )}
                  {/* 升级终态：接管答复不投递，重派即恢复路径 */}
                  {c.resolution === 'escalated_to_human' && isReassignableAssignmentStatus(a.status) && (
                    <Tooltip title={t('sops.reassignEscalatedHint')}>
                      <Text type="warning" style={{ marginLeft: 8 }}>{t('sops.escalatedNotDelivered')}</Text>
                    </Tooltip>
                  )}
                  <Paragraph style={{ marginBottom: 4 }}>{c.question}</Paragraph>
                  {(c.mediaRefsJson?.length ?? 0) > 0 && (
                    <Paragraph style={{ marginBottom: 4 }}>
                      <Text type="secondary">{t('sops.mediaRefsLabel')}</Text>
                      {(c.mediaRefsJson ?? []).map((ref) => (
                        <Button
                          key={ref.url}
                          size="small"
                          style={{ marginRight: 8 }}
                          onClick={() => onViewMedia(ref.url)}
                        >
                          {t('sops.mediaView')} · {sopMediaKindLabel(ref.kind, t)}
                        </Button>
                      ))}
                    </Paragraph>
                  )}
                  {c.answer && (
                    <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                      {c.answer}
                    </Paragraph>
                  )}
                </div>
              ));
            })}
        </div>
      )}
    </>
  );
}
