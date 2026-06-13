import { useState } from 'react';
import {
  Table, Typography, Badge, Button, Input, Select, Space,
  Empty, Tooltip, Popconfirm, message,
} from 'antd';
import {
  SearchOutlined, FilterOutlined, ReloadOutlined, EyeOutlined, StopOutlined,
} from '@ant-design/icons';

import { useRequest } from 'ahooks';
import { useNavigate } from 'react-router-dom';
import { tasksApi } from '../api/tasks';
import type { TaskExecution } from '../api/tasks';
import { getErrMsg } from '../utils/error';

const { Text } = Typography;

type BadgeStatus = 'success' | 'processing' | 'error' | 'default' | 'warning';
const STATUS_MAP: Record<string, { badge: BadgeStatus; label: string; color: string }> = {
  pending: { badge: 'default', label: '等待中', color: 'default' },
  running: { badge: 'processing', label: '运行中', color: 'processing' },
  success: { badge: 'success', label: '成功', color: 'green' },
  failed: { badge: 'error', label: '失败', color: 'red' },
  timeout: { badge: 'warning', label: '超时', color: 'orange' },
  killed: { badge: 'error', label: '已终止', color: 'volcano' },
  cancelled: { badge: 'default', label: '已取消', color: 'default' },
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
    () => tasksApi.allExecutions({ page, pageSize, status: statusFilter, taskName: search || undefined }),
    { refreshDeps: [page, pageSize, statusFilter, search], pollingInterval: 15000 },
  );

  const executions: TaskExecution[] = data?.items ?? [];
  const total: number = data?.total ?? 0;

  // search is sent to server-side via refreshDeps so it filters across all pages
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
        const cfg = STATUS_MAP[s] || { badge: 'default', label: s, color: 'default' };
        return <Badge status={cfg.badge} text={cfg.label} />;
      },
    },
    {
      title: '触发',
      dataIndex: 'triggerType',
      width: 80,
      render: (v: string) => <Text type="secondary" style={{ fontSize: 12 }}>{v || '-'}</Text>,
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
          placeholder="搜索任务名、错误信息"
          prefix={<SearchOutlined />}
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
          allowClear
          style={{ width: 220 }}
        />
        <Select
          placeholder="全部状态"
          allowClear
          style={{ width: 120 }}
          value={statusFilter}
          onChange={v => { setStatusFilter(v); setPage(1); }}
          suffixIcon={<FilterOutlined />}
          options={[
            { value: 'running', label: '运行中' },
            { value: 'success', label: '成功' },
            { value: 'failed', label: '失败' },
            { value: 'timeout', label: '超时' },
          ]}
        />
        {statusFilter && (
          <Button size="small" onClick={() => { setStatusFilter(undefined); setPage(1); }}>清除筛选</Button>
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
