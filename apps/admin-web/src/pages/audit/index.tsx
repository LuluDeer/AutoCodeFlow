import { useState } from 'react';
import { Table, Select, Input, Button, Space, Tag, Typography, Tooltip, Modal, DatePicker, Empty } from 'antd';
import { SearchOutlined, ReloadOutlined, EyeOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { client } from '../../api/client';
import dayjs, { type Dayjs } from 'dayjs';
import { useTranslation } from 'react-i18next';
import PageHeader from '../../components/PageHeader';
import PageSkeleton from '../../components/PageSkeleton';
// UI-16：toast-only 页补齐页内错误态标准块（错误块 + 重试，对齐 UI-08 形态）
import StateError from '../../components/StateError';
// UI-10：导入 i18n 实例（模块副作用完成初始化；树内用 useTranslation 读 key）
import '../../i18n';

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
  detail?: Record<string, unknown>;
  createdAt: string;
}

const RESULT_COLOR: Record<string, string> = { success: 'green', failure: 'red' };
const RESULT_LABELS = (t: (k: string) => string): Record<string, string> => ({
  success: t('audit.result.success'),
  failure: t('audit.result.failure'),
});

export default function AuditLogPage() {
  const { t } = useTranslation();
  const resultLabels = RESULT_LABELS(t);
  const [page, setPage] = useState(1);
  // AUTH-05: 新增 resourceId 精确筛选（与 resource 组成组合筛选）
  const [filters, setFilters] = useState({ action: '', resource: '', resourceId: '', username: '', startTime: undefined as string | undefined, endTime: undefined as string | undefined });
  const [pending, setPending] = useState({ action: '', resource: '', resourceId: '', username: '', startTime: undefined as string | undefined, endTime: undefined as string | undefined });
  const [detailModal, setDetailModal] = useState<{ open: boolean; data?: Record<string, unknown> }>({ open: false });

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['audit', page, filters],
    queryFn: async () => {
      const params: Record<string, string> = { page: String(page), pageSize: '20' };
      if (filters.action) params.action = filters.action;
      if (filters.resource) params.resource = filters.resource;
      if (filters.resourceId) params.resourceId = filters.resourceId;
      if (filters.username) params.username = filters.username;
      if (filters.startTime) params.startTime = filters.startTime;
      if (filters.endTime) params.endTime = filters.endTime;
      const qs = new URLSearchParams(params).toString();
      return client.get<{ data: AuditLog[]; total: number }>(`/audit?${qs}`) as unknown as { data: AuditLog[]; total: number };
    },
  });

  const handleSearch = () => { setPage(1); setFilters(pending); };
  const handleReset = () => {
    const e = { action: '', resource: '', resourceId: '', username: '', startTime: undefined as string | undefined, endTime: undefined as string | undefined };
    setPending(e); setFilters(e); setPage(1);
  };

  const rangePresets = [
    { label: t('audit.range.1d'), value: [dayjs().subtract(1, 'day'), dayjs()] as [Dayjs, Dayjs] },
    { label: t('audit.range.7d'), value: [dayjs().subtract(7, 'day'), dayjs()] as [Dayjs, Dayjs] },
    { label: t('audit.range.30d'), value: [dayjs().subtract(30, 'day'), dayjs()] as [Dayjs, Dayjs] },
  ];

  const hasFilters = !!(pending.action || pending.resource || pending.resourceId || pending.username || pending.startTime || pending.endTime);

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 70 },
    {
      title: t('audit.col.operator'),
      dataIndex: 'username',
      width: 120,
      render: (v: string, r: AuditLog) => (
        <Space orientation="vertical" size={0}>
          <Typography.Text strong>{v}</Typography.Text>
          {r.ip && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.ip}</Typography.Text>}
        </Space>
      ),
    },
    { title: t('audit.col.action'), dataIndex: 'action', width: 180 },
    { title: t('audit.col.resource'), dataIndex: 'resource', width: 120 },
    {
      title: t('audit.col.resourceId'),
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
      title: t('audit.col.result'),
      dataIndex: 'result',
      width: 80,
      render: (v: string) => (
        <Tag color={RESULT_COLOR[v] ?? 'default'}>{resultLabels[v] ?? v}</Tag>
      ),
    },
    {
      title: t('audit.col.detail'),
      dataIndex: 'detail',
      width: 80,
      render: (v: Record<string, unknown>) => v && Object.keys(v).length > 0 ? (
        <Button
          type="link"
          size="small"
          icon={<EyeOutlined />}
          onClick={() => setDetailModal({ open: true, data: v })}
        >
          {t('audit.action.view')}
        </Button>
      ) : '-',
    },
    {
      title: t('audit.col.time'),
      dataIndex: 'createdAt',
      width: 180,
      render: (v: string) => new Date(v).toLocaleString('zh-CN'),
    },
  ];

  return (
    <div>
      {/* UI-03/UI-08：页头标准化（原 Typography.Title 区块迁入 PageHeader） */}
      <PageHeader title={t('audit.title')} description={t('audit.description')} />
      <Space style={{ marginBottom: 16 }} wrap>
        <Input
          placeholder={t('audit.filter.keyword')}
          value={pending.action}
          onChange={(e) => setPending((p) => ({ ...p, action: e.target.value }))}
          onPressEnter={handleSearch}
          style={{ width: 160 }}
          allowClear
          prefix={<SearchOutlined />}
        />
        <Input
          placeholder={t('audit.filter.operator')}
          value={pending.username}
          onChange={(e) => setPending((p) => ({ ...p, username: e.target.value }))}
          onPressEnter={handleSearch}
          style={{ width: 140 }}
          allowClear
        />
        <Select
          placeholder={t('audit.filter.resourceType')}
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
        {/* AUTH-05: resourceId 精确筛选（与资源类型组合） */}
        <Input
          placeholder={t('audit.filter.resourceId')}
          value={pending.resourceId}
          onChange={(e) => setPending((p) => ({ ...p, resourceId: e.target.value }))}
          onPressEnter={handleSearch}
          style={{ width: 160 }}
          allowClear
        />
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
        <Button type="primary" icon={<SearchOutlined />} onClick={handleSearch}>{t('audit.action.search')}</Button>
        {hasFilters && <Button icon={<ReloadOutlined />} onClick={handleReset}>{t('audit.action.reset')}</Button>}
      </Space>
      {/* UI-16：请求失败渲染页内错误态标准块（StateError，重试=refetch），
          此前失败静默表现为「暂无审计记录」空态——查询失败与确无记录两种语义分离 */}
      {error && (
        <StateError
          error={error}
          onRetry={() => refetch()}
          title={t('audit.error.title')}
          style={{ marginBottom: 16 }}
        />
      )}
      <Table
        rowKey="id"
        loading={isLoading ? false : undefined}
        columns={columns}
        dataSource={data?.data ?? []}
        locale={{
          emptyText: isLoading
            ? <PageSkeleton variant="table" rows={3} />
            : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('audit.empty')} />,
        }}
        pagination={{
          current: page,
          pageSize: 20,
          total: data?.total,
          onChange: setPage,
          showTotal: (totalCount: number) =>
            t('audit.total', { count: totalCount }),
        }}
      />

      <Modal
        title={t('audit.modal.detail')}
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
