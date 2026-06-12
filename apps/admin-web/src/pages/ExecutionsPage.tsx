import { useState } from 'react';
import { Table, Tag, Select, Button, Space, Typography, Drawer, Tooltip, DatePicker, Badge, Empty } from 'antd';
import { ReloadOutlined, CalendarOutlined } from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { useNavigate } from 'react-router-dom';
import dayjs, { Dayjs } from 'dayjs';
import { tasksApi } from '../api/tasks';
import { client } from '../api/client';

const { RangePicker } = DatePicker;

const STATUS_COLORS: Record<string, string> = {
  success: 'green',
  failed: 'red',
  running: 'blue',
  pending: 'orange',
  cancelled: 'default',
};

const STATUS_LABELS: Record<string, string> = {
  success: '成功',
  failed: '失败',
  running: '运行中',
  pending: '等待中',
  cancelled: '已取消',
};

interface ExecutionRecord {
  id: string;
  taskId: string;
  taskName?: string;
  status: string;
  triggerType?: string;
  startTime?: string;
  endTime?: string;
  duration?: number;
  errorMessage?: string;
  logs?: string;
  createdAt: string;
}

function fetchAllExecutions(params: {
  page: number;
  pageSize: number;
  status?: string;
  taskId?: string;
  startTime?: string;
  endTime?: string;
}) {
  return client.get<any, { list: ExecutionRecord[]; total: number; page: number; pageSize: number }>(
    '/tasks/executions/all',
    { params },
  );
}

function formatDuration(v: number) {
  if (v == null) return '-';
  if (v < 1000) return `${v} ms`;
  if (v < 60000) return `${(v / 1000).toFixed(1)} s`;
  return `${Math.floor(v / 60000)}m ${Math.floor((v % 60000) / 1000)}s`;
}

