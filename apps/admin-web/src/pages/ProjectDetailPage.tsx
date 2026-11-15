import {
  Button, Card, Col, Empty, Row, Statistic, Table, Tag, Tooltip, Typography,
} from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  projectsApi,
  type ProjectSummary,
  type ProjectSummaryRecentExecution,
  type ProjectSummaryRecentFailure,
} from '../api/projects';
import { queryKeys } from '../api/queries';
import PageHeader from '../components/PageHeader';
import PageSkeleton from '../components/PageSkeleton';
import StateError from '../components/StateError';
import { formatDateTime, formatDuration } from '../utils/timeFormat';
// P3 审计：执行状态 → Tag color 单一事实源
import { EXECUTION_TAG_COLOR } from '../utils/status-color';
import { failureReasonLabel } from '../utils/failure-reason-label';
import '../i18n';

const { Text } = Typography;

/**
 * P1-2：项目详情页（`/projects/:id`）。
 *
 * 闭环：项目列表「详情」入口 → 本页拉取项目实体 + `GET /projects/:id/summary`，
 * 展示任务数 / 应用数 / 成员数 / 近 7 天执行数 / 失败率 / 近 7 天失败数，以及
 * 最近失败与最近活动各 5 条。
 *
 * ## 数字纪律（与后端 DTO 注释同口径）
 *
 * - 失败率 `failureRate` 为 `null` 表示近 7 天窗口内无执行——前端显示「暂无数据」，
 *   **不渲染 0%**；其余计数为后端真实查询结果，0 是合法值。
 * - 应用数当前受写入口限制（应用 DTO 尚未开放 projectId），非默认项目预期为 0，
 *   这是真实查询结果，前端不补假统计。
 * - 最近失败/活动列表为空时返回空数组，走空态而非占位行。
 */
