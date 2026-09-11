import { useState, useEffect } from 'react';
import {
  Table, Typography, Badge, Button, Input, Select, Space,
  Empty, Tooltip, Popconfirm, message, DatePicker,
} from 'antd';
import {
  SearchOutlined, FilterOutlined, ReloadOutlined, EyeOutlined, StopOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import type { Dayjs } from 'dayjs';

import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { tasksApi } from '../api/tasks';
import type { TaskExecution } from '../api/tasks';
import { useExecutionsList, invalidateExecutionData } from '../api/queries';
import { useExecutionsStream } from '../hooks/useExecutionsStream';
import { getErrMsg } from '../utils/error';
import { useDebounce } from '../hooks/useDebounce';
import { formatDateTime, formatDuration, formatRelativeTime } from '../utils/timeFormat';
import { ExecutionCompareModal, COMPARE_MAX } from '../components/ExecutionCompare';
import PageHeader from '../components/PageHeader';
import StateError from '../components/StateError';
// UI-10：导入 i18n 实例（模块副作用完成初始化；树内用 useTranslation 读 key）
import '../i18n';

const { Text } = Typography;
const { RangePicker } = DatePicker;

type BadgeStatus = 'success' | 'processing' | 'error' | 'default' | 'warning';
const STATUS_MAP = (t: (k: string) => string): Record<string, { badge: BadgeStatus; label: string }> => ({
  pending:   { badge: 'default',    label: t('execs.status.pending') },
  running:   { badge: 'processing', label: t('execs.status.running') },
  success:   { badge: 'success',    label: t('execs.status.success') },
  failed:    { badge: 'error',      label: t('execs.status.failed') },
  timeout:   { badge: 'warning',    label: t('execs.status.timeout') },
  killed:    { badge: 'error',      label: t('execs.status.killed') },
  cancelled: { badge: 'default',    label: t('execs.status.cancelled') },
});

export default function ExecutionsPage() {
  const nav = useNavigate();
  const { t } = useTranslation();
  // ARCH-26: 写后失效句柄（kill 后 invalidate 执行列表+Dashboard 汇总缓存）
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [search, setSearch] = useState('');
  const [executorFilter, setExecutorFilter] = useState('');
  const [timeRange, setTimeRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [killingId, setKillingId] = useState<string | null>(null);
  // FEAT-03: 多选对比——选中本页行后一键打开指标对比 modal
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);

  // 翻页/筛选变化后当前页数据会变，跨页选中行不再可见——清空选中防误比
  useEffect(() => {
    setSelectedIds([]);
  }, [page, pageSize, statusFilter, search, executorFilter, timeRange]);

  const handleKill = async (r: TaskExecution) => {
    setKillingId(r.id);
    try {
      await tasksApi.killExecution(r.taskId, r.id);
      message.success(t('execs.kill.success'));
      // ARCH-26: 写后失效——执行列表 + Dashboard 汇总面（queryKey 前缀化，
      // 一处 invalidate 同时刷新两个示范页的缓存）。
      await invalidateExecutionData(queryClient);
    } catch (err: unknown) {
      message.error(getErrMsg(err, t('execs.kill.fail')));
    } finally {
      setKillingId(null);
    }
  };

  // 搜索防抖：避免每击键发一次列表请求
  const debouncedSearch = useDebounce(search);

  // ARCH-26: TanStack Query 改造——useRequest 轮询（15s）换 query hooks：
  // 筛选参数进 queryKey（参数变化自动重取，等价 refreshDeps）；
  // staleTime 全局 30s 兜底切页缓存。15s 轮询由下方 refetchInterval useEffect
  // 承担（可见性判定与原 pollingWhenHidden:false 一致）。
  const { data, isLoading: loading, error, refetch } = useExecutionsList({
    page,
    pageSize,
    status: statusFilter,
    taskName: debouncedSearch || undefined,
    executorAddress: executorFilter || undefined,
    startTime: timeRange?.[0]?.toISOString(),
    endTime: timeRange?.[1]?.toISOString(),
  });

  // FEAT-16: 执行终态推送流——SSE live 时终态事件即时 invalidate 列表+汇总
  // 缓存（<3s 刷新验收），断线时下方 15s 轮询兜底自动成为唯一新鲜度来源
  // （对齐 DashboardPage：SSE 推送与轮询互斥共存，staleTime 内 refetch 去重）。
  useExecutionsStream();

  // 15s 轮询兜底：运行中行需要及时看到终态（SSE 断线时的降级路径）。
  // 标签页不可见时跳过请求（定时器保留，回到前台后下一拍即恢复——
  // 等价 pollingWhenHidden:false）。
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refetch();
    }, 15_000);
    return () => clearInterval(timer);
  }, [refetch]);

  const executions: TaskExecution[] = data?.items ?? [];
  const total: number = data?.total ?? 0;

  const hasFilters = !!(search || statusFilter || executorFilter || timeRange);

  const clearFilters = () => {
    setSearch('');
    setStatusFilter(undefined);
    setExecutorFilter('');
    setTimeRange(null);
    setPage(1);
  };

  // UI-09：375px 可用性——关键列=任务/状态/开始时间/错误/操作（值班首查项），
  // 触发方式/执行器/耗时为次要列窄屏收起（CSS 侧 .ui09-hide-mobile 双保险）；
  // scroll.x 兜底横向滚动。onHeaderCell/onCell 挂类供媒体查询隐藏次要列。
  const hideOnMobile = {
    onHeaderCell: () => ({ className: 'ui09-hide-mobile' }),
    onCell: () => ({ className: 'ui09-hide-mobile' }),
  } as const;
  const statusMap = STATUS_MAP(t);
  const columns = [
    {
      title: t('execs.col.task'),
      dataIndex: 'taskName',
      render: (name: string, r: TaskExecution) => (
        <a onClick={() => nav(`/tasks/${r.taskId}`)} style={{ fontWeight: 500 }}>{name || r.taskId}</a>
      ),
    },
    {
      title: t('execs.col.status'),
      dataIndex: 'status',
      width: 90,
      render: (s: string) => {
        const cfg = statusMap[s] || { badge: 'default' as BadgeStatus, label: s };
        return <Badge status={cfg.badge} text={cfg.label} />;
      },
    },
    {
      title: t('execs.col.trigger'),
      dataIndex: 'triggerType',
      width: 90,
      ...hideOnMobile,
      render: (v: string) => <Text type="secondary" style={{ fontSize: 12 }}>{v || '-'}</Text>,
    },
    {
      title: t('execs.col.executor'),
      dataIndex: 'executorAddress',
      width: 160,
      ellipsis: true,
      ...hideOnMobile,
      render: (v: string) => v
        ? <Tooltip title={v}><Text style={{ fontSize: 12 }}>{v}</Text></Tooltip>
        : <Text type="secondary" style={{ fontSize: 12 }}>-</Text>,
    },
    {
      title: t('execs.col.startTime'),
      dataIndex: 'startTime',
      width: 130,
      render: (v: string) => v ? (
        <Tooltip title={formatDateTime(v)}>
          <Text style={{ fontSize: 12 }}>{formatRelativeTime(v)}</Text>
        </Tooltip>
      ) : '-',
    },
    {
      title: t('execs.col.duration'),
      dataIndex: 'duration',
      width: 80,
      ...hideOnMobile,
      render: (v: number) => v != null ? <Text style={{ fontSize: 12 }}>{formatDuration(v)}</Text> : '-',
    },
    {
      title: t('execs.col.error'),
      dataIndex: 'errorMessage',
      ellipsis: true,
      render: (v: string) => v ? <Text type="danger" style={{ fontSize: 12 }}>{v}</Text> : '-',
    },
    {
      title: t('execs.col.action'),
      key: 'action',
      width: 100,
      render: (_: unknown, r: TaskExecution) => (
        <Space size={4}>
          <Button
            type="link" size="small" icon={<EyeOutlined />}
            onClick={() => nav(`/tasks/${r.taskId}/executions/${r.id}`)}
          >
            {t('execs.action.detail')}
          </Button>
          {r.status === 'running' && (
            <Popconfirm
              title={t('execs.killConfirm')}
              onConfirm={() => handleKill(r)}
              okText={t('execs.action.kill')} okButtonProps={{ danger: true }}
            >
              <Button
                type="link" size="small" danger
                icon={<StopOutlined />}
                loading={killingId === r.id}
              >
                {t('execs.action.kill')}
              </Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      {/* UI-03：页头标准化（原 Typography.Title 区块迁入 PageHeader，刷新进 extra） */}
      <PageHeader
        title={t('execs.title')}
        description={t('execs.description')}
        extra={<Button icon={<ReloadOutlined />} onClick={() => void refetch()}>{t('execs.refresh')}</Button>}
      />

      {/* UI-09：筛选区 wrap 堆叠（Space wrap 已有），输入/选择窄屏自适应宽度 */}
      <Space style={{ marginBottom: 16 }} wrap className="ui09-filter-bar">
        {selectedIds.length > 0 && (
          <Button
            icon={<SwapOutlined />}
            type="primary"
            disabled={selectedIds.length < 2}
            onClick={() => {
              if (selectedIds.length > COMPARE_MAX) {
                message.warning(t('execs.compare.limit', { max: COMPARE_MAX }));
                return;
              }
              setCompareOpen(true);
            }}
          >
            {t('execs.compare', { count: selectedIds.length })}
          </Button>
        )}
        <Input
          placeholder={t('execs.searchPlaceholder')}
          prefix={<SearchOutlined />}
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
          allowClear
          style={{ width: 200, maxWidth: '100%' }}
        />
        <Select
          placeholder={t('execs.statusAll')}
          allowClear
          style={{ width: 120, maxWidth: '100%' }}
          value={statusFilter}
          onChange={v => { setStatusFilter(v); setPage(1); }}
          suffixIcon={<FilterOutlined />}
          options={[
            { value: 'pending',   label: t('execs.status.pending') },
            { value: 'running',   label: t('execs.status.running') },
            { value: 'success',   label: t('execs.status.success') },
            { value: 'failed',    label: t('execs.status.failed') },
            { value: 'timeout',   label: t('execs.status.timeout') },
            { value: 'killed',    label: t('execs.status.killed') },
            { value: 'cancelled', label: t('execs.status.cancelled') },
          ]}
        />
        <Input
          placeholder={t('execs.executorPlaceholder')}
          value={executorFilter}
          onChange={e => { setExecutorFilter(e.target.value); setPage(1); }}
          allowClear
          style={{ width: 180, maxWidth: '100%' }}
        />
        <RangePicker
          showTime
          format="MM-DD HH:mm"
          placeholder={[t('execs.timeStart'), t('execs.timeEnd')]}
          value={timeRange}
          onChange={val => { setTimeRange(val as [Dayjs, Dayjs] | null); setPage(1); }}
          style={{ width: 320, maxWidth: '100%' }}
        />
        {hasFilters && (
          <Button size="small" onClick={clearFilters}>{t('execs.clearFilters')}</Button>
        )}
      </Space>

      {/* UI-16：列表请求失败不再只弹 toast —— 页内原位呈现错误块 + 重试入口
          （写操作失败仍走 toast，语义不变） */}
      {error ? (
        <StateError
          error={error}
          title={t('execs.error.title')}
          onRetry={() => void refetch()}
          style={{ marginBottom: 16 }}
        />
      ) : null}

      <Table
        rowKey="id"
        columns={columns}
        dataSource={executions}
        loading={loading}
        // UI-09：次要列窄屏收起（CSS 媒体查询 .ui09-hide-mobile）+ scroll.x 横向滚动兜底
        scroll={{ x: 640 }}
        rowSelection={{
          selectedRowKeys: selectedIds,
          onChange: (keys) => setSelectedIds(keys as string[]),
        }}
        pagination={{
          total,
          current: page,
          pageSize,
          onChange: (p, ps) => { setPage(p); setPageSize(ps ?? 20); },
          showTotal: t2 => t('execs.count', { count: t2 }),
          showSizeChanger: true,
        }}
        locale={{
          emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('execs.empty')} />,
        }}
      />

      <ExecutionCompareModal
        open={compareOpen}
        onClose={() => setCompareOpen(false)}
        executions={executions}
        compareIds={selectedIds}
      />
    </div>
  );
}
