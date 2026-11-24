/**
 * T1（P1）读失败诚实性：最近失败明细卡。
 *
 * 从 DashboardPage 外提（棘轮：页面本体只留一行组件调用）。三态互斥：
 *   ① 读失败（failError）→ danger 文案 + 重试提示，绝不渲染「近期无失败」绿色健康态；
 *   ② 未回包（failures === undefined，无错误）→ 骨架；
 *   ③ 读到空数组 → 真·空态；非空 → 明细列表。
 * 「没读到」与「确实没有」是两种事实，旧实现把 ① 和 ③ 折叠成同一个绿色空态。
 *
 * R281-DEEPLINK-01：本卡的「全部记录」深链保持在父页面（刻意不带 status），
 * 本组件内的单条明细仍是到执行详情页的深链（保留真实 href，键盘可达）。
 */
import { Alert, Space, Tag, Tooltip, Typography } from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { RecentFailure } from '../../api/metrics';
import { formatDuration } from '../../utils/timeFormat';
import { failureReasonLabel } from '../../utils/failure-reason-label';
import { CHART_COLORS } from '../../theme/tokens';
import PageSkeleton from '../PageSkeleton';
import '../../i18n';

const { Text } = Typography;

export interface RecentFailuresCardProps {
  failures: RecentFailure[] | undefined;
  /** 读取错误（useRecentFailures.error）；非空即「未知」，不是「无失败」。 */
  failError: unknown;
  /** 打开某条执行：父页面负责带当前项目上下文的导航。 */
  onOpenExecution: (executionId: string, taskId: string) => void;
}

export default function RecentFailuresCard({ failures, failError, onOpenExecution }: RecentFailuresCardProps) {
  const { t } = useTranslation();

  if (failError) {
    return (
      <div
        data-testid="recent-failures-read-failed"
        style={{ textAlign: 'center', padding: '24px 0', color: 'var(--chart-axis-text)', fontSize: 12 }}
      >
        <CloseCircleOutlined style={{ fontSize: 28, color: CHART_COLORS.failed, marginBottom: 8 }} />
        <div><Text type="danger">{t('dashboard.recentFailures.readFailed')}</Text></div>
      </div>
    );
  }

  // 请求在途/尚未回包：与父页面原来的 failLoading && !failures 分支等价。
  if (!failures) return <PageSkeleton variant="table" rows={2} />;

  const failureList = failures.slice(0, 8);

  if (failureList.length === 0) {
    return (
      <div data-testid="recent-failures-empty" style={{ textAlign: 'center', padding: '24px 0' }}>
        <CheckCircleOutlined style={{ fontSize: 28, color: CHART_COLORS.success }} />
        <div style={{ marginTop: 8 }}>
          <Text type="secondary">{t('dashboard.noFailures')}</Text>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {failureList.map(f => (
        <Alert
          key={f.id}
          type="error"
          showIcon={false}
          style={{ padding: '6px 10px', borderRadius: 6 }}
          title={
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                {/* U6: 直接链到执行详情页，失败溯源一步到位 */}
                {/* F-33（DEEP_REVIEW 0ef3bbe）：保留真实 href（键盘可达 + 可新标签打开），
                    点击走父页面回调以复用统一的导航口径。 */}
                <Link
                  to={`/tasks/${f.taskId}/executions/${f.id}`}
                  onClick={e => { e.preventDefault(); onOpenExecution(f.id, f.taskId); }}
                  style={{ fontSize: 12, fontWeight: 500, display: 'block' }}
                >
                  {f.taskName}
                </Link>
                <Tooltip title={f.errorMessage}>
                  <Text
                    type="secondary"
                    style={{ fontSize: 11, display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                  >
                    {f.errorMessage || t('dashboard.unknownError')}
                  </Text>
                </Tooltip>
                {/* U6: 消费后端 failureReason + exitCode */}
                {(f.failureReason || f.exitCode != null) && (
                  <Space size={4} style={{ marginTop: 2 }}>
                    {f.failureReason && (
                      <Tooltip title={f.failureReason}>
                        <Tag color="volcano" style={{ fontSize: 10, lineHeight: '16px', marginInlineEnd: 0 }}>
                          {failureReasonLabel(f.failureReason, t)}
                        </Tag>
                      </Tooltip>
                    )}
                    {f.exitCode != null && (
                      <Tag style={{ fontSize: 10, lineHeight: '16px', marginInlineEnd: 0 }}>exit {f.exitCode}</Tag>
                    )}
                  </Space>
                )}
              </div>
              <Text type="secondary" style={{ fontSize: 11, marginLeft: 8, whiteSpace: 'nowrap' }}>
                {formatDuration(f.duration, t)}
              </Text>
            </div>
          }
        />
      ))}
    </div>
  );
}
