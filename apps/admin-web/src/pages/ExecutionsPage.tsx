import { useState } from 'react';
import {
  Table, Typography, Badge, Button, Input, Select, Space,
  Empty, Tooltip, Popconfirm, message, DatePicker,
} from 'antd';
import {
  SearchOutlined, FilterOutlined, ReloadOutlined, EyeOutlined, StopOutlined,
} from '@ant-design/icons';
import type { Dayjs } from 'dayjs';

import { useRequest } from 'ahooks';
import { useNavigate } from 'react-router-dom';
import { tasksApi } from '../api/tasks';
import type { TaskExecution } from '../api/tasks';
import { getErrMsg } from '../utils/error';

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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins}分钟前`;
  if (mins < 1440) return `${Math.floor(mins / 60)}小时前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

export default function ExecutionsPage() {
  const nav = useNavigate();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [search, setSearch] = useState('');
  const [executorFilter, setExecutorFilter] = useState('');
  const [timeRange, setTimeRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [killingId, setKillingId] = useState<string | null>(null);

  const handleKill = async (r: TaskExecution) => {
    setKillingId(r.id);
    try {
      await tasksApi.killExecution(r.taskId, r.id);
      message.success('已发送终止信号');
      refresh();
    } catch (err: unknown) {
      message.error(getErrMsg(err, '终止失败'));
    } finally {
      setKillingId(null);
    }
  };

  const { data, loading, refresh } = useRequest(
    () => tasksApi.allExecutions({
      page,
      pageSize,
      status: statusFilter,
      taskName: search || undefined,
      executorAddress: executorFilter || undefined,
      startTime: timeRange?.[0]?.toISOString(),
      endTime: timeRange?.[1]?.toISOString(),
    }),
    { refreshDeps: [page, pageSize, statusFilter, search, executorFilter, timeRange], pollingInterval: 15000 },
  );

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
        <Tooltip title={new Date(v).toLocaleString('zh-CN')}>
          <Text style={{ fontSize: 12 }}>{formatRelative(v)}</Text>
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
      render: (_: any, r: TaskExecution) => (
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>执行记录</Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>全部任务执行历史</Typography.Text>
        </div>
        <Button icon={<ReloadOutlined />} onClick={() => { setPage(1); refresh(); }}>刷新</Button>
      </div>

      <Space style={{ marginBottom: 16 }} wrap>
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
    </div>
  );
}
