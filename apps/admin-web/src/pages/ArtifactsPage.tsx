/**
 * P1-3「产物库」：跨执行产物聚合视图（GET /artifacts）。
 *
 * ## 筛选口径（与后端契约逐字对齐，不做假过滤）
 * 后端 GET /artifacts 支持 `page / pageSize / applicationId / taskId / q（文件名关键字）/
 * from / to（createdAt 闭区间）/ ext（扩展名白名单）` 八个查询参数，响应是 paginate
 * 信封，`total` 为**过滤后**总数。本页所有过滤器都下推到后端索引表查询，不在前端
 * 做加载后的假全局过滤；分页与总数读真实 `total`，不靠本页行数猜。
 *
 * 入口：侧栏「自动化 → 产物库」、命令面板；任务详情 / 应用详情的「查看全部产物」
 * 携带 taskId / applicationId 深链预填筛选。
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Empty,
  Input,
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
import dayjs, { type Dayjs } from 'dayjs';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useApplicationsList, useArtifactsIndex, useTasksList } from '../api/queries';
import { artifactsApi, type ArtifactRow } from '../api/artifacts';
import { useUrlStateSync } from '../hooks/useUrlStateSync';
import { useIsMobile } from '../hooks/useIsMobile';
import { formatArtifactSize } from '../utils/artifactSize';
import { formatDateTime, formatRelativeTime } from '../utils/timeFormat';
import { copyText } from '../utils/clipboard';
import { showApiError } from '../utils/error';
import { message } from '../utils/toast';
import {
  ARTIFACT_EXTENSION_FILTERS,
  executionDeepLink,
} from '../utils/artifactLibrary';
import PageHeader from '../components/PageHeader';
import PageSkeleton from '../components/PageSkeleton';
import StateError from '../components/StateError';
import ArtifactPreviewModal from '../components/ArtifactPreviewModal';

const { Text } = Typography;

const DEFAULT_PAGE_SIZE = 20;

interface ArtifactFilterBarProps {
  applicationId?: string;
  taskId?: string;
  q?: string;
  from?: string;
  to?: string;
  ext?: string;
  appOptions: { value: string; label: string }[];
  taskOptions: { value: string; label: string }[];
  extOptions: { value: string; label: string }[];
  onApplicationChange: (value?: string) => void;
  onTaskChange: (value?: string) => void;
  onQChange: (value?: string) => void;
  onRangeChange: (range: [string, string] | undefined) => void;
  onExtChange: (value?: string) => void;
}

/** 筛选工具栏：应用 / 任务 / 文件名关键字 / 产出时间范围 / 扩展名，全部下推后端索引查询。 */
function ArtifactFilterBar({
  applicationId,
  taskId,
  q,
  from,
  to,
  ext,
  appOptions,
  taskOptions,
  extOptions,
  onApplicationChange,
  onTaskChange,
  onQChange,
  onRangeChange,
  onExtChange,
}: ArtifactFilterBarProps) {
  const { t } = useTranslation();
  const rangeValue: [Dayjs, Dayjs] | null =
    from && to ? [dayjs(from), dayjs(to)] : null;
  return (
    <Space wrap style={{ marginBottom: 16 }}>
      <Input.Search
        allowClear
        style={{ minWidth: 200 }}
        placeholder={t('artifactLibrary.filter.keywordPlaceholder')}
        value={q}
        onChange={(e) => onQChange(e.target.value || undefined)}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        style={{ minWidth: 200 }}
        placeholder={t('artifactLibrary.filter.allApplication')}
        value={applicationId}
        options={appOptions}
        onChange={(v) => onApplicationChange(v || undefined)}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        style={{ minWidth: 200 }}
        placeholder={t('artifactLibrary.filter.allTask')}
        value={taskId}
        options={taskOptions}
        onChange={(v) => onTaskChange(v || undefined)}
      />
      <DatePicker.RangePicker
        allowClear
        value={rangeValue}
        onChange={(dates) => {
          if (!dates || !dates[0] || !dates[1]) {
            onRangeChange(undefined);
            return;
          }
          onRangeChange([
            dates[0].startOf('day').toISOString(),
            dates[1].endOf('day').toISOString(),
          ]);
        }}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        style={{ minWidth: 140 }}
        placeholder={t('artifactLibrary.filter.allType')}
        value={ext}
        options={extOptions}
        onChange={(v) => onExtChange(v || undefined)}
      />
    </Space>
  );
}

interface ArtifactColumnsDeps {
  taskMap: Record<string, string>;
  appMap: Record<string, string>;
  onPreview: (row: ArtifactRow) => void;
  onDownload: (row: ArtifactRow) => void;
  onCopyLink: (row: ArtifactRow) => void;
  onGoto: (row: ArtifactRow) => void;
}

