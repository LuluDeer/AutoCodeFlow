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
import { tasksApi } from '../api/tasks';
import type { TaskExecution } from '../api/tasks';
import { useExecutionsList, invalidateExecutionData } from '../api/queries';
import { getErrMsg } from '../utils/error';
import { useDebounce } from '../hooks/useDebounce';
import { formatDateTime, formatDuration, formatRelativeTime } from '../utils/timeFormat';
import { ExecutionCompareModal, COMPARE_MAX } from '../components/ExecutionCompare';
import PageHeader from '../components/PageHeader';

const { Text } = Typography;
const { RangePicker } = DatePicker;

type BadgeStatus = 'success' | 'processing' | 'error' | 'default' | 'warning';
const STATUS_MAP: Record<string, { badge: BadgeStatus; label: string }> = {
  pending:   { badge: 'default',    label: '等待中' },
  running:   { badge: 'processing', label: '运行中' },
  success:   { badge: 'success',    label: '成功'   },
  failed:    { badge: 'error',      label: '失败'   },
  timeout:   { badge: 'warning',    label: '超时'   },
  killed:    { badge: 'error',      label: '已终止' },
  cancelled: { badge: 'default',    label: '已取消' },
};

export default function ExecutionsPage() {
  const nav = useNavigate();
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
      message.success('已发送终止信号');
      // ARCH-26: 写后失效——执行列表 + Dashboard 汇总面（queryKey 前缀化，
      // 一处 invalidate 同时刷新两个示范页的缓存）。
      await invalidateExecutionData(queryClient);
    } catch (err: unknown) {
      message.error(getErrMsg(err, '终止失败'));
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
  const { data, isLoading: loading, refetch } = useExecutionsList({
    page,
    pageSize,
    status: statusFilter,
    taskName: debouncedSearch || undefined,
    executorAddress: executorFilter || undefined,
    startTime: timeRange?.[0]?.toISOString(),
    endTime: timeRange?.[1]?.toISOString(),
  });

  // 15s 轮询兜底：运行中行需要及时看到终态。标签页不可见时跳过请求
  // （定时器保留，回到前台后下一拍即恢复——等价 pollingWhenHidden:false）。
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

  const columns = [
    {
      title: '任务',
      dataIndex: 'taskName',
      render: (name: string, r: TaskExecution) => (
        <a onClick={() => nav(`/tasks/${r.taskId}`)} style={{ fontWeight: 500 }}>{name || r.taskId}</a>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s: string) => {
        const cfg = STATUS_MAP[s] || { badge: 'default' as BadgeStatus, label: s };
        return <Badge status={cfg.badge} text={cfg.label} />;
      },
    },
    {
      title: '触发方式',
      dataIndex: 'triggerType',
      width: 90,
      render: (v: string) => <Text type="secondary" style={{ fontSize: 12 }}>{v || '-'}</Text>,
    },
    {
      title: '执行器',
      dataIndex: 'executorAddress',
      width: 160,
      ellipsis: true,
      render: (v: string) => v
        ? <Tooltip title={v}><Text style={{ fontSize: 12 }}>{v}</Text></Tooltip>
        : <Text type="secondary" style={{ fontSize: 12 }}>-</Text>,
    },
    {
      title: '开始时间',
      dataIndex: 'startTime',
      width: 130,
      render: (v: string) => v ? (
        <Tooltip title={formatDateTime(v)}>
          <Text style={{ fontSize: 12 }}>{formatRelativeTime(v)}</Text>
        </Tooltip>
      ) : '-',
    },
    {
      title: '耗时',
      dataIndex: 'duration',
      width: 80,
      render: (v: number) => v != null ? <Text style={{ fontSize: 12 }}>{formatDuration(v)}</Text> : '-',
    },
    {
      title: '错误信息',
      dataIndex: 'errorMessage',
      ellipsis: true,
      render: (v: string) => v ? <Text type="danger" style={{ fontSize: 12 }}>{v}</Text> : '-',
    },
    {
      title: '',
      key: 'action',
      width: 100,
      render: (_: unknown, r: TaskExecution) => (
        <Space size={4}>
          <Button
            type="link" size="small" icon={<EyeOutlined />}
            onClick={() => nav(`/tasks/${r.taskId}/executions/${r.id}`)}
          >
            详情
          </Button>
          {r.status === 'running' && (
            <Popconfirm
              title="确认终止此执行？"
              onConfirm={() => handleKill(r)}
              okText="终止" okButtonProps={{ danger: true }}
            >
              <Button
                type="link" size="small" danger
                icon={<StopOutlined />}
                loading={killingId === r.id}
              >
                终止
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
        title="执行记录"
        description="全部任务执行历史"
        extra={<Button icon={<ReloadOutlined />} onClick={() => void refetch()}>刷新</Button>}
      />

      <Space style={{ marginBottom: 16 }} wrap>
        {selectedIds.length > 0 && (
          <Button
            icon={<SwapOutlined />}
            type="primary"
            disabled={selectedIds.length < 2}
            onClick={() => {
              if (selectedIds.length > COMPARE_MAX) {
                message.warning(`最多对比 ${COMPARE_MAX} 条执行记录`);
                return;
              }
              setCompareOpen(true);
            }}
          >
            对比 ({selectedIds.length})
          </Button>
        )}
        <Input
          placeholder="搜索任务名"
          prefix={<SearchOutlined />}
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
          allowClear
          style={{ width: 200 }}
        />
        <Select
          placeholder="全部状态"
          allowClear
          style={{ width: 120 }}
          value={statusFilter}
          onChange={v => { setStatusFilter(v); setPage(1); }}
          suffixIcon={<FilterOutlined />}
          options={[
            { value: 'pending',   label: '等待中' },
            { value: 'running',   label: '运行中' },
            { value: 'success',   label: '成功'   },
            { value: 'failed',    label: '失败'   },
            { value: 'timeout',   label: '超时'   },
            { value: 'killed',    label: '已终止' },
            { value: 'cancelled', label: '已取消' },
          ]}
        />
        <Input
          placeholder="执行器地址"
          value={executorFilter}
          onChange={e => { setExecutorFilter(e.target.value); setPage(1); }}
          allowClear
          style={{ width: 180 }}
        />
        <RangePicker
          showTime
          format="MM-DD HH:mm"
          placeholder={['开始时间', '结束时间']}
          value={timeRange}
          onChange={val => { setTimeRange(val as [Dayjs, Dayjs] | null); setPage(1); }}
          style={{ width: 320 }}
        />
        {hasFilters && (
          <Button size="small" onClick={clearFilters}>清除筛选</Button>
        )}
      </Space>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={executions}
        loading={loading}
        rowSelection={{
          selectedRowKeys: selectedIds,
          onChange: (keys) => setSelectedIds(keys as string[]),
        }}
        pagination={{
          total,
          current: page,
          pageSize,
          onChange: (p, ps) => { setPage(p); setPageSize(ps ?? 20); },
          showTotal: t => `共 ${t} 条`,
          showSizeChanger: true,
        }}
        locale={{
          emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无执行记录" />,
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
