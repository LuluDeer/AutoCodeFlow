import { useState } from 'react';
import { Table, Select, Input, Button, Space, Tag, Typography, Tooltip, Modal, DatePicker, Empty, theme, Card } from 'antd';
import { SearchOutlined, ReloadOutlined, EyeOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { client } from '../../api/client';
// F-26（DEEP_REVIEW 0ef3bbe）：locale 单一来源，不再硬编码 zh-CN
import { currentLocale } from '../../utils/locale';
import dayjs, { type Dayjs } from 'dayjs';
import { useTranslation } from 'react-i18next';
import PageHeader from '../../components/PageHeader';
import PageSkeleton from '../../components/PageSkeleton';
// UI-16：toast-only 页补齐页内错误态标准块（错误块 + 重试，对齐 UI-08 形态）
import StateError from '../../components/StateError';
// MOBILE-CARD-01：≤768px 表格 → 卡片列表（结构级降级，CSS 做不到）
import { useIsMobile } from '../../hooks/useIsMobile';
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

/**
 * AUDIT-01：action 代码 → 本地化标签。键与 admin-api 全量审计写入点对齐；
 * 未知值回退原始代码——宁可露出 `some_new_action` 也不把可检索的审计信息
 * 抹成"未知操作"。
 */
const ACTION_LABEL_KEYS: Record<string, string> = {
  'auth.login': 'audit.action.auth_login',
  'auth.logout': 'audit.action.auth_logout',
  'auth.session.revoke': 'audit.action.auth_session_revoke',
  'auth.session.revoke_others': 'audit.action.auth_session_revoke_others',
  'apikey.create': 'audit.action.apikey_create',
  'apikey.revoke': 'audit.action.apikey_revoke',
  'apikey.used': 'audit.action.apikey_used',
  'apikey.auth_failure': 'audit.action.apikey_auth_failure',
  'application.create': 'audit.action.application_create',
  'application.update': 'audit.action.application_update',
  'application.delete': 'audit.action.application_delete',
  'application.deploy': 'audit.action.application_deploy',
  'deployment.approve': 'audit.action.deployment_approve',
  'deployment.reject': 'audit.action.deployment_reject',
  'deployment.rollback': 'audit.action.deployment_rollback',
  'deployment.stop': 'audit.action.deployment_stop',
  'deployment.delete': 'audit.action.deployment_delete',
  'executor.rotate_token': 'audit.action.executor_rotate_token',
  'task.create': 'audit.action.task_create',
  'task.update': 'audit.action.task_update',
  'task.delete': 'audit.action.task_delete',
  'task.trigger': 'audit.action.task_trigger',
  'task.trigger_api': 'audit.action.task_trigger_api',
  'task.trigger_dependency': 'audit.action.task_trigger_dependency',
  'task.batch_trigger': 'audit.action.task_batch_trigger',
  'task.batch_pause': 'audit.action.task_batch_pause',
  'task.batch_resume': 'audit.action.task_batch_resume',
  'task.batch_delete': 'audit.action.task_batch_delete',
  'task.pause': 'audit.action.task_pause',
  'task.resume': 'audit.action.task_resume',
  'task.killExecution': 'audit.action.task_killExecution',
  'task.updateGlue': 'audit.action.task_updateGlue',
  'task.analyzeExecution': 'audit.action.task_analyzeExecution',
  'task.rollback': 'audit.action.task_rollback',
  'task.rollbackToVersion': 'audit.action.task_rollbackToVersion',
  'task_template.delete': 'audit.action.task_template_delete',
  'user.create': 'audit.action.user_create',
  'user.update': 'audit.action.user_update',
  'user.delete': 'audit.action.user_delete',
  'project.create': 'audit.action.project_create',
  'project.update': 'audit.action.project_update',
  'project.delete': 'audit.action.project_delete',
  'member.grant': 'audit.action.member_grant',
  'member.update': 'audit.action.member_update',
  'member.revoke': 'audit.action.member_revoke',
  'notification.channel.update': 'audit.action.notification_channel_update',
  'notification.silence.create': 'audit.action.notification_silence_create',
  'notification.silence.delete': 'audit.action.notification_silence_delete',
  'registry.pypi.upload': 'audit.action.registry_pypi_upload',
  'subscription.create': 'audit.action.subscription_create',
  'subscription.update': 'audit.action.subscription_update',
  'subscription.delete': 'audit.action.subscription_delete',
  'subscription.deadLetter.delete': 'audit.action.subscription_deadLetter_delete',
};

/** 可跳转的资源类型 → 前端详情路由（其余类型无独立详情页，返回 null） */
function resourceIdHref(resource: string | undefined, id: string): string | null {
  if (!resource || !id) return null;
  if (resource === 'task') return `/tasks/${id}`;
  if (resource === 'application') return `/applications/${id}`;
  if (resource === 'executor') return `/executors/${id}`;
  return null;
}

export default function AuditLogPage() {
  const { t } = useTranslation();
  // MOBILE-CARD-01：≤768px 表格 → 卡片列表
  const isMobile = useIsMobile();
  // F-15（DEEP_REVIEW 0ef3bbe）：详情 pre 背景走 antd token，暗色主题自适应。
  const { token } = theme.useToken();
  const resultLabels = RESULT_LABELS(t);
  const [page, setPage] = useState(1);
  // AUTH-05: 新增 resourceId 精确筛选（与 resource 组成组合筛选）
  const [filters, setFilters] = useState({ action: '', resource: '', resourceId: '', username: '', startTime: undefined as string | undefined, endTime: undefined as string | undefined });
  const [pending, setPending] = useState({ action: '', resource: '', resourceId: '', username: '', startTime: undefined as string | undefined, endTime: undefined as string | undefined });
  const [detailModal, setDetailModal] = useState<{ open: boolean; data?: Record<string, unknown> }>({ open: false });

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['audit', page, filters],
    // NETOPT-C P3: 长挂载页面的 useQuery 也接 AbortSignal——翻页/离开页面后
    // in-flight 请求被取消，失败 toast 不再打在已离开的页面。
    queryFn: async ({ signal }) => {
      const params: Record<string, string> = { page: String(page), pageSize: '20' };
      if (filters.action) params.action = filters.action;
      if (filters.resource) params.resource = filters.resource;
      if (filters.resourceId) params.resourceId = filters.resourceId;
      if (filters.username) params.username = filters.username;
      if (filters.startTime) params.startTime = filters.startTime;
      if (filters.endTime) params.endTime = filters.endTime;
      const qs = new URLSearchParams(params).toString();
      return client.get<{ data: AuditLog[]; total: number }>(`/audit?${qs}`, { signal }) as unknown as { data: AuditLog[]; total: number };
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
      // AUDIT-02：调度器/API 等系统行为无登录用户——空白单元格改为显式
      // 「系统」Tag，此前看起来像数据缺失
      render: (v: string, r: AuditLog) => (
        <Space orientation="vertical" size={0}>
          {v ? <Typography.Text strong>{v}</Typography.Text> : <Tag>{t('audit.operator.system')}</Tag>}
          {r.ip && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.ip}</Typography.Text>}
        </Space>
      ),
    },
    {
      title: t('audit.col.action'),
      dataIndex: 'action',
      width: 180,
      ellipsis: true,
      // AUDIT-01：已知 action 显示本地化标签，未知值回退原始代码（等宽字体
      // 保留可检索性）
      render: (v: string) => {
        const labelKey = ACTION_LABEL_KEYS[v];
        return labelKey ? (
          <Typography.Text>{t(labelKey)}</Typography.Text>
        ) : (
          <Typography.Text code style={{ fontSize: 12 }}>{v}</Typography.Text>
        );
      },
    },
    { title: t('audit.col.resource'), dataIndex: 'resource', width: 120, ellipsis: true },
    {
      title: t('audit.col.resourceId'),
      dataIndex: 'resourceId',
      width: 100,
      // AUDIT-03：task/application/executor 资源直接链接到详情页，审计 → 溯源
      // 一步到位（其余类型无详情路由，维持纯文本）
      render: (v: string, r: AuditLog) => {
        if (!v) return '-';
        const href = resourceIdHref(r.resource, v);
        const content = (
          <Typography.Text style={{ fontFamily: 'monospace', fontSize: 12 }}>
            {v.length > 8 ? v.slice(0, 8) + '…' : v}
          </Typography.Text>
        );
        return (
          <Tooltip title={href ? `${v}（${t('audit.resourceId.open')}）` : v}>
            {href ? <Link to={href}>{content}</Link> : content}
          </Tooltip>
        );
      },
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
      render: (v: string) => new Date(v).toLocaleString(currentLocale()),
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
      {isMobile ? (
        /* MOBILE-CARD-01：≤768px 卡片列表——8 列定宽表格在 375px 需横向滚动，
           操作码/UUID 列完全不可读。卡片按首查信息组织：操作+结果 / 操作人·IP /
           资源+资源ID / 时间 / 详情。分页沿用表格的服务端分页（page/pageSize）。 */
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(data?.data ?? []).length === 0 ? (
            isLoading
              ? <PageSkeleton variant="table" rows={3} />
              : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('audit.empty')} />
          ) : (
            (data?.data ?? []).map((r: AuditLog) => {
              const labelKey = ACTION_LABEL_KEYS[r.action];
              const href = resourceIdHref(r.resource, r.resourceId ?? '');
              return (
                <Card key={r.id} size="small">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    {labelKey ? (
                      <Typography.Text strong style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t(labelKey)}</Typography.Text>
                    ) : (
                      <Typography.Text code style={{ fontSize: 12, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.action}</Typography.Text>
                    )}
                    <Tag color={RESULT_COLOR[r.result] ?? 'default'} style={{ marginInlineEnd: 0 }}>{resultLabels[r.result] ?? r.result}</Tag>
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12, color: 'var(--chart-axis-text)' }}>
                    {r.username ? r.username : t('audit.operator.system')}
                    {r.ip ? ` · ${r.ip}` : ''}
                  </div>
                  <div style={{ marginTop: 4, fontSize: 12, color: 'var(--chart-axis-text)' }}>
                    {r.resource}
                    {r.resourceId ? (
                      <>
                        {' · '}
                        {href ? <Link to={href}>{r.resourceId.slice(0, 8)}…</Link> : r.resourceId.slice(0, 8) + '…'}
                      </>
                    ) : null}
                  </div>
                  <div style={{ marginTop: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {new Date(r.createdAt).toLocaleString(currentLocale())}
                    </Typography.Text>
                    {r.detail && Object.keys(r.detail).length > 0 && (
                      <Button
                        type="link"
                        size="small"
                        icon={<EyeOutlined />}
                        onClick={() => setDetailModal({ open: true, data: r.detail })}
                      >
                        {t('audit.action.view')}
                      </Button>
                    )}
                  </div>
                </Card>
              );
            })
          )}
        </div>
      ) : (
      <Table
        rowKey="id"
        // UI 打磨（原 loading={isLoading ? false : undefined}）：首屏骨架由
        // locale.emptyText 的 PageSkeleton 承担（UI-08 契约不变），Table loading
        // 改回真实 isLoading——翻页/筛选重查时可见加载反馈，不再静默显示旧数据。
        loading={isLoading}
        columns={columns}
        // UI 打磨：定宽列合计 930（70+120+180+120+100+80+80+180）→ scroll.x 同值，
        // 窄屏横向滚动兜底（审查建议 1040，按「列宽合计与 scroll.x 必须一致」取 930）
        scroll={{ x: 930 }}
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
      )}

      <Modal
        title={t('audit.modal.detail')}
        open={detailModal.open}
        onCancel={() => setDetailModal({ open: false })}
        footer={null}
        width={600}
        destroyOnHidden
      >
        {/* UI 打磨：长 detail JSON 限高内滚，避免弹窗被撑出视口 */}
        <pre style={{ background: token.colorFillQuaternary, padding: 16, borderRadius: 4, fontSize: 13, overflowX: 'auto', maxHeight: 480, overflowY: 'auto' }}>
          {detailModal.data ? JSON.stringify(detailModal.data, null, 2) : ''}
        </pre>
      </Modal>
    </div>
  );
}
