import React, { useState } from 'react';
import { Table, Select, Input, Button, Space, Tag } from 'antd';
import { SearchOutlined, ReloadOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { client } from '../../api/client';

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

export default function AuditLogPage() {
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ action: '', resource: '' });
  const [pending, setPending] = useState({ action: '', resource: '' });

  const { data, isLoading } = useQuery({
    queryKey: ['audit', page, filters],
    queryFn: async () => {
      const params: Record<string, string> = { page: String(page), pageSize: '20' };
      if (filters.action) params.action = filters.action;
      if (filters.resource) params.resource = filters.resource;
      const qs = new URLSearchParams(params).toString();
      return client.get<{ data: AuditLog[]; total: number }>(`/audit?${qs}`) as unknown as { data: AuditLog[]; total: number };
    },
  });

  const handleSearch = () => { setPage(1); setFilters(pending); };
  const handleReset = () => { const e = { action: '', resource: '' }; setPending(e); setFilters(e); setPage(1); };

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 70 },
    { title: '操作', dataIndex: 'action', width: 150 },
    { title: '资源', dataIndex: 'resource', width: 120 },
    { title: '资源ID', dataIndex: 'resourceId', width: 100, render: (v: string) => v || '-' },
    { title: '操作人', dataIndex: 'username', width: 120 },
    { title: 'IP', dataIndex: 'ip', width: 140, render: (v: string) => v || '-' },
    {
      title: '结果',
      dataIndex: 'result',
      width: 80,
      render: (v: string) => (
        <Tag color={RESULT_COLOR[v] ?? 'default'}>{v === 'success' ? '成功' : '失败'}</Tag>
      ),
    },
    {
      title: '详情',
      dataIndex: 'detail',
      render: (v: Record<string, any>) => v ? JSON.stringify(v) : '-',
    },
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 180,
      render: (v: string) => new Date(v).toLocaleString(),
    },
  ];

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ margin: '0 0 16px 0' }}>审计日志</h2>
        <Space wrap>
          <Input
            placeholder="操作"
            value={pending.action}
            onChange={(e) => setPending((p) => ({ ...p, action: e.target.value }))}
            style={{ width: 160 }}
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
          </Select>
          <Button type="primary" icon={<SearchOutlined />} onClick={handleSearch}>搜索</Button>
          <Button icon={<ReloadOutlined />} onClick={handleReset}>重置</Button>
        </Space>
      </div>
      <Table
        rowKey="id"
        loading={isLoading}
        columns={columns}
        dataSource={data?.data}
        pagination={{
          current: page,
          pageSize: 20,
          total: data?.total,
          onChange: setPage,
          showTotal: (t) => `共 ${t} 条`,
        }}
      />
    </div>
  );
}