export default function ExecutionsPage() {
  const nav = useNavigate();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [taskIdFilter, setTaskIdFilter] = useState<string | undefined>();
  const [dateRange, setDateRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [logDrawer, setLogDrawer] = useState<{ open: boolean; exec?: ExecutionRecord }>({ open: false });

  const { data: tasks } = useRequest(() => tasksApi.list({ pageSize: 200 }));
  const taskOptions = (tasks?.list ?? []).map((t: any) => ({ label: t.name, value: t.id }));

  const startTime = dateRange?.[0]?.startOf('day').toISOString();
  const endTime = dateRange?.[1]?.endOf('day').toISOString();

  const { data, loading, refresh } = useRequest(
    () => fetchAllExecutions({ page, pageSize, status: statusFilter, taskId: taskIdFilter, startTime, endTime }),
    { refreshDeps: [page, pageSize, statusFilter, taskIdFilter, startTime, endTime] },
  );

  const handleReset = () => {
    setStatusFilter(undefined);
    setTaskIdFilter(undefined);
    setDateRange(null);
    setPage(1);
    refresh();
  };

  const hasFilters = !!(statusFilter || taskIdFilter || dateRange);

  const columns = [
    {
      title: '任务',
      dataIndex: 'taskId',
      key: 'taskId',
      width: 200,
      render: (taskId: string, row: ExecutionRecord) => (
        <a onClick={() => nav(`/tasks/${taskId}`)}>{row.taskName || taskId.slice(0, 8) + '...'}</a>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (s: string) => (
        <Tag color={STATUS_COLORS[s] ?? 'default'}>
          {STATUS_LABELS[s] ?? s}
        </Tag>
      ),
    },
    {
      title: '触发方式',
      dataIndex: 'triggerType',
      key: 'triggerType',
      width: 100,
      render: (v: string) => {
        const labels: Record<string, string> = { manual: '手动', cron: 'Cron', fixed_rate: '定时', dependency: '依赖' };
        return labels[v] ?? v ?? '-';
      },
    },
    {
      title: '开始时间',
      dataIndex: 'startTime',
      key: 'startTime',
      width: 180,
      sorter: (a: ExecutionRecord, b: ExecutionRecord) =>
        new Date(a.startTime ?? 0).getTime() - new Date(b.startTime ?? 0).getTime(),
      render: (v: string) => v ? (
        <Tooltip title={dayjs(v).format('YYYY-MM-DD HH:mm:ss')}>
          <span>{dayjs(v).format('MM-DD HH:mm:ss')}</span>
        </Tooltip>
      ) : '-',
    },
    {
      title: '耗时',
      dataIndex: 'duration',
      key: 'duration',
      width: 100,
      sorter: (a: ExecutionRecord, b: ExecutionRecord) => (a.duration ?? 0) - (b.duration ?? 0),
      render: formatDuration,
    },
    {
      title: '错误信息',
      dataIndex: 'errorMessage',
      key: 'errorMessage',
      ellipsis: true,
      render: (v: string) => v ? (
        <Tooltip title={v}>
          <Typography.Text type="danger" ellipsis>{v}</Typography.Text>
        </Tooltip>
      ) : '-',
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
      render: (_: any, row: ExecutionRecord) => (
        <Space>
          <Button
            type="link"
            size="small"
            onClick={() => nav(`/tasks/${row.taskId}/executions/${row.id}`)}
          >
            详情
          </Button>
          {row.logs && (
            <Button
              type="link"
              size="small"
              onClick={() => setLogDrawer({ open: true, exec: row })}
            >
              日志
            </Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>执行记录</Typography.Title>
        <Space>
          {data && (
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              共 {data.total} 条
            </Typography.Text>
          )}
          <Tooltip title="刷新">
            <Button icon={<ReloadOutlined />} onClick={() => refresh()} loading={loading} />
          </Tooltip>
        </Space>
      </div>

      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          allowClear
          placeholder="状态筛选"
          style={{ width: 140 }}
          value={statusFilter}
          onChange={(v) => { setStatusFilter(v); setPage(1); }}
          options={[
            { label: '成功', value: 'success' },
            { label: '失败', value: 'failed' },
            { label: '运行中', value: 'running' },
            { label: '等待中', value: 'pending' },
            { label: '已取消', value: 'cancelled' },
          ]}
        />
        <Select
          allowClear
          showSearch
          placeholder="任务筛选"
          style={{ width: 220 }}
          value={taskIdFilter}
          onChange={(v) => { setTaskIdFilter(v); setPage(1); }}
          options={taskOptions}
          optionFilterProp="label"
        />
        <RangePicker
          value={dateRange}
          onChange={(v) => { setDateRange(v as [Dayjs, Dayjs] | null); setPage(1); }}
          placeholder={['开始日期', '结束日期']}
          suffixIcon={<CalendarOutlined />}
          allowClear
          style={{ width: 260 }}
        />
        {hasFilters && (
          <Button onClick={handleReset}>重置筛选</Button>
        )}
      </Space>

      {/* 状态汇总徽标 */}
      {data && data.total > 0 && (
        <Space style={{ marginBottom: 12 }} wrap>
          {Object.entries(STATUS_COLORS).map(([status, color]) => {
            const count = data.list.filter((r) => r.status === status).length;
            if (!count) return null;
            return (
              <Badge
                key={status}
                count={count}
                color={color === 'default' ? '#d9d9d9' : color}
                size="small"
              >
                <Tag color={color} style={{ marginRight: 0, cursor: 'pointer' }}
                  onClick={() => { setStatusFilter(status); setPage(1); }}
                >
                  {STATUS_LABELS[status] ?? status}
                </Tag>
              </Badge>
            );
          })}
        </Space>
      )}

      <Table
        rowKey="id"
        columns={columns}
        dataSource={data?.list ?? []}
        loading={loading}
        locale={{
          emptyText: hasFilters ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="没有符合条件的执行记录"
            >
              <Button onClick={handleReset}>清除筛选</Button>
            </Empty>
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="暂无执行记录"
            >
              <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
                创建任务并触发执行后，记录将在此显示
              </Typography.Text>
              <Button type="primary" onClick={() => nav('/tasks/new')}>新建任务</Button>
            </Empty>
          ),
        }}
        pagination={{
          current: page,
          pageSize,
          total: data?.total ?? 0,
          showSizeChanger: true,
          pageSizeOptions: ['10', '20', '50', '100'],
          showTotal: (t) => `共 ${t} 条`,
          onChange: (p, ps) => { setPage(p); setPageSize(ps); },
        }}
      />

      <Drawer
        title="执行日志"
        open={logDrawer.open}
        width={720}
        onClose={() => setLogDrawer({ open: false })}
        extra={
          logDrawer.exec && (
            <Button
              type="link"
              onClick={() => nav(`/tasks/${logDrawer.exec!.taskId}/executions/${logDrawer.exec!.id}`)}
            >
              查看完整详情
            </Button>
          )
        }
      >
        <div style={{ marginBottom: 12 }}>
          {logDrawer.exec && (
            <Space wrap>
              <Tag color={STATUS_COLORS[logDrawer.exec.status]}>{STATUS_LABELS[logDrawer.exec.status]}</Tag>
              <Typography.Text type="secondary">
                {logDrawer.exec.taskName}
              </Typography.Text>
              {logDrawer.exec.duration != null && (
                <Typography.Text type="secondary">耗时: {formatDuration(logDrawer.exec.duration)}</Typography.Text>
              )}
            </Space>
          )}
        </div>
        <pre
          style={{
            background: '#1e1e1e',
            color: '#d4d4d4',
            padding: 16,
            borderRadius: 4,
            fontSize: 13,
            overflowX: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            minHeight: 200,
          }}
        >
          {logDrawer.exec?.logs ?? '暂无日志'}
        </pre>
      </Drawer>
    </div>
  );
}
