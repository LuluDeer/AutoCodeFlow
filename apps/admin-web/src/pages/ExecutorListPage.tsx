import { useState, useMemo, useRef, useEffect } from 'react';
import {
  Table, Typography, Badge, Tag, Button, Input, Select, Space,
  Empty, Modal, notification, Progress, Tooltip, Alert, theme,
} from 'antd';
// MODAL-01：命令式 Modal.* 从 utils/modal 取（吃暗色主题 + i18n locale）；<Modal> JSX 仍用 antd。
import { Modal as confirmModal } from '../utils/modal';
import {
  SearchOutlined, FilterOutlined, ClockCircleOutlined, PlusCircleOutlined,
  DesktopOutlined,

} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { type Executor } from '../api/executors';
import { useExecutorsList, useExecutorGroups, useExecutorRuntimeConfig } from '../api/queries';
// MOBILE-CARD-01：≤768px 强制卡片视图（表格在 375px 不可用，见组件注释）
import { useIsMobile } from '../hooks/useIsMobile';
import { client } from '../api/client';
// F-26（DEEP_REVIEW 0ef3bbe）：locale 单一来源，不再硬编码 zh-CN
import { currentLocale } from '../utils/locale';
import { useAuthStore } from '../store/auth';
import PageHeader from '../components/PageHeader';
import StateError from '../components/StateError';
// UI-07：视图切换 / 分组聚合条 / 卡片视图 / 批量操作条 / 实时状态
import ViewToggle, { readViewMode, writeViewMode, type ExecutorViewMode } from '../components/executor/ViewToggle';
import GroupFilterBar from '../components/executor/GroupFilterBar';
import ExecutorCardGrid from '../components/executor/ExecutorCardGrid';
import BatchActionBar from '../components/executor/BatchActionBar';
import { useExecutorLive } from '../hooks/useExecutorLive';
// P2-5：心跳三档着色与"长期离线"横幅阈值的共享口径（与后端判死同源）
import {
  HEARTBEAT_TIMEOUT_FALLBACK_MS,
  LONG_OFFLINE_BANNER_MS,
  heartbeatFreshness,
} from '../utils/executorLiveness';
// UI-10：导入 i18n 实例（模块副作用完成初始化；树内用 useTranslation 读 key）
import '../i18n';

type TFunc = (k: string, opts?: Record<string, unknown>) => string;
// F-15（DEEP_REVIEW 0ef3bbe）：心跳语义色走 antd token（双主题自适应）。
type AntdToken = ReturnType<typeof theme.useToken>['token'];
function heartbeatLabel(
  t: TFunc,
  lastHeartbeat: string,
  token: AntdToken,
  staleTimeoutMs: number,
): { text: string; color: string } {
  const diffMs = Date.now() - new Date(lastHeartbeat).getTime();
  // P2-5：三档边界与卡片视图（ExecutorCardGrid）共用同一判据，避免同一份数据
  // 在列表视图与卡片视图里给出不同颜色。
  const freshness = heartbeatFreshness(diffMs, staleTimeoutMs);
  if (freshness === 'fresh') return { color: token.colorSuccess, text: t('execList.hb.justNow') };
  if (freshness === 'recent') {
    return { color: token.colorWarning, text: t('execList.hb.minAgo', { min: Math.floor(diffMs / 60000) }) };
  }
  return { color: token.colorError, text: new Date(lastHeartbeat).toLocaleString(currentLocale()) };
}

