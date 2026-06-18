import { useState } from 'react';
import { Table, Select, Input, Button, Space, Tag, Typography, Tooltip, Modal, DatePicker } from 'antd';
import { SearchOutlined, ReloadOutlined, EyeOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { client } from '../../api/client';
import dayjs, { type Dayjs } from 'dayjs';

const { Option } = Select;

export interface AuditLog {
  id: number;
  action: string;
  resource: string;
  resourceId?: string;
  userId: number;
  username: string;
  ip?: string;
  result: 'success' | 'failure';
  detail?: Record<string, any>;
  createdAt: string;
}

const RESULT_COLOR: Record<string, string> = { success: 'green', failure: 'red' };
const RESULT_LABEL: Record<string, string> = { success: '成功', failure: '失败' };

export default function AuditLogPage() {
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ action: '', resource: '', username: '', startTime: undefined as string | undefined, endTime: undefined as string | undefined });
  const [pending, setPending] = useState({ action: '', resource: '', username: '', startTime: undefined as string | undefined, endTime: undefined as string | undefined });
  const [detailModal, setDetailModal] = useState<{ open: boolean; data?: Record<string, any> }>({ open: false });

  const { data, isLoading } = useQuery({
    queryKey: ['audit', page, filters],
    queryFn: async () => {
      const params: Record<string, string> = { page: String(page), pageSize: '20' };
      if (filters.action) params.action = filters.action;
      if (filters.resource) params.resource = filters.resource;
      if (filters.username) params.username = filters.username;
      if (filters.startTime) params.startTime = filters.startTime;
      if (filters.endTime) params.endTime = filters.endTime;
      const qs = new URLSearchParams(params).toString();
      return client.get<{ data: AuditLog[]; total: number }>(`/audit?${qs}`) as unknown as { data: AuditLog[]; total: number };
    },
  });

  const handleSearch = () => { setPage(1); setFilters(pending); };
  const handleReset = () => {
    const e = { action: '', resource: '', username: '', startTime: undefined as string | undefined, endTime: undefined as string | undefined };
    setPending(e); setFilters(e); setPage(1);
  };

  const rangePresets = [
    { label: '最近 1 天', value: [dayjs().subtract(1, 'day'), dayjs()] as [Dayjs, Dayjs] },
    { label: '最近 7 天', value: [dayjs().subtract(7, 'day'), dayjs()] as [Dayjs, Dayjs] },
    { label: '最近 30 天', value: [dayjs().subtract(30, 'day'), dayjs()] as [Dayjs, Dayjs] },
  ];

  const hasFilters = !!(pending.action || pending.resource || pending.username || pending.startTime || pending.endTime);

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 70 },
    {
      title: '操作人',
      dataIndex: 'username',
      width: 120,
      render: (v: string, r: AuditLog) => (
        <Space orientation="vertical" size={0}>
          <Typography.Text strong>{v}</Typography.Text>
          {r.ip && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.ip}</Typography.Text>}
        </Space>
      ),
    },
    { title: '操作', dataIndex: 'action', width: 180 },
    { title: '资源', dataIndex: 'resource', width: 120 },
    {
      title: '资源ID',
      dataIndex: 'resourceId',
      width: 100,
      render: (v: string) => v ? (
        <Tooltip title={v}>
          <Typography.Text style={{ fontFamily: 'monospace', fontSize: 12 }}>
            {v.length > 8 ? v.slice(0, 8) + '…' : v}
          </Typography.Text>
        </Tooltip>
      ) : '-',
    },
    {
      title: '结果',
      dataIndex: 'result',
      width: 80,
      render: (v: string) => (
        <Tag color={RESULT_COLOR[v] ?? 'default'}>{RESULT_LABEL[v] ?? v}</Tag>
      ),
    },
    {
      title: '详情',
      dataIndex: 'detail',
      width: 80,
      render: (v: Record<string, any>) => v && Object.keys(v).length > 0 ? (
        <Button
          type="link"
          size="small"
          icon={<EyeOutlined />}
          onClick={() => setDetailModal({ open: true, data: v })}
        >
          查看
        </Button>
      ) : '-',
    },
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 180,
      render: (v: string) => new Date(v).toLocaleString('zh-CN'),
    },
  ];

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Typography.Title level={4} style={{ margin: 0 }}>审计日志</Typography.Title>
      </div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Input
          placeholder="操作关键词"
          value={pending.action}
          onChange={(e) => setPending((p) => ({ ...p, action: e.target.value }))}
          onPressEnter={handleSearch}
          style={{ width: 160 }}
          allowClear
          prefix={<SearchOutlined />}
        />
        <Input
          placeholder="操作人"
          value={pending.username}
          onChange={(e) => setPending((p) => ({ ...p, username: e.target.value }))}
          onPressEnter={handleSearch}
          style={{ width: 140 }}
          allowClear
        />
        <Select
          placeholder="资源类型"
          value={pending.resource || undefined}
          onChange={(v) => setPending((p) => ({ ...p, resource: v ?? '' }))}
          allowClear
          style={{ width: 140 }}
        >
          <Option value="task">task</Option>
          <Option value="executor">executor</Option>
          <Option value="config">config</Option>
          <Option value="user">user</Option>
          <Option value="application">application</Option>
        </Select>
        <DatePicker.RangePicker
          presets={rangePresets}
          onChange={(dates) => {
            setPending((p) => ({
              ...p,
              startTime: dates?.[0]?.toISOString() ?? undefined,
              endTime: dates?.[1]?.toISOString() ?? undefined,
            }));
          }}
        />
        <Button type="primary" icon={<SearchOutlined />} onClick={handleSearch}>搜索</Button>
        {hasFilters && <Button icon={<ReloadOutlined />} onClick={handleReset}>重置</Button>}
      </Space>
      <Table
        rowKey="id"
        loading={isLoading}
        columns={columns}
        dataSource={data?.data ?? []}
        locale={{ emptyText: '暂无审计记录' }}
        pagination={{
          current: page,
          pageSize: 20,
          total: data?.total,
          onChange: setPage,
          showTotal: (t) => `共 ${t} 条`,
        }}
      />

      <Modal
        title="详情"
        open={detailModal.open}
        onCancel={() => setDetailModal({ open: false })}
        footer={null}
        width={600}
        destroyOnHidden
      >
        <pre style={{ background: '#f5f5f5', padding: 16, borderRadius: 4, fontSize: 13, overflowX: 'auto' }}>
          {detailModal.data ? JSON.stringify(detailModal.data, null, 2) : ''}
        </pre>
      </Modal>
    </div>
  );
}
