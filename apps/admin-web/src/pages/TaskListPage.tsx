import { useState } from 'react';
import {
  Table, Button, Tag, Space, Typography, message, Input, Select,
  Badge, Popconfirm, Tooltip, Empty, Switch, Modal, Form, Alert,
} from 'antd';
import {
  PlusOutlined, SearchOutlined, FilterOutlined, ThunderboltOutlined,
  CopyOutlined, DeleteOutlined, EyeOutlined, EditOutlined,
  CheckSquareOutlined, FileTextOutlined,
} from '@ant-design/icons';
import { Trans, useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { tasksApi, Task } from '../api/tasks';
import { useTasksList, invalidateTaskData } from '../api/queries';
import { getErrMsg } from '../utils/error';
import { useDebounce } from '../hooks/useDebounce';
import { priorityTag } from '../utils/priority';
import ParamsEditor from '../components/ParamsEditor';
import PageHeader from '../components/PageHeader';
import StateError from '../components/StateError';
// UI-10：导入 i18n 实例（模块副作用完成初始化；树内用 useTranslation 读 key）
import '../i18n';

const { Text } = Typography;

type BadgeStatus = 'success' | 'processing' | 'error' | 'default' | 'warning';
const STATUS_CONFIG = (t: (k: string) => string): Record<string, { badge: BadgeStatus; label: string; color: string }> => ({
  active: { badge: 'success', label: t('taskList.status.active'), color: 'green' },
  paused: { badge: 'warning', label: t('taskList.status.paused'), color: 'orange' },
  inactive: { badge: 'default', label: t('taskList.status.inactive'), color: 'default' },
  failed: { badge: 'error', label: t('taskList.status.failed'), color: 'red' },
});

const TRIGGER_LABEL = (t: (k: string) => string): Record<string, string> => ({
  manual: t('taskList.trigger.manual'), cron: t('taskList.trigger.cron'), fixed_rate: t('taskList.trigger.fixed_rate'), dependency: t('taskList.trigger.dependency'),
});

const TRIGGER_COLOR: Record<string, string> = {
  manual: 'default', cron: 'blue', fixed_rate: 'geekblue', dependency: 'purple',
};

export default function TaskListPage() {
  const nav = useNavigate();
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [triggerFilter, setTriggerFilter] = useState<string | undefined>();
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);
  const [triggerTarget, setTriggerTarget] = useState<{ id: string; name: string; defaultParams?: Record<string, unknown> } | null>(null);
  const [triggerParams, setTriggerParams] = useState<Record<string, string>>({});
  const [triggering, setTriggering] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [batchLoading, setBatchLoading] = useState(false);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  // 搜索防抖：输入框即时回显 search，列表查询跟随 debounced 值，避免每击键发请求
  const debouncedSearch = useDebounce(search);

  const { data, isLoading: loading, error, refetch } = useTasksList({
    page,
    pageSize,
    name: debouncedSearch || undefined,
    status: statusFilter,
    triggerType: triggerFilter,
  });
  // FEAT-17: 写后失效句柄（原 useRequest refresh → invalidate 面收口）
  const queryClient = useQueryClient();
  const refresh = () => void invalidateTaskData(queryClient);

  const tasks: Task[] = data?.items ?? [];
  const total: number = data?.total ?? 0;

  const hasFilters = !!(search || statusFilter || triggerFilter);

  const rowSelection = {
    selectedRowKeys,
    onChange: (keys: React.Key[]) => setSelectedRowKeys(keys as string[]),
  };

  const handleBatchTrigger = async () => {
    if (batchLoading) return;
    setBatchLoading(true);
    try { await tasksApi.batchTrigger(selectedRowKeys); message.success(t('taskList.batchTriggered', { count: selectedRowKeys.length })); setSelectedRowKeys([]); refresh(); }
    catch (err: unknown) { message.error(getErrMsg(err, t('taskList.batchTriggerFail'))); }
    finally { setBatchLoading(false); }
  };
  const handleBatchPause = async () => {
    if (batchLoading) return;
    setBatchLoading(true);
    try { await tasksApi.batchPause(selectedRowKeys); message.success(t('taskList.batchPaused', { count: selectedRowKeys.length })); setSelectedRowKeys([]); refresh(); }
    catch (err: unknown) { message.error(getErrMsg(err, t('taskList.batchPauseFail'))); }
    finally { setBatchLoading(false); }
  };
  const handleBatchResume = async () => {
    if (batchLoading) return;
    setBatchLoading(true);
    try { await tasksApi.batchResume(selectedRowKeys); message.success(t('taskList.batchResumed', { count: selectedRowKeys.length })); setSelectedRowKeys([]); refresh(); }
    catch (err: unknown) { message.error(getErrMsg(err, t('taskList.batchResumeFail'))); }
    finally { setBatchLoading(false); }
  };
  const handleBatchDelete = async () => {
    if (batchLoading) return;
    setBatchLoading(true);
    try { await tasksApi.batchDelete(selectedRowKeys); message.success(t('taskList.batchDeleted', { count: selectedRowKeys.length })); setSelectedRowKeys([]); refresh(); }
    catch (err: unknown) { message.error(getErrMsg(err, t('taskList.batchDeleteFail'))); }
    finally { setBatchLoading(false); }
  };

  const handleTrigger = (id: string, name: string, defaultParams?: Record<string, unknown>) => {
    setTriggerParams(
      Object.fromEntries(Object.entries(defaultParams ?? {}).map(([k, v]) => [k, String(v)]))
    );
    setTriggerTarget({ id, name, defaultParams });
  };

  const handleTriggerConfirm = async () => {
    if (!triggerTarget) return;
    setTriggering(true);
    try {
      const params = Object.fromEntries(
        Object.entries(triggerParams).filter(([k]) => k.trim())
      );
      await tasksApi.trigger(triggerTarget.id, Object.keys(params).length > 0 ? params : undefined);
      message.success(t('taskList.triggered', { name: triggerTarget.name }));
      setTriggerTarget(null);
      setTimeout(refresh, 1000);
    } catch (err: unknown) {
      message.error(getErrMsg(err, t('taskList.triggerFail')));
    } finally {
      setTriggering(false);
    }
  };

  const handlePause = async (id: string) => {
    if (togglingId) return;
    setTogglingId(id);
    try { await tasksApi.pause(id); message.success(t('taskList.paused')); refresh(); }
    catch (err: unknown) { message.error(getErrMsg(err, t('taskList.pauseFail'))); }
    finally { setTogglingId(null); }
  };

  const handleResume = async (id: string) => {
    if (togglingId) return;
    setTogglingId(id);
    try { await tasksApi.resume(id); message.success(t('taskList.resumed')); refresh(); }
    catch (err: unknown) { message.error(getErrMsg(err, t('taskList.resumeFail'))); }
    finally { setTogglingId(null); }
  };

  const handleDelete = async (id: string) => {
    try { await tasksApi.delete(id); message.success(t('taskList.deleted')); refresh(); }
    catch (err: unknown) { message.error(getErrMsg(err, t('taskList.deleteFail'))); }
  };

  // CORE-03-lite：一键克隆——复制任务全部可编辑字段生成 "-copy-" 副本，
  // 服务端字段（id/createdAt/status 等）不回传；glue 源码一并复制。
  const [cloningId, setCloningId] = useState<string | null>(null);
  const handleClone = async (r: Task) => {
    if (cloningId) return;
    setCloningId(r.id);
    try {
      const src = await tasksApi.get(r.id);
      const cloneName = `${r.name}-copy-${String(Date.now()).slice(-4)}`;
      const payload: Record<string, unknown> = {
        name: cloneName,
        description: src.description,
        runtime: src.runtime,
        entrypoint: src.entrypoint,
        requirements: src.requirements ?? [],
        triggerType: src.triggerType,
        cronExpression: src.cronExpression,
        timezone: src.timezone,
        fixedRate: src.fixedRate,
        timeout: src.timeoutSeconds ?? src.timeout,
        maxRetry: src.maxRetry,
        retryDelay: src.retryDelay,
        retryableErrors: src.retryableErrors,
        priority: typeof src.priority === 'number' ? src.priority : undefined,
        params: src.params,
        dependencies: src.dependencies,
        executeMode: src.executeMode,
        executorId: src.executorId,
        executorGroup: src.executorGroup,
        executorTags: src.executorTags,
        gitRepo: src.gitRepo,
        gitBranch: src.gitBranch,
        gitCommit: src.gitCommit,
        glueSource: src.glueSource,
        glueLanguage: src.glueLanguage,
        applicationId: src.applicationId,
      };
      Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);
      const created = await tasksApi.create(payload);
      message.success(t('taskList.cloned', { name: cloneName }));
      nav(`/tasks/${created.id}`);
    } catch (err: unknown) {
      message.error(getErrMsg(err, t('taskList.cloneFail')));
    } finally {
      setCloningId(null);
    }
  };

  // UI-09：375px 可用性——关键列=名称/状态/启用/操作（值班首查项），其余次要列
  // responsive: ['md'] 在窄屏收起（CSS 侧 .ui09-hide-mobile 双保险）；
  // scroll.x 兜底横向滚动。onHeaderCell/onCell 挂类供媒体查询隐藏次要列。
  const hideOnMobile = {
    onHeaderCell: () => ({ className: 'ui09-hide-mobile' }),
    onCell: () => ({ className: 'ui09-hide-mobile' }),
  } as const;
  const statusConfig = STATUS_CONFIG(t);
  const triggerLabel = TRIGGER_LABEL(t);
  const columns = [
    {
      title: t('taskList.col.name'),
      key: 'name',
      sorter: (a: Task, b: Task) => a.name.localeCompare(b.name),
      render: (_: unknown, r: Task) => (
        <Space orientation="vertical" size={0}>
          <a onClick={() => nav(`/tasks/${r.id}`)} style={{ fontWeight: 500 }}>{r.name}</a>
          {r.description && <Text type="secondary" style={{ fontSize: 12 }}>{r.description}</Text>}
        </Space>
      ),
    },
    {
      title: t('taskList.col.status'),
      dataIndex: 'status',
      width: 90,
      render: (s: string) => {
        const cfg = statusConfig[s] || { badge: 'default', label: s, color: 'default' };
        return <Badge status={cfg.badge} text={cfg.label} />;
      },
    },
    {
      title: t('taskList.col.trigger'),
      dataIndex: 'triggerType',
      width: 100,
      ...hideOnMobile,
      render: (v: string) => (
        <Tag color={TRIGGER_COLOR[v] || 'default'}>{triggerLabel[v] || v}</Tag>
      ),
    },
    {
      title: t('taskList.col.priority'),
      key: 'priority',
      width: 80,
      ...hideOnMobile,
      render: (_: unknown, r: Task) => {
        const t2 = priorityTag(r.priority);
        return <Tag color={t2.color}>{t2.label}</Tag>;
      },
    },
    {
      title: t('taskList.col.schedule'),
      key: 'schedule',
      width: 160,
      ...hideOnMobile,
      render: (_: unknown, r: Task) => {
        if (r.triggerType === 'cron' && r.cronExpression) {
          return <Text code style={{ fontSize: 12 }}>{r.cronExpression}</Text>;
        }
        if (r.triggerType === 'fixed_rate' && r.fixedRate) {
          const secs = r.fixedRate;
          if (secs < 60) return <Text type="secondary" style={{ fontSize: 12 }}>{t('taskList.schedule.sec', { sec: secs })}</Text>;
          const mins = Math.floor(secs / 60);
          const rem = secs % 60;
          const label = rem > 0 ? t('taskList.schedule.minSec', { min: mins, sec: rem }) : t('taskList.schedule.min', { min: mins });
          return <Text type="secondary" style={{ fontSize: 12 }}>{t('taskList.schedule.sec', { sec: label })}</Text>;
        }
        return <Text type="secondary" style={{ fontSize: 12 }}>{t('taskList.nextRun.none')}</Text>;
      },
    },
    {
      title: t('taskList.col.nextRun'),
      key: 'nextRun',
      width: 150,
      ...hideOnMobile,
      render: (_: unknown, r: Task) => {
        if (r.status !== 'active') return <Text type="secondary" style={{ fontSize: 12 }}>{t('taskList.nextRun.none')}</Text>;
        if (r.triggerType === 'cron' && r.cronExpression) {
          return (
            <Tooltip title={t('taskList.nextRun.cronTooltip')}>
              <Tag color="blue" style={{ fontSize: 11 }}>{t('taskList.nextRun.cronScheduled')}</Tag>
            </Tooltip>
          );
        }
        if (r.triggerType === 'fixed_rate' && r.fixedRate) {
          return <Tag color="geekblue" style={{ fontSize: 11 }}>{t('taskList.nextRun.fixedRunning')}</Tag>;
        }
        return <Text type="secondary" style={{ fontSize: 12 }}>{t('taskList.nextRun.manual')}</Text>;
      },
    },
    {
      title: t('taskList.col.runtime'),
      dataIndex: 'runtime',
      width: 80,
      ...hideOnMobile,
      render: (v: string) => v ? <Tag>{v}</Tag> : '-',
    },
    {
      title: t('taskList.col.enabled'),
      key: 'toggle',
      width: 70,
      render: (_: unknown, r: Task) => (
        <Switch
          size="small"
          checked={r.status === 'active'}
          loading={togglingId === r.id}
          onChange={checked => checked ? handleResume(r.id) : handlePause(r.id)}
          disabled={r.status === 'failed' || r.status === 'inactive' || (!!togglingId && togglingId !== r.id)}
        />
      ),
    },
    {
      title: t('taskList.col.actions'),
      key: 'actions',
      width: 160,
      render: (_: unknown, r: Task) => (
        <Space size={2}>
          <Tooltip title={t('taskList.action.detail')}>
            <Button type="text" size="small" icon={<EyeOutlined />} onClick={() => nav(`/tasks/${r.id}`)} />
          </Tooltip>
          <Tooltip title={t('taskList.action.edit')}>
            <Button type="text" size="small" icon={<EditOutlined />} onClick={() => nav(`/tasks/${r.id}/edit`)} />
          </Tooltip>
          <Tooltip title={t('taskList.action.clone')}>
            <Button
              type="text" size="small" icon={<CopyOutlined />}
              loading={cloningId === r.id}
              onClick={() => handleClone(r)}
            />
          </Tooltip>
          <Tooltip title={t('taskList.action.trigger')}>
            <Button
              type="text" size="small" icon={<ThunderboltOutlined />}
              onClick={() => handleTrigger(r.id, r.name, r.params)}
              style={{ color: '#1677ff' }}
            />
          </Tooltip>
          <Popconfirm
            title={t('taskList.deleteConfirm')}
            onConfirm={() => handleDelete(r.id)}
            okText={t('taskList.ok')} okButtonProps={{ danger: true }}
          >
            <Tooltip title={t('taskList.action.delete')}>
              <Button type="text" size="small" icon={<DeleteOutlined />} danger />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      {/* UI-03：页头标准化（原 Typography.Title 区块迁入 PageHeader，操作按钮进 extra） */}
      <PageHeader
        title={t('taskList.title')}
        description={t('taskList.total', { count: total })}
        extra={
          <>
            {/* CORE-03: 任务模板入口——从预置/自定义模板一键克隆 config */}
            <Button icon={<FileTextOutlined />} onClick={() => nav('/task-templates')}>
              {t('taskList.templates')}
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => nav('/tasks/new')}>
              {t('taskList.create')}
            </Button>
          </>
        }
      />

      {/* UI-09：筛选区 wrap 堆叠（Space wrap 已有），输入/选择窄屏自适应宽度 */}
      <Space style={{ marginBottom: 16 }} wrap className="ui09-filter-bar">
        <Input
          placeholder={t('taskList.searchPlaceholder')}
          prefix={<SearchOutlined />}
          value={search}
          onChange={e => setSearch(e.target.value)}
          allowClear
          style={{ width: 220, maxWidth: '100%' }}
        />
        <Select
          placeholder={t('taskList.statusAll')}
          allowClear
          style={{ width: 110, maxWidth: '100%' }}
          value={statusFilter}
          onChange={setStatusFilter}
          suffixIcon={<FilterOutlined />}
          options={[
            { value: 'active', label: t('taskList.status.active') },
            { value: 'paused', label: t('taskList.status.paused') },
          ]}
        />
        <Select
          placeholder={t('taskList.triggerAll')}
          allowClear
          style={{ width: 120, maxWidth: '100%' }}
          value={triggerFilter}
          onChange={setTriggerFilter}
          options={[
            { value: 'manual', label: t('taskList.trigger.manual') },
            { value: 'cron', label: t('taskList.trigger.cron') },
            { value: 'fixed_rate', label: t('taskList.trigger.fixed_rate') },
          ]}
        />
        {hasFilters && (
          <Button size="small" onClick={() => { setSearch(''); setStatusFilter(undefined); setTriggerFilter(undefined); }}>
            {t('taskList.clearFilters')}
          </Button>
        )}
        {hasFilters && (
          <Text type="secondary" style={{ fontSize: 13 }}>
            {t('taskList.count', { count: total })}
          </Text>
        )}
      </Space>

      {selectedRowKeys.length > 0 && (
        <div style={{ background: '#e6f4ff', border: '1px solid #91caff', borderRadius: 6, padding: '8px 16px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <CheckSquareOutlined style={{ color: '#1677ff' }} />
          <Text><Trans i18nKey="taskList.selected" values={{ count: selectedRowKeys.length }}><strong>0</strong></Trans></Text>
          <Button size="small" icon={<ThunderboltOutlined />} loading={batchLoading} disabled={batchLoading} onClick={handleBatchTrigger}>{t('taskList.batchTrigger')}</Button>
          <Button size="small" loading={batchLoading} disabled={batchLoading} onClick={handleBatchPause}>{t('taskList.batchPause')}</Button>
          <Button size="small" loading={batchLoading} disabled={batchLoading} onClick={handleBatchResume}>{t('taskList.batchResume')}</Button>
          <Popconfirm title={t('taskList.batchTrigger.confirm', { count: selectedRowKeys.length })} onConfirm={handleBatchDelete} okText={t('taskList.ok')} okButtonProps={{ danger: true }}>
            <Button size="small" danger icon={<DeleteOutlined />} loading={batchLoading} disabled={batchLoading}>{t('taskList.batchDelete')}</Button>
          </Popconfirm>
          <Button size="small" disabled={batchLoading} onClick={() => setSelectedRowKeys([])}>{t('taskList.cancelSelect')}</Button>
        </div>
      )}

      <Modal
        title={<Space><ThunderboltOutlined /> {t('taskList.triggerModal.title', { name: triggerTarget?.name })}</Space>}
        open={!!triggerTarget}
        onCancel={() => setTriggerTarget(null)}
        onOk={handleTriggerConfirm}
        okText={t('taskList.trigger')}
        okButtonProps={{ loading: triggering, icon: <ThunderboltOutlined /> }}
        cancelText={t('taskList.cancel')}
        width={520}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          title={t('taskList.triggerParams.title')}
          description={t('taskList.triggerParams.desc')}
          style={{ marginBottom: 16 }}
        />
        <Form layout="vertical">
          <Form.Item label={t('taskList.params.label')}>
            <ParamsEditor
              value={triggerParams}
              onChange={setTriggerParams}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* UI-16：列表请求失败不再只弹 toast —— 页内原位呈现错误块 + 重试入口
          （写操作失败仍走 toast，语义不变） */}
      {error && (
        <StateError
          error={error}
          title={t('taskList.error.title')}
          onRetry={() => void refetch()}
          style={{ marginBottom: 16 }}
        />
      )}

      <Table
        rowKey="id"
        rowSelection={rowSelection}
        columns={columns}
        dataSource={tasks}
        loading={loading}
        // UI-09：次要列窄屏收起（CSS 媒体查询 .ui09-hide-mobile）+ scroll.x 横向滚动兜底
        scroll={{ x: 760 }}
        pagination={{
          total,
          current: page,
          pageSize,
          onChange: (p, ps) => { setPage(p); setPageSize(ps ?? 20); },
          showTotal: (t2) => t('taskList.count', { count: t2 }),
          showSizeChanger: true,
        }}
        locale={{
          emptyText: hasFilters
            ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('taskList.empty.noMatch')} />
            : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('taskList.empty.none')}>
                <Button type="primary" onClick={() => nav('/tasks/new')}>{t('taskList.empty.createFirst')}</Button>
              </Empty>
            ),
        }}
      />
    </div>
  );
}