export default function ProjectDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const entityQuery = useQuery({
    queryKey: queryKeys.projects.detail(id),
    queryFn: ({ signal }) => projectsApi.getOne(id, signal),
    enabled: !!id,
  });
  const summaryQuery = useQuery({
    queryKey: queryKeys.projects.summary(id),
    queryFn: ({ signal }) => projectsApi.summary(id, signal),
    enabled: !!id,
  });

  const loading = entityQuery.isLoading || summaryQuery.isLoading;
  const error = entityQuery.error ?? summaryQuery.error;

  if (loading) {
    return (
      <div>
        <PageHeader title={t('projects.detail.title')} />
        <PageSkeleton variant="table" />
      </div>
    );
  }
  if (error) {
    return (
      <div>
        <PageHeader title={t('projects.detail.title')} />
        <StateError
          error={error}
          onRetry={() => {
            void entityQuery.refetch();
            void summaryQuery.refetch();
          }}
        />
      </div>
    );
  }

  const summary: ProjectSummary | undefined = summaryQuery.data;
  const entity = entityQuery.data;
  const title = entity?.name ?? summary?.projectName ?? id;

  const statusTag = (status: string) => (
    <Tag color={EXECUTION_TAG_COLOR[status] ?? 'default'}>
      {t(`execs.status.${status}`, status)}
    </Tag>
  );

  const failureColumns = [
    {
      title: t('projects.detail.recentFailures.col.task'),
      dataIndex: 'taskName',
      key: 'taskName',
      ellipsis: { showTitle: false },
      render: (v: string) => (
        <Text ellipsis={{ tooltip: v }} style={{ display: 'block' }}>{v}</Text>
      ),
    },
    {
      title: t('projects.detail.recentFailures.col.status'),
      dataIndex: 'status',
      key: 'status',
      width: 110,
      render: (v: string) => statusTag(v),
    },
    {
      title: t('projects.detail.recentFailures.col.reason'),
      dataIndex: 'failureReason',
      key: 'failureReason',
      width: 150,
      render: (v: string | null | undefined) =>
        v ? <Tag>{failureReasonLabel(v, t)}</Tag> : <Text type="secondary">—</Text>,
    },
    {
      title: t('projects.detail.recentFailures.col.message'),
      dataIndex: 'errorMessage',
      key: 'errorMessage',
      ellipsis: { showTitle: false },
      render: (v: string | null | undefined) =>
        v ? (
          <Text type="secondary" ellipsis={{ tooltip: v }} style={{ display: 'block' }}>
            {v}
          </Text>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: t('projects.detail.recentFailures.col.time'),
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 170,
      render: (v: string) => formatDateTime(v),
    },
    {
      title: t('projects.detail.recentFailures.col.duration'),
      dataIndex: 'duration',
      key: 'duration',
      width: 110,
      render: (v: number | null | undefined) =>
        formatDuration(v, t),
    },
  ];

  const activityColumns = [
    {
      title: t('projects.detail.recentActivity.col.task'),
      dataIndex: 'taskName',
      key: 'taskName',
      ellipsis: { showTitle: false },
      render: (v: string) => (
        <Text ellipsis={{ tooltip: v }} style={{ display: 'block' }}>{v}</Text>
      ),
    },
    {
      title: t('projects.detail.recentActivity.col.status'),
      dataIndex: 'status',
      key: 'status',
      width: 110,
      render: (v: string) => statusTag(v),
    },
    {
      title: t('projects.detail.recentActivity.col.time'),
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 170,
      render: (v: string) => formatDateTime(v),
    },
    {
      title: t('projects.detail.recentActivity.col.duration'),
      dataIndex: 'duration',
      key: 'duration',
      width: 110,
      render: (v: number | null | undefined) => formatDuration(v, t),
    },
  ];

  const failures: ProjectSummaryRecentFailure[] = summary?.recentFailures ?? [];
  const activity: ProjectSummaryRecentExecution[] = summary?.recentExecutions ?? [];

  const failureRateValue =
    summary?.failureRate === null || summary?.failureRate === undefined
      ? t('projects.detail.noData')
      : summary.failureRate;

  return (
    <div>
      <PageHeader
        title={title}
        description={entity?.description ?? undefined}
        extra={
          <Button icon={<ArrowLeftOutlined aria-hidden />} onClick={() => navigate('/projects')}>
            {t('projects.detail.back')}
          </Button>
        }
      />

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} sm={8} md={4}>
          <Card size="small" style={{ height: '100%' }}>
            <Statistic title={t('projects.detail.stat.tasks')} value={summary?.taskCount ?? 0} />
          </Card>
        </Col>
        <Col xs={24} sm={8} md={4}>
          <Card size="small" style={{ height: '100%' }}>
            <Statistic
              title={
                <Tooltip title={t('projects.detail.stat.appsHint')}>
                  <span>{t('projects.detail.stat.apps')}</span>
                </Tooltip>
              }
              value={summary?.applicationCount ?? 0}
            />
          </Card>
        </Col>
        <Col xs={24} sm={8} md={4}>
          <Card size="small" style={{ height: '100%' }}>
            <Statistic title={t('projects.detail.stat.members')} value={summary?.memberCount ?? 0} />
          </Card>
        </Col>
        <Col xs={24} sm={8} md={4}>
          <Card size="small" style={{ height: '100%' }}>
            <Statistic
              title={t('projects.detail.stat.executions7d')}
              value={summary?.executionsLast7d ?? 0}
            />
          </Card>
        </Col>
        <Col xs={24} sm={8} md={4}>
          <Card size="small" style={{ height: '100%' }}>
            <Statistic
              title={t('projects.detail.stat.failed7d')}
              value={summary?.failedExecutionsLast7d ?? 0}
              suffix={
                (summary?.timeoutExecutionsLast7d ?? 0) > 0
                  ? t('projects.detail.stat.timeoutSuffix', {
                      count: summary?.timeoutExecutionsLast7d ?? 0,
                    })
                  : undefined
              }
            />
          </Card>
        </Col>
        <Col xs={24} sm={8} md={4}>
          <Card size="small" style={{ height: '100%' }}>
            <Statistic
              title={t('projects.detail.stat.failureRate')}
              value={failureRateValue}
              suffix={summary?.failureRate === null || summary?.failureRate === undefined ? undefined : '%'}
            />
          </Card>
        </Col>
      </Row>

      <Card
        size="small"
        title={t('projects.detail.recentFailures.title')}
        style={{ marginBottom: 16 }}
      >
        <Table<ProjectSummaryRecentFailure>
          rowKey="id"
          size="small"
          columns={failureColumns}
          dataSource={failures}
          pagination={false}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('projects.detail.recentFailures.empty')} /> }}
        />
      </Card>

      <Card size="small" title={t('projects.detail.recentActivity.title')}>
        <Table<ProjectSummaryRecentExecution>
          rowKey="id"
          size="small"
          columns={activityColumns}
          dataSource={activity}
          pagination={false}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('projects.detail.recentActivity.empty')} /> }}
        />
      </Card>
    </div>
  );
}