/** 表格列定义抽离到模块级，避免主组件函数体越过 size-caps 函数体上限。 */
function buildArtifactColumns(
  t: ReturnType<typeof useTranslation>['t'],
  { taskMap, appMap, onPreview, onDownload, onCopyLink, onGoto }: ArtifactColumnsDeps,
) {
  return [
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
          <Button size="small" icon={<EyeOutlined />} onClick={() => onPreview(row)}>
            {t('artifactLibrary.action.preview')}
          </Button>
          <Button size="small" icon={<DownloadOutlined />} onClick={() => onDownload(row)}>
            {t('artifactLibrary.action.download')}
          </Button>
          <Tooltip title={t('artifactLibrary.action.copyLink')}>
            <Button size="small" icon={<LinkOutlined />} onClick={() => onCopyLink(row)} />
          </Tooltip>
          <Button
            size="small"
            type="link"
            onClick={() => onGoto(row)}
            icon={<RightOutlined />}
          >
            {t('artifactLibrary.action.gotoExecution')}
          </Button>
        </Space>
      ),
    },
  ];
}

export default function ArtifactsPage() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const isMobile = useIsMobile();

  // ── URL 双向同步：筛选与分页都进地址栏，支持从详情页深链预填 ──────────────
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [applicationId, setApplicationId] = useState<string | undefined>();
  const [taskId, setTaskId] = useState<string | undefined>();
  const [q, setQ] = useState<string | undefined>();
  const [from, setFrom] = useState<string | undefined>();
  const [to, setTo] = useState<string | undefined>();
  const [ext, setExt] = useState<string | undefined>();

  useUrlStateSync(
    { page, pageSize, applicationId, taskId, q, from, to, ext },
    {
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      applicationId: undefined,
      taskId: undefined,
      q: undefined,
      from: undefined,
      to: undefined,
      ext: undefined,
    },
    {
      page: (v) => setPage(Number(v)),
      pageSize: (v) => setPageSize(Number(v)),
      applicationId: (v) => setApplicationId(v || undefined),
      taskId: (v) => setTaskId(v || undefined),
      q: (v) => setQ(v || undefined),
      from: (v) => setFrom(v || undefined),
      to: (v) => setTo(v || undefined),
      ext: (v) => setExt(v || undefined),
    },
  );

  const indexQuery = {
    page,
    pageSize,
    applicationId: applicationId || undefined,
    taskId: taskId || undefined,
    q: q?.trim() || undefined,
    from,
    to,
    ext,
  };
  const { data: indexPage, isLoading, isError, error, refetch } =
    useArtifactsIndex(indexQuery);

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

  const list = indexPage?.items ?? [];
  // 真实总数：直接读后端过滤后的 total，不再用「本页行数 == pageSize」猜下一页。
  const total = indexPage?.total ?? 0;
  const hasFilters = Boolean(
    applicationId || taskId || q?.trim() || from || to || ext,
  );

  const resetPage = () => setPage(1);

  const handleDownload = async (row: ArtifactRow) => {
    try {
      await artifactsApi.downloadArtifact(row.executionId, row.name);
      message.success(t('artifactLibrary.preview.downloadOk'));
    } catch (err: unknown) {
      showApiError(err, t('artifacts.downloadFail'));
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
  const extOptions = ARTIFACT_EXTENSION_FILTERS.map((e) => ({
    value: e,
    label: e.toUpperCase(),
  }));

  const columns = buildArtifactColumns(t, {
    taskMap,
    appMap,
    onPreview: (row) => setPreviewRow(row),
    onDownload: handleDownload,
    onCopyLink: handleCopyLink,
    onGoto: (row) => nav(executionDeepLink(row)),
  });

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
            setQ(undefined);
            setFrom(undefined);
            setTo(undefined);
            setExt(undefined);
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

      <ArtifactFilterBar
        applicationId={applicationId}
        taskId={taskId}
        q={q}
        from={from}
        to={to}
        ext={ext}
        appOptions={appOptions}
        taskOptions={taskOptions}
        extOptions={extOptions}
        onApplicationChange={(v) => {
          setApplicationId(v);
          resetPage();
        }}
        onTaskChange={(v) => {
          setTaskId(v);
          resetPage();
        }}
        onQChange={(v) => {
          setQ(v);
          resetPage();
        }}
        onRangeChange={(range) => {
          setFrom(range?.[0]);
          setTo(range?.[1]);
          resetPage();
        }}
        onExtChange={(v) => {
          setExt(v);
          resetPage();
        }}
      />

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
            // 真实 total（后端过滤后总数）；页码器与总数都以它为准。
            total,
            showSizeChanger: false,
            showTotal: (n) => t('artifactLibrary.total', { count: n }),
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