export default function ExecutorListPage() {
  const { t } = useTranslation();
  // F-15（DEEP_REVIEW 0ef3bbe）：语义色/填充走 antd token，暗色主题自适应。
  const { token } = theme.useToken();
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
  // MOBILE-CARD-01：移动端强制卡片视图——375px 下 9 列表格横向滚动不可用；
  // 桌面端仍尊重 localStorage 记忆的用户选择。
  const isMobile = useIsMobile();
  const effectiveViewMode: ExecutorViewMode = isMobile ? 'card' : viewMode;
  // UI-07 ③：批量选择（两视图共享选中集合）
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);

  // P3-11（executor lifecycle audit）：分组拉取失败不再让筛选器「静默消失」
  // ——旧实现只解构 data，错误时整个 Select 被移除且无任何提示。错误态原位
  // 给出重试入口。
  const { data: groups, error: groupsError, refetch: refetchGroups, isFetching: groupsFetching } = useExecutorGroups();
  const [installCmd, setInstallCmd] = useState<{ cmd: string } | null>(null);

  const fetchInstallCmd = async () => {
    try {
      const res = await client.get<{ cmd: string }>('/executors/install-cmd');
      setInstallCmd(res);
      setInstallCmdModal(true);
    } catch {
      confirmModal.error({ title: t('execList.installCmdFail.title'), content: t('execList.installCmdFail.content') });
    }
  };

  // 稳定引用：data 未变时 executors 身份不变，避免下游 useMemo 每渲染失效
  const polledExecutors: Executor[] = useMemo(() => data ?? [], [data]);

  // UI-07 ④：/metrics/stream executors 段覆盖（状态/CPU/内存/任务数 3s 实时；
  // 断线时覆盖层回退轮询快照——list 接口仍是数据源，SSE 只做覆盖加速）
  const { executors, isLive } = useExecutorLive(polledExecutors);

  // P2-5：心跳着色与"长期离线"横幅都改用**后端有效判死阈值**（runtime-config）。
  // 后端 markStaleOffline() 用 heartbeatInterval × multiplier（默认 90s）判死，
  // 而本页此前硬编码 2 分钟/5 分钟，于是后端判死后最长约 3.5 分钟里 UI 仍把
  // 心跳画成绿色「刚刚」。取不到该端点时回退后端默认值（保守方向：只会提前
  // 标黄，绝不把真正离线的节点涂绿）。
  const { data: runtimeConfig } = useExecutorRuntimeConfig();
  const heartbeatTimeoutMs =
    runtimeConfig?.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_FALLBACK_MS;
  // P3-9：GET /executors 硬上限 listLimit 行；全量超过它时，计数/搜索/
  // SSE 覆盖层都只描述子集——必须显式告知，不能把子集说成全量。
  const listTruncated = !!runtimeConfig && runtimeConfig.executorTotal > runtimeConfig.listLimit;

  const hasLongOffline = useMemo(() => executors.some((e) => {
    if (e.status !== 'offline') return false;
    if (!e.lastHeartbeat) return true;
    // 横幅阈值刻意独立于判死阈值（LONG_OFFLINE_BANNER_MS）：它表达的是
    // "值得提醒运维"的产品语义，不是"后端何时判死"。
    return Date.now() - new Date(e.lastHeartbeat).getTime() > LONG_OFFLINE_BANNER_MS;
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
        // UI 打磨：名称/地址单行 ellipsis——此前长地址整列换行，行高忽高忽低
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <DesktopOutlined style={{ color: r.status === 'online' ? token.colorSuccess : token.colorBorder, flex: '0 0 auto' }} />
            <Typography.Text strong ellipsis={{ tooltip: r.appName }} style={{ minWidth: 0 }}>
              {r.appName}
            </Typography.Text>
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }} ellipsis={{ tooltip: r.address }}>
            {r.address}
          </Typography.Text>
        </div>
      ),
    },
    {
      title: t('execList.col.status'),
      dataIndex: 'status',
      key: 'status',
      // UI 打磨：90 内「版本漂移」等 4 字 Tag 逼近换行，行高抖动 → 110
      width: 110,
      render: (v: string, r: Executor) => (
        <Space orientation="vertical" size={0}>
          {/* 状态只有 online / offline 两态（executor.entity.ts:15-16）——原实现
              还判了一个 `busy` 分支，那是**永不可达**的死代码（admin 与
              executor-node/python 全仓无该取值），删掉以免下一位读者以为存在
              第三态。未知取值按 offline 渲染是刻意的保守选择：宁可把新状态
              显示成离线（有人来报），也不要显示成在线（把不可用藏起来）。 */}
          <Badge
            status={v === 'online' ? 'success' : 'default'}
            text={v === 'online' ? t('execList.status.online') : t('execList.status.offline')}
          />
          {/* U16: 死信积压仅 >0 时高亮（null=旧版未上报、0=无积压均不打扰，
              三态细分见详情页活性上报区） */}
          {r.deadLetterCount != null && r.deadLetterCount > 0 && (
            <Tooltip title={t('execList.deadLetterTooltip')}>
              <Tag color="orange" style={{ marginInlineEnd: 0 }}>{t('execList.deadLetter', { count: r.deadLetterCount })}</Tag>
            </Tooltip>
          )}
          {/* UI-17: pull 模式徽标（默认 push 不渲染防噪，U16 死信同款纪律） */}
          {r.dispatchMode === 'pull' && (
            <Tooltip title={t('execList.pullModeTooltip')}>
              <Tag color="purple" style={{ marginInlineEnd: 0 }}>{t('execList.pullMode')}</Tag>
            </Tooltip>
          )}
          {/* UI-17: 版本合规态（EXE-VER-1 门禁读面投影，true/undefined 不渲染） */}
          {r.versionCompliant === false && (
            <Tooltip title={t('execList.versionDriftTooltip')}>
              <Tag color="volcano" style={{ marginInlineEnd: 0 }}>{t('execList.versionDrift')}</Tag>
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
            // DISK-PLACEHOLDER-01：磁盘未上报时显示「未上报」占位而非整行消失——
            // 列头写着 CPU/内存/磁盘，磁盘行静默蒸发既像 bug 又让人误以为 0%
            const unreported = isDisk && r.diskUsage == null;
            const val = idx === 0 ? (r.cpuUsage ?? 0)
              : idx === 1 ? (r.memUsage ?? 0)
              : (r.diskUsage ?? 0);
            if (unreported) {
              return (
                <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Typography.Text style={{ fontSize: 11, width: 28 }}>{label}</Typography.Text>
                  <Tooltip title={t('execList.res.diskUnreported')}>
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      {t('execList.res.diskUnreported')}
                    </Typography.Text>
                  </Tooltip>
                </div>
              );
            }
            return (
              <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <Typography.Text style={{ fontSize: 11, width: 28 }}>{label}</Typography.Text>
                <Progress
                  percent={val}
                  size="small" showInfo={false}
                  strokeColor={val > 80 ? token.colorError : val > 60 ? token.colorWarning : token.colorSuccess}
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
      // TASKS-NOWRAP-01：100px——80px 会把「1/10任务」折成竖排三行
      width: 100,
      render: (_: unknown, r: Executor) => {
        const running = r.runningTaskCount ?? 0;
        const max = r.maxConcurrentTasks;
        const label = max != null ? t('execList.tasks.both', { running, max }) : t('execList.tasks.only', { running });
        return (
          <Typography.Text strong style={{ color: running > 0 ? token.colorPrimary : undefined, whiteSpace: 'nowrap' }}>
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
        const hb = heartbeatLabel(t, v, token, heartbeatTimeoutMs);
        return (
          <Tooltip title={new Date(v).toLocaleString(currentLocale())}>
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
      fixed: 'right' as const,
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
      {/* P3-9（executor lifecycle audit）：列表硬上限截断提示——total/limit
          来自 GET /executors/runtime-config，避免把前 500 行的子集说成全量。 */}
      {listTruncated && (
        <Alert
          type="info"
          showIcon
          title={t('execList.truncated', {
            limit: runtimeConfig?.listLimit,
            total: runtimeConfig?.executorTotal,
          })}
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
            {/* MOBILE-CARD-01：移动端恒卡片，视图切换无意义故隐藏 */}
            {!isMobile && <ViewToggle value={viewMode} onChange={handleViewChange} />}
            {/* P2-8（UX-AUDIT）：「安装向导」与「快速添加」两套入口此前无差别说明——
                一个是引导式（检测 OS/配网络模式/验证连接），一个是只吐一行命令自行执行。
                用 Tooltip 一句话区分，避免用户在两条路之间凭直觉选错。 */}
            {isAdmin && (
              <Tooltip title={t('execList.installWizard.tip')}>
                <Button onClick={() => navigate('/executors/install')}>{t('execList.installWizard')}</Button>
              </Tooltip>
            )}
            {isAdmin && (
              <Tooltip title={t('execList.quickAdd.tip')}>
                <Button icon={<PlusCircleOutlined />} type="primary" onClick={fetchInstallCmd}>
                  {t('execList.quickAdd')}
                </Button>
              </Tooltip>
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
          allowClear style={{ width: 220, maxWidth: '100%' }}
        />
        <Select
          placeholder={t('execList.statusAll')}
          allowClear style={{ width: 120, maxWidth: '100%' }}
          value={statusFilter}
          onChange={(v) => setStatusFilter(v)}
          suffixIcon={<FilterOutlined />}
          options={[
            { value: 'online', label: t('execList.status.online') },
            { value: 'offline', label: t('execList.status.offline') },
            // 此前这里还有一个 `busy` 选项，但它是**死选项**：admin 的
            // ExecutorStatus 枚举只有 ONLINE/OFFLINE 两个值
            // （executor.entity.ts:15-16），"忙碌"是用 runningTaskCount /
            // maxConcurrentTasks 表达的，从来不是一个状态值。选中它永远筛出
            // 空列表，用户会以为"没有执行器在忙"而不是"这个筛选没有意义"。
          ]}
        />
        {/* P3-11（executor lifecycle audit）：分组拉取失败时筛选器不再静默
            消失——原位给出可重试的错误入口，避免用户误以为执行器都没有分组。 */}
        {groupsError ? (
          <Tooltip title={t('execList.groupLoadErrorTip')}>
            <Button
              danger
              icon={<FilterOutlined />}
              loading={groupsFetching}
              onClick={() => void refetchGroups()}
            >
              {t('execList.groupLoadError')}
            </Button>
          </Tooltip>
        ) : (groups ?? []).length > 0 && (
          <Select
            placeholder={t('execList.groupAll')}
            allowClear style={{ width: 130, maxWidth: '100%' }}
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

      {effectiveViewMode === 'card' ? (
        <ExecutorCardGrid
          executors={filtered}
          selectedIds={selectedRowKeys}
          onToggleSelect={toggleSelect}
          onOpenDetail={(id) => navigate(`/executors/${id}`)}
          isAdmin={isAdmin}
          onReloadConfig={(ex) => setSelectedRowKeys([ex.id])}
          onRotateToken={(ex) => setSelectedRowKeys([ex.id])}
          staleTimeoutMs={heartbeatTimeoutMs}
        />
      ) : (
        <Table
          rowKey="id"
          columns={columns}
          dataSource={filtered}
          loading={loading}
          // UI 打磨：补齐 scroll.x（固定列合计 940 含弹性列最小宽；此前窄容器下
          // 名称列被挤碎、分组标签列抢宽）
          scroll={{ x: 940 }}
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
                style={{ marginTop: 8, padding: '8px 12px', background: token.colorFillQuaternary, borderRadius: 6 }}
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
