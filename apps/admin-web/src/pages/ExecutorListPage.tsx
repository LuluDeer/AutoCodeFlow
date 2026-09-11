import { useState, useMemo, useRef, useEffect } from 'react';
import {
  Table, Typography, Badge, Tag, Button, Input, Select, Space,
  Empty, Modal, notification, Progress, Tooltip, Alert,
} from 'antd';
import {
  SearchOutlined, FilterOutlined, ClockCircleOutlined, PlusCircleOutlined,
  DesktopOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { type Executor } from '../api/executors';
import { useExecutorsList, useExecutorGroups } from '../api/queries';
import { client } from '../api/client';
import { useAuthStore } from '../store/auth';
import PageHeader from '../components/PageHeader';
import StateError from '../components/StateError';
// UI-07：视图切换 / 分组聚合条 / 卡片视图 / 批量操作条 / 实时状态
import ViewToggle, { readViewMode, writeViewMode, type ExecutorViewMode } from '../components/executor/ViewToggle';
import GroupFilterBar from '../components/executor/GroupFilterBar';
import ExecutorCardGrid from '../components/executor/ExecutorCardGrid';
import BatchActionBar from '../components/executor/BatchActionBar';
import { useExecutorLive } from '../hooks/useExecutorLive';
// UI-10：导入 i18n 实例（模块副作用完成初始化；树内用 useTranslation 读 key）
import '../i18n';

type TFunc = (k: string, opts?: Record<string, unknown>) => string;
function heartbeatLabel(t: TFunc, lastHeartbeat: string): { text: string; color: string } {
  const diffMs = Date.now() - new Date(lastHeartbeat).getTime();
  const diffMin = diffMs / 60000;
  if (diffMin < 2) return { color: '#52c41a', text: t('execList.hb.justNow') };
  if (diffMin < 10) return { color: '#faad14', text: t('execList.hb.minAgo', { min: Math.floor(diffMin) }) };
  return { color: '#ff4d4f', text: new Date(lastHeartbeat).toLocaleString('zh-CN') };
}

export default function ExecutorListPage() {
  const { t } = useTranslation();
  const prevStatusMap = useRef<Record<string, string>>({});
  const isFirstLoad = useRef(true);
  const [notifApi, notifContextHolder] = notification.useNotification();

  // FEAT-17: TanStack Query 改造——useRequest(30s 轮询) 换 useExecutorsList
  // （refetchInterval 承担轮询节奏；状态翻转通知改由 useEffect 监听数据变化，
  // 语义与原 onSuccess 回调一致：首轮建基线不通知，之后翻转才弹）。
  const { data, isLoading: loading, error, refetch } = useExecutorsList();

  useEffect(() => {
    if (!data) return;
    const executors = data;
    if (isFirstLoad.current) {
      executors.forEach((ex) => { prevStatusMap.current[ex.id] = ex.status; });
      isFirstLoad.current = false;
      return;
    }
    executors.forEach((ex) => {
      const prev = prevStatusMap.current[ex.id];
      if (prev !== undefined && prev !== ex.status) {
        if (ex.status === 'online') {
          notifApi.success({
            message: t('execList.notify.online', { name: ex.appName }),
            description: t('execList.notify.onlineDesc', { address: ex.address }),
            placement: 'topRight', duration: 6,
          });
        } else if (ex.status === 'offline') {
          notifApi.warning({
            message: t('execList.notify.offline', { name: ex.appName }),
            description: t('execList.notify.offlineDesc', { address: ex.address }),
            placement: 'topRight', duration: 0,
          });
        }
      }
      prevStatusMap.current[ex.id] = ex.status;
    });
  }, [data, notifApi]);

  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  // R5 RBAC：install-cmd / executor-shared-token 为 ADMIN-only，普通用户隐藏入口
  const isAdmin = user?.role === 'admin';
  const [searchText, setSearchText] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [groupFilter, setGroupFilter] = useState<string | undefined>();
  const [installCmdModal, setInstallCmdModal] = useState(false);
  // UI-07 ①：卡片/表格双视图（localStorage 记忆，读失败回退表格）
  const [viewMode, setViewMode] = useState<ExecutorViewMode>(() => readViewMode(typeof localStorage !== 'undefined' ? localStorage : undefined));
  // UI-07 ③：批量选择（两视图共享选中集合）
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);

  const { data: groups } = useExecutorGroups();
  const [installCmd, setInstallCmd] = useState<{ cmd: string } | null>(null);

  const fetchInstallCmd = async () => {
    try {
      const res = await client.get<{ cmd: string }>('/executors/install-cmd');
      setInstallCmd(res);
      setInstallCmdModal(true);
    } catch {
      Modal.error({ title: t('execList.installCmdFail.title'), content: t('execList.installCmdFail.content') });
    }
  };

  // 稳定引用：data 未变时 executors 身份不变，避免下游 useMemo 每渲染失效
  const polledExecutors: Executor[] = useMemo(() => data ?? [], [data]);

  // UI-07 ④：/metrics/stream executors 段覆盖（状态/CPU/内存/任务数 3s 实时；
  // 断线时覆盖层回退轮询快照——list 接口仍是数据源，SSE 只做覆盖加速）
  const { executors, isLive } = useExecutorLive(polledExecutors);

  const hasLongOffline = useMemo(() => executors.some((e) => {
    if (e.status !== 'offline') return false;
    if (!e.lastHeartbeat) return true;
    return Date.now() - new Date(e.lastHeartbeat).getTime() > 5 * 60 * 1000;
  }), [executors]);

  const filtered = useMemo(() => executors.filter((ex) => {
    const matchSearch = !searchText ||
      ex.appName.toLowerCase().includes(searchText.toLowerCase()) ||
      ex.address.toLowerCase().includes(searchText.toLowerCase()) ||
      (ex.groupName?.toLowerCase().includes(searchText.toLowerCase()) ?? false);
    return matchSearch &&
      (!statusFilter || ex.status === statusFilter) &&
      (!groupFilter || ex.groupName === groupFilter);
  }), [executors, searchText, statusFilter, groupFilter]);

  const hasFilters = !!(searchText || statusFilter || groupFilter);
  const onlineCount = executors.filter(e => e.status === 'online').length;

  // UI-07 ③：选中执行器实体（批量操作条需要 status/appName/address）
  const selectedExecutors = useMemo(
    () => executors.filter((ex) => selectedRowKeys.includes(ex.id)),
    [executors, selectedRowKeys],
  );
  const toggleSelect = (id: string, checked: boolean) => {
    setSelectedRowKeys((prev) => (checked ? [...prev, id] : prev.filter((k) => k !== id)));
  };

  const handleViewChange = (mode: ExecutorViewMode) => {
    setViewMode(mode);
    writeViewMode(typeof localStorage !== 'undefined' ? localStorage : undefined, mode);
  };

  const columns = [
    {
      title: t('execList.col.executor'),
      key: 'nameAddress',
      sorter: (a: Executor, b: Executor) => a.appName.localeCompare(b.appName),
      render: (_: unknown, r: Executor) => (
        <Space orientation="vertical" size={0}>
          <Space>
            <DesktopOutlined style={{ color: r.status === 'online' ? '#52c41a' : '#d9d9d9' }} />
            <Typography.Text strong>{r.appName}</Typography.Text>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.address}</Typography.Text>
        </Space>
      ),
    },
    {
      title: t('execList.col.status'),
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (v: string, r: Executor) => (
        <Space orientation="vertical" size={0}>
          <Badge
            status={v === 'online' ? 'success' : v === 'busy' ? 'warning' : 'default'}
            text={v === 'online' ? t('execList.status.online') : v === 'busy' ? t('execList.status.busy') : t('execList.status.offline')}
          />
          {/* U16: 死信积压仅 >0 时高亮（null=旧版未上报、0=无积压均不打扰，
              三态细分见详情页活性上报区） */}
          {r.deadLetterCount != null && r.deadLetterCount > 0 && (
            <Tooltip title={t('execList.deadLetterTooltip')}>
              <Tag color="orange" style={{ marginInlineEnd: 0 }}>{t('execList.deadLetter', { count: r.deadLetterCount })}</Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: t('execList.col.groupTags'),
      key: 'groupTags',
      responsive: ['md'] as import('antd/es/_util/responsiveObserver').Breakpoint[],
      render: (_: unknown, r: Executor) => (
        <Space size={4} wrap>
          {r.groupName && <Tag color="geekblue">{r.groupName}</Tag>}
          {r.tags?.map(t2 => <Tag key={t2}>{t2}</Tag>)}
          {!r.groupName && !r.tags?.length && <Typography.Text type="secondary">-</Typography.Text>}
        </Space>
      ),
    },
    {
      title: t('execList.col.resources'),
      key: 'resources',
      width: 160,
      responsive: ['lg'] as import('antd/es/_util/responsiveObserver').Breakpoint[],
      render: (_: unknown, r: Executor) => (
        <Space orientation="vertical" size={2}>
          {([t('execList.res.cpu'), t('execList.res.mem'), t('execList.res.disk')] as const).map((label, idx) => {
            const isDisk = idx === 2;
            const val = idx === 0 ? (r.cpuUsage ?? 0)
              : idx === 1 ? (r.memUsage ?? 0)
              : (r.diskUsage ?? 0);
            if (isDisk && !r.diskUsage) return null;
            return (
              <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <Typography.Text style={{ fontSize: 11, width: 28 }}>{label}</Typography.Text>
                <Progress
                  percent={val}
                  size="small" showInfo={false}
                  strokeColor={val > 80 ? '#ff4d4f' : val > 60 ? '#fa8c16' : '#52c41a'}
                  style={{ width: 56, margin: 0 }}
                />
                <Typography.Text style={{ fontSize: 11 }}>{val.toFixed(0)}%</Typography.Text>
              </div>
            );
          })}
        </Space>
      ),
    },
    {
      title: t('execList.col.tasks'),
      key: 'runningTaskCount',
      width: 80,
      render: (_: unknown, r: Executor) => {
        const running = r.runningTaskCount ?? 0;
        const max = r.maxConcurrentTasks;
        const label = max != null ? t('execList.tasks.both', { running, max }) : t('execList.tasks.only', { running });
        return (
          <Typography.Text strong style={{ color: running > 0 ? '#1677ff' : undefined }}>
            {label}
          </Typography.Text>
        );
      },
    },
    {
      title: t('execList.col.heartbeat'),
      dataIndex: 'lastHeartbeat',
      key: 'lastHeartbeat',
      width: 120,
      render: (v: string) => {
        if (!v) return '-';
        const hb = heartbeatLabel(t, v);
        return (
          <Tooltip title={new Date(v).toLocaleString('zh-CN')}>
            <Space size={4}>
              <ClockCircleOutlined style={{ color: hb.color }} />
              <Typography.Text style={{ color: hb.color, fontSize: 12 }}>{hb.text}</Typography.Text>
            </Space>
          </Tooltip>
        );
      },
    },
    {
      title: t('execList.col.action'),
      key: 'action',
      width: 70,
      render: (_: unknown, r: Executor) => (
        <Button type="link" size="small" onClick={() => navigate(`/executors/${r.id}`)}>{t('execList.action.detail')}</Button>
      ),
    },
  ];

  return (
    <div>
      {notifContextHolder}
      {hasLongOffline && (
        <Alert
          type="warning"
          showIcon
          title={t('execList.online.alert')}
          style={{ marginBottom: 16 }}
          closable
        />
      )}
      {/* UI-03：页头标准化（原 Typography.Title 区块迁入 PageHeader，安装向导/快速添加进 extra） */}
      <PageHeader
        title={t('execList.title')}
        description={<>{t('execList.onlineSummary', { online: onlineCount, total: executors.length })}</>}
        extra={
          <Space wrap>
            {/* UI-07 ④：SSE 连接状态点（live=实时，connecting/reconnecting=30s 轮询兜底） */}
            <Tooltip
              title={isLive ? t('execList.liveTooltip') : t('execList.pollTooltip')}
            >
              <Badge
                status={isLive ? 'processing' : 'warning'}
                text={<Typography.Text type="secondary" style={{ fontSize: 12 }}>{isLive ? t('execList.live') : t('execList.poll')}</Typography.Text>}
              />
            </Tooltip>
            <ViewToggle value={viewMode} onChange={handleViewChange} />
            {isAdmin && <Button onClick={() => navigate('/executors/install')}>{t('execList.installWizard')}</Button>}
            {isAdmin && (
              <Button icon={<PlusCircleOutlined />} type="primary" onClick={fetchInstallCmd}>
                {t('execList.quickAdd')}
              </Button>
            )}
          </Space>
        }
      />

      <Space style={{ marginBottom: 16 }} wrap>
        <Input
          placeholder={t('execList.searchPlaceholder')}
          prefix={<SearchOutlined />}
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          allowClear style={{ width: 220 }}
        />
        <Select
          placeholder={t('execList.statusAll')}
          allowClear style={{ width: 120 }}
          value={statusFilter}
          onChange={(v) => setStatusFilter(v)}
          suffixIcon={<FilterOutlined />}
          options={[
            { value: 'online', label: t('execList.status.online') },
            { value: 'offline', label: t('execList.status.offline') },
            { value: 'busy', label: t('execList.status.busy') },
          ]}
        />
        {(groups ?? []).length > 0 && (
          <Select
            placeholder={t('execList.groupAll')}
            allowClear style={{ width: 130 }}
            value={groupFilter}
            onChange={(v) => setGroupFilter(v)}
            suffixIcon={<FilterOutlined />}
            options={(groups ?? []).map(g => ({ value: g, label: g }))}
          />
        )}
        {hasFilters && (
          <Button size="small" onClick={() => { setSearchText(''); setStatusFilter(undefined); setGroupFilter(undefined); }}>{t('execList.clearFilters')}</Button>
        )}
        {hasFilters && (
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            {t('execList.count', { filtered: filtered.length, total: executors.length })}
          </Typography.Text>
        )}
      </Space>

      {/* UI-07 ②：分组聚合条（点击等价 groupFilter；全部执行器均无分组时整条隐藏） */}
      <GroupFilterBar executors={executors} value={groupFilter} onChange={setGroupFilter} />

      {/* UI-07 ③：批量操作条（ADMIN-only；两视图共享选中集合） */}
      <BatchActionBar
        selected={selectedExecutors}
        isAdmin={isAdmin}
        onDone={() => setSelectedRowKeys([])}
      />

      {/* UI-16：列表请求失败不再只弹 toast —— 页内原位呈现错误块 + 重试入口
          （安装命令等写操作失败仍走 Modal.error，语义不变）。错误块与两种视图
          并列，不塞进三元分支（三元每支只能有一个根元素）。 */}
      {error ? (
        <StateError
          error={error}
          title={t('execList.error.title')}
          onRetry={() => void refetch()}
          style={{ marginBottom: 16 }}
        />
      ) : null}

      {viewMode === 'card' ? (
        <ExecutorCardGrid
          executors={filtered}
          selectedIds={selectedRowKeys}
          onToggleSelect={toggleSelect}
          onOpenDetail={(id) => navigate(`/executors/${id}`)}
          isAdmin={isAdmin}
          onReloadConfig={(ex) => setSelectedRowKeys([ex.id])}
          onRotateToken={(ex) => setSelectedRowKeys([ex.id])}
        />
      ) : (
        <Table
          rowKey="id"
          columns={columns}
          dataSource={filtered}
          loading={loading}
          // UI-07 ③：表格多选（ADMIN 门控在操作条——非 admin 无操作条，
          // 选中集合为空集，多选列对普通用户仅是筛选辅助，不暴露写入口）
          rowSelection={{ selectedRowKeys, onChange: (keys) => setSelectedRowKeys(keys as string[]) }}
          pagination={{ pageSize: 20, showTotal: (t2) => t('execList.table.count', { count: t2 }) }}
          locale={{
            emptyText: hasFilters ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('execList.empty.noMatch')}>
                <Button type="link" size="small" onClick={() => { setSearchText(''); setStatusFilter(undefined); }}>
                  {t('execList.clearFilters')}
                </Button>
              </Empty>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('execList.empty.none')}>
                {isAdmin && (
                  <Button type="primary" onClick={() => navigate('/executors/install')}>{t('execList.empty.installFirst')}</Button>
                )}
              </Empty>
            ),
          }}
        />
      )}

      <Modal
        title={t('execList.quickAdd.title')}
        open={installCmdModal}
        onCancel={() => setInstallCmdModal(false)}
        footer={<Button onClick={() => setInstallCmdModal(false)}>{t('execList.close')}</Button>}
        width={640}
      >
        {installCmd && (
          <Space orientation="vertical" style={{ width: '100%' }} size={16}>
            <div>
              <Typography.Text strong>{t('execList.installRun')}</Typography.Text>
              <Typography.Paragraph
                code copyable={{ text: installCmd.cmd }}
                style={{ marginTop: 8, padding: '8px 12px', background: '#f5f5f5', borderRadius: 6 }}
              >
                {installCmd.cmd}
              </Typography.Paragraph>
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('execList.installHint')}
            </Typography.Text>
          </Space>
        )}
      </Modal>
    </div>
  );
}
