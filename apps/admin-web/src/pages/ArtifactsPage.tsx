/**
 * P1-3「产物库」：跨执行产物聚合视图（GET /artifacts）。
 *
 * ## 筛选口径（与后端契约逐字对齐，不做假过滤）
 * 后端 GET /artifacts 只支持 `page / pageSize / applicationId / taskId` 四个查询参数，
 * **没有** executionId / 时间范围 / 类型 / 关键字筛选，响应是裸数组、**不返回 total**。
 * 因此本页：
 *  - 只提供「按应用 / 按任务」两个真实过滤器；
 *  - 关键字、时间、类型一律不在页面上提供控件（不做加载后假装全局筛选的假过滤）；
 *  - 分页用 page/pageSize，无 total 时以「当前页返回数 == pageSize」推断是否还有下一页。
 *
 * 入口：侧栏「自动化 → 产物库」、命令面板；任务详情 / 应用详情的「查看全部产物」
 * 携带 taskId / applicationId 深链预填筛选。
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Empty,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  DownloadOutlined,
  EyeOutlined,
  LinkOutlined,
  RightOutlined,
} from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useApplicationsList, useArtifactsIndex, useTasksList } from '../api/queries';
import { artifactsApi, type ArtifactRow } from '../api/artifacts';
import { useUrlStateSync } from '../hooks/useUrlStateSync';
import { useIsMobile } from '../hooks/useIsMobile';
import { formatArtifactSize } from '../utils/artifactSize';
import { formatDateTime, formatRelativeTime } from '../utils/timeFormat';
import { copyText } from '../utils/clipboard';
import { message } from '../utils/toast';
import { executionDeepLink } from '../utils/artifactLibrary';
import PageHeader from '../components/PageHeader';
import PageSkeleton from '../components/PageSkeleton';
import StateError from '../components/StateError';
import ArtifactPreviewModal from '../components/ArtifactPreviewModal';

const { Text } = Typography;

const DEFAULT_PAGE_SIZE = 20;

export default function ArtifactsPage() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const isMobile = useIsMobile();

  // ── URL 双向同步：筛选与分页都进地址栏，支持从详情页深链预填 ──────────────
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [applicationId, setApplicationId] = useState<string | undefined>();
  const [taskId, setTaskId] = useState<string | undefined>();

  useUrlStateSync(
    { page, pageSize, applicationId, taskId },
    { page: 1, pageSize: DEFAULT_PAGE_SIZE, applicationId: undefined, taskId: undefined },
    {
      page: (v) => setPage(Number(v)),
      pageSize: (v) => setPageSize(Number(v)),
      applicationId: (v) => setApplicationId(v || undefined),
      taskId: (v) => setTaskId(v || undefined),
    },
  );

  const indexQuery = {
    page,
    pageSize,
    applicationId: applicationId || undefined,
    taskId: taskId || undefined,
  };
  const { data: rows, isLoading, isError, error, refetch } = useArtifactsIndex(indexQuery);

  // 下拉候选 + 名称解析（后端索引行只带 id 列，名字回查应用/任务列表）
  const { data: apps } = useApplicationsList();
  const { data: taskPage } = useTasksList({ page: 1, pageSize: 200 });

  const appMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const a of apps ?? []) m[a.id] = a.name || a.id;
    return m;
  }, [apps]);

  const taskMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const task of taskPage?.items ?? []) m[task.id] = task.name || task.id;
    return m;
  }, [taskPage]);

  const [previewRow, setPreviewRow] = useState<ArtifactRow | null>(null);

  const list = rows ?? [];
  const hasFilters = Boolean(applicationId || taskId);
  const hasNext = list.length === pageSize;

  const resetPage = () => setPage(1);

  const handleDownload = async (row: ArtifactRow) => {
    try {
      await artifactsApi.downloadArtifact(row.executionId, row.name);
      message.success(t('artifactLibrary.preview.downloadOk'));
    } catch {
      message.error(t('artifacts.downloadFail'));
    }
  };

  const handleCopyLink = async (row: ArtifactRow) => {
    const url = `${window.location.origin}${executionDeepLink(row)}`;
    const ok = await copyText(url);
    if (ok) message.success(t('stateError.copySuccess'));
    else message.error(t('stateError.copyFailed'));
  };

  const appOptions = (apps ?? []).map((a) => ({ value: a.id, label: a.name || a.id }));
  const taskOptions = (taskPage?.items ?? []).map((task) => ({
    value: task.id,
    label: task.name || task.id,
  }));

  const columns = [
    {
      title: t('artifactLibrary.col.name'),
      dataIndex: 'name',
      key: 'name',
      render: (name: string, row: ArtifactRow) => (
        <Tooltip title={t('artifactLibrary.preview.sha256') + ': ' + row.sha256}>
          <Text code style={{ fontSize: 12, wordBreak: 'break-all' }}>
            {name}
          </Text>
        </Tooltip>
      ),
    },
    {
      title: t('artifactLibrary.col.typeSize'),
      key: 'typeSize',
      width: 150,
      render: (_: unknown, row: ArtifactRow) => {
        const ext = row.name.includes('.') ? row.name.split('.').pop()!.toUpperCase() : '-';
        return (
          <Space size={6}>
            <Tag>{ext}</Tag>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {formatArtifactSize(row.size)}
            </Text>
          </Space>
        );
      },
    },
    {
      title: t('artifactLibrary.col.execution'),
      dataIndex: 'executionId',
      key: 'executionId',
      width: 150,
      render: (execId: string, row: ArtifactRow) => (
        <Link to={executionDeepLink(row)} title={execId}>
          #{execId.slice(0, 8)}
        </Link>
      ),
    },
    {
      title: t('artifactLibrary.col.taskApp'),
      key: 'taskApp',
      render: (_: unknown, row: ArtifactRow) => (
        <div>
          <Link to={`/tasks/${row.taskId}`}>{taskMap[row.taskId] ?? row.taskId}</Link>
          {row.applicationId && (
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {appMap[row.applicationId] ?? row.applicationId}
              </Text>
            </div>
          )}
        </div>
      ),
    },
    {
      title: t('artifactLibrary.col.time'),
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 150,
      render: (v: string) => (
        <Tooltip title={formatDateTime(v)}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {formatRelativeTime(v, t)}
          </Text>
        </Tooltip>
      ),
    },
    {
      title: t('artifactLibrary.col.action'),
      key: 'action',
      width: 240,
      render: (_: unknown, row: ArtifactRow) => (
        <Space size={4} wrap>
          <Button size="small" icon={<EyeOutlined />} onClick={() => setPreviewRow(row)}>
            {t('artifactLibrary.action.preview')}
          </Button>
          <Button size="small" icon={<DownloadOutlined />} onClick={() => handleDownload(row)}>
            {t('artifactLibrary.action.download')}
          </Button>
          <Tooltip title={t('artifactLibrary.action.copyLink')}>
            <Button size="small" icon={<LinkOutlined />} onClick={() => handleCopyLink(row)} />
          </Tooltip>
          <Button
            size="small"
            type="link"
            onClick={() => nav(executionDeepLink(row))}
            icon={<RightOutlined />}
          >
            {t('artifactLibrary.action.gotoExecution')}
          </Button>
        </Space>
      ),
    },
  ];

  const renderEmpty = () => (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={
        hasFilters ? t('artifactLibrary.empty.noMatch') : t('artifactLibrary.empty.desc')
      }
    >
      {hasFilters && (
        <Button
          type="link"
          size="small"
          onClick={() => {
            setApplicationId(undefined);
            setTaskId(undefined);
            resetPage();
          }}
        >
          {t('artifactLibrary.clearFilters')}
        </Button>
      )}
    </Empty>
  );

  return (
    <div data-testid="artifacts-page">
      <PageHeader
        title={t('artifactLibrary.title')}
        description={t('artifactLibrary.description')}
      />

      <Space wrap style={{ marginBottom: 16 }}>
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          style={{ minWidth: 200 }}
          placeholder={t('artifactLibrary.filter.allApplication')}
          value={applicationId}
          options={appOptions}
          onChange={(v) => {
            setApplicationId(v || undefined);
            resetPage();
          }}
        />
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          style={{ minWidth: 200 }}
          placeholder={t('artifactLibrary.filter.allTask')}
          value={taskId}
          options={taskOptions}
          onChange={(v) => {
            setTaskId(v || undefined);
            resetPage();
          }}
        />
      </Space>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={t('artifactLibrary.filter.note')}
      />

      {isLoading ? (
        <PageSkeleton variant="table" rows={6} />
      ) : isError ? (
        <StateError error={error} onRetry={() => refetch()} title={t('artifactLibrary.error.title')} />
      ) : list.length === 0 ? (
        renderEmpty()
      ) : isMobile ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {list.map((row) => (
            <Card key={row.id} size="small">
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, minWidth: 0 }}>
                <Text code style={{ fontSize: 12, wordBreak: 'break-all' }}>
                  {row.name}
                </Text>
                <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                  {formatArtifactSize(row.size)}
                </Text>
              </div>
              <div style={{ marginTop: 6, fontSize: 12, color: 'var(--chart-axis-text)' }}>
                <Link to={`/tasks/${row.taskId}`}>{taskMap[row.taskId] ?? row.taskId}</Link>
                {row.applicationId && ` · ${appMap[row.applicationId] ?? row.applicationId}`}
              </div>
              <div style={{ marginTop: 4, fontSize: 12, color: 'var(--chart-axis-text)' }}>
                <Link to={executionDeepLink(row)}>#{row.executionId.slice(0, 8)}</Link>
                {' · '}
                {formatRelativeTime(row.createdAt, t)}
              </div>
              <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end', gap: 4, flexWrap: 'wrap' }}>
                <Button size="small" icon={<EyeOutlined />} onClick={() => setPreviewRow(row)}>
                  {t('artifactLibrary.action.preview')}
                </Button>
                <Button size="small" icon={<DownloadOutlined />} onClick={() => handleDownload(row)}>
                  {t('artifactLibrary.action.download')}
                </Button>
                <Button size="small" icon={<LinkOutlined />} onClick={() => handleCopyLink(row)} />
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Table
          rowKey="id"
          columns={columns}
          dataSource={list}
          pagination={{
            current: page,
            pageSize,
            // 后端不返回 total：用「当前页条数 + 是否有下一页」拼一个近似 total，
            // 仅驱动页码器翻页，不向用户展示总数。
            total: (page - 1) * pageSize + list.length + (hasNext ? 1 : 0),
            showSizeChanger: false,
            showTotal: undefined,
            onChange: (nextPage, nextPageSize) => {
              setPage(nextPage);
              setPageSize(nextPageSize);
            },
          }}
          scroll={{ x: 1080 }}
        />
      )}

      <ArtifactPreviewModal row={previewRow} onClose={() => setPreviewRow(null)} />
    </div>
  );
}
