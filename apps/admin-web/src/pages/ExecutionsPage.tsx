import { useState, useEffect } from 'react';
import { Table,
  Typography,
  Badge,
  Button,
  Input,
  Select,
  Space,
  Empty,
  Tooltip,
  Popconfirm,
  DatePicker,
  Card } from 'antd';
import { message } from '../utils/toast';
import {
  SearchOutlined, FilterOutlined, ReloadOutlined, EyeOutlined, StopOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import type { Dayjs } from 'dayjs';

import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { tasksApi } from '../api/tasks';
import type { TaskExecution } from '../api/tasks';
import { useExecutionsList, invalidateExecutionData } from '../api/queries';
import { useExecutionsStream } from '../hooks/useExecutionsStream';
import { getErrMsg } from '../utils/error';
import { useDebounce } from '../hooks/useDebounce';
import { formatDateTime, formatDuration, formatRelativeTime } from '../utils/timeFormat';
import { ExecutionCompareModal, COMPARE_MAX } from '../components/ExecutionCompare';
import PageHeader from '../components/PageHeader';
import StateError from '../components/StateError';
// MOBILE-CARD-01：≤768px 时表格 → 卡片列表（结构级降级，CSS 做不到）
import { useIsMobile } from '../hooks/useIsMobile';
// P1-17（UX 审计）：触发方式列此前直接输出后端裸 token（cron/manual/fixed_rate），
// 与同列相邻的中文状态 Badge 中英混排。收敛到 utils/trigger-label 唯一事实源，
// 与 TaskListPage/TaskDetailPage/ApplicationDetailPage 同一份映射。
import { triggerLabel } from '../utils/trigger-label';
// UI-10：导入 i18n 实例（模块副作用完成初始化；树内用 useTranslation 读 key）
import '../i18n';

const { Text } = Typography;
const { RangePicker } = DatePicker;

type BadgeStatus = 'success' | 'processing' | 'error' | 'default' | 'warning';
const STATUS_MAP = (t: (k: string) => string): Record<string, { badge: BadgeStatus; label: string }> => ({
  pending:   { badge: 'default',    label: t('execs.status.pending') },
  running:   { badge: 'processing', label: t('execs.status.running') },
  success:   { badge: 'success',    label: t('execs.status.success') },
  failed:    { badge: 'error',      label: t('execs.status.failed') },
  timeout:   { badge: 'warning',    label: t('execs.status.timeout') },
  killed:    { badge: 'error',      label: t('execs.status.killed') },
  cancelled: { badge: 'default',    label: t('execs.status.cancelled') },
});

export default function ExecutionsPage() {
  const nav = useNavigate();
  const { t } = useTranslation();
  // MOBILE-CARD-01：≤768px 表格 → 卡片列表
  const isMobile = useIsMobile();
  // ARCH-26: 写后失效句柄（kill 后 invalidate 执行列表+Dashboard 汇总缓存）
  const queryClient = useQueryClient();
  // URL-SYNC-01：筛选/分页状态以 URL 查询参数为初始源并回写——修复两处体验缺口：
  // ① Dashboard「失败 Top 任务 → 全部失败」链到 /executions?status=failed，
  //    此前页面从不读 URL 参数，深链被静默丢弃；
  // ② 刷新/分享页面后筛选与页码全部丢失。
  // 时间范围不在 URL（Dayjs 序列化噪音大、深链价值低），仍仅存会话内。
  const [searchParams, setSearchParams] = useSearchParams();
  const [page, setPage] = useState(() => {
    const p = Number(searchParams.get('page'));
    return Number.isInteger(p) && p > 0 ? p : 1;
  });
  const [pageSize, setPageSize] = useState(() => {
    const ps = Number(searchParams.get('pageSize'));
    return Number.isInteger(ps) && ps > 0 ? ps : 20;
  });
  const [statusFilter, setStatusFilter] = useState<string | undefined>(() => searchParams.get('status') || undefined);
  const [search, setSearch] = useState(() => searchParams.get('q') || '');
  const [executorFilter, setExecutorFilter] = useState(() => searchParams.get('executor') || '');
  const [timeRange, setTimeRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [killingId, setKillingId] = useState<string | null>(null);
  // FEAT-03: 多选对比——选中本页行后一键打开指标对比 modal
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);

  // 翻页/筛选变化后当前页数据会变，跨页选中行不再可见——清空选中防误比
  useEffect(() => {
    setSelectedIds([]);
  }, [page, pageSize, statusFilter, search, executorFilter, timeRange]);

  const handleKill = async (r: TaskExecution) => {
    setKillingId(r.id);
    try {
      await tasksApi.killExecution(r.taskId, r.id);
      message.success(t('execs.kill.success'));
      // ARCH-26: 写后失效——执行列表 + Dashboard 汇总面（queryKey 前缀化，
      // 一处 invalidate 同时刷新两个示范页的缓存）。
      await invalidateExecutionData(queryClient);
    } catch (err: unknown) {
      message.error(getErrMsg(err, t('execs.kill.fail')));
    } finally {
      setKillingId(null);
    }
  };

  // 搜索防抖：避免每击键发一次列表请求
  const debouncedSearch = useDebounce(search);

  // URL-SYNC-01：状态→URL 回写（replace 不制造历史记录）。空值不写入，
  // 保持深链 URL 干净；清空筛选后 URL 回到裸 /executions。
  useEffect(() => {
    const next = new URLSearchParams();
    if (page !== 1) next.set('page', String(page));
    if (pageSize !== 20) next.set('pageSize', String(pageSize));
    if (statusFilter) next.set('status', statusFilter);
    if (debouncedSearch) next.set('q', debouncedSearch);
    if (executorFilter) next.set('executor', executorFilter);
    setSearchParams(next, { replace: true });
  }, [page, pageSize, statusFilter, debouncedSearch, executorFilter, setSearchParams]);

  // ARCH-26: TanStack Query 改造——useRequest 轮询（15s）换 query hooks：
  // 筛选参数进 queryKey（参数变化自动重取，等价 refreshDeps）；
  // staleTime 全局 30s 兜底切页缓存。15s 轮询由下方 refetchInterval useEffect
  // 承担（可见性判定与原 pollingWhenHidden:false 一致）。
  const { data, isLoading: loading, error, refetch } = useExecutionsList({
    page,
    pageSize,
    status: statusFilter,
    taskName: debouncedSearch || undefined,
    executorAddress: executorFilter || undefined,
    startTime: timeRange?.[0]?.toISOString(),
    endTime: timeRange?.[1]?.toISOString(),
  });

  // FEAT-16: 执行终态推送流——SSE live 时终态事件即时 invalidate 列表+汇总
  // 缓存（<3s 刷新验收），断线时下方 15s 轮询兜底自动成为唯一新鲜度来源
  // （对齐 DashboardPage：SSE 推送与轮询互斥共存，staleTime 内 refetch 去重）。
  useExecutionsStream();

  // 15s 轮询兜底：运行中行需要及时看到终态（SSE 断线时的降级路径）。
  // 标签页不可见时跳过请求（定时器保留，回到前台后下一拍即恢复——
  // 等价 pollingWhenHidden:false）。
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refetch();
    }, 15_000);
    return () => clearInterval(timer);
  }, [refetch]);

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

  // UI-09：375px 可用性——关键列=任务/状态/开始时间/错误/操作（值班首查项），
  // 触发方式/执行器/耗时为次要列窄屏收起（CSS 侧 .ui09-hide-mobile 双保险）；
  // scroll.x 兜底横向滚动。onHeaderCell/onCell 挂类供媒体查询隐藏次要列。
  const hideOnMobile = {
    onHeaderCell: () => ({ className: 'ui09-hide-mobile' }),
    onCell: () => ({ className: 'ui09-hide-mobile' }),
  } as const;
  const statusMap = STATUS_MAP(t);
  const columns = [
    {
      title: t('execs.col.task'),
      dataIndex: 'taskName',
      render: (name: string, r: TaskExecution) => (
        // F-33（DEEP_REVIEW 0ef3bbe）：原 <a onClick> 无 href，改 <Link>（键盘可达 + 真实 href）
        // UI 打磨：长任务名单行 ellipsis，不再整列换行撑高行
        <Link
          to={`/tasks/${r.taskId}`}
          title={name || r.taskId}
          style={{ fontWeight: 500, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {name || r.taskId}
        </Link>
      ),
    },
    {
      title: t('execs.col.status'),
      dataIndex: 'status',
      width: 90,
      render: (s: string) => {
        const cfg = statusMap[s] || { badge: 'default' as BadgeStatus, label: s };
        return <Badge status={cfg.badge} text={cfg.label} />;
      },
    },
    {
      title: t('execs.col.trigger'),
      dataIndex: 'triggerType',
      width: 90,
      ...hideOnMobile,
      // P1-17：走唯一事实源 triggerLabel（已知值本地化、未知值回退原 token），
      // 不再直接渲染 {v || '-'} 裸枚举。
      render: (v: string) => {
        const label = triggerLabel(v, t);
        return <Text type="secondary" style={{ fontSize: 12 }}>{label || '-'}</Text>;
      },
    },
    {
      title: t('execs.col.executor'),
      dataIndex: 'executorAddress',
      width: 160,
      ellipsis: true,
      ...hideOnMobile,
      render: (v: string) => v
        ? <Tooltip title={v}><Text style={{ fontSize: 12 }}>{v}</Text></Tooltip>
        : <Text type="secondary" style={{ fontSize: 12 }}>-</Text>,
    },
    {
      title: t('execs.col.startTime'),
      dataIndex: 'startTime',
      width: 130,
      render: (v: string) => v ? (
        <Tooltip title={formatDateTime(v)}>
          <Text style={{ fontSize: 12 }}>{formatRelativeTime(v, t)}</Text>
        </Tooltip>
      ) : '-',
    },
    {
      title: t('execs.col.duration'),
      dataIndex: 'duration',
      width: 90,
      ...hideOnMobile,
      // UI-08：时长如「32分46秒」窄列会折成两行，nowrap 保证单行可扫读
      render: (v: number) => v != null ? <Text style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{formatDuration(v, t)}</Text> : '-',
    },
    {
      title: t('execs.col.error'),
      dataIndex: 'errorMessage',
      ellipsis: true,
      render: (v: string) => v ? <Text type="danger" style={{ fontSize: 12 }}>{v}</Text> : '-',
    },
    {
      title: t('execs.col.action'),
      key: 'action',
      // UI 打磨：详情 + 终止两个带文字链接实测 ~125px，100 宽在 running 行折行；
      // fixed right 让操作列在横向滚动时常驻
      width: 135,
      fixed: 'right' as const,
      render: (_: unknown, r: TaskExecution) => (
        <Space size={4}>
          <Button
            type="link" size="small" icon={<EyeOutlined />}
            onClick={() => nav(`/tasks/${r.taskId}/executions/${r.id}`)}
          >
            {t('execs.action.detail')}
          </Button>
          {r.status === 'running' && (
            <Popconfirm
              title={t('execs.killConfirm')}
              onConfirm={() => handleKill(r)}
              okText={t('execs.action.kill')} okButtonProps={{ danger: true }}
            >
              <Button
                type="link" size="small" danger
                icon={<StopOutlined />}
                loading={killingId === r.id}
              >
                {t('execs.action.kill')}
              </Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      {/* UI-03：页头标准化（原 Typography.Title 区块迁入 PageHeader，刷新进 extra） */}
      <PageHeader
        title={t('execs.title')}
        description={t('execs.description')}
        extra={<Button icon={<ReloadOutlined />} onClick={() => void refetch()}>{t('execs.refresh')}</Button>}
      />

      {/* UI-09：筛选区 wrap 堆叠（Space wrap 已有），输入/选择窄屏自适应宽度 */}
      <Space style={{ marginBottom: 16 }} wrap className="ui09-filter-bar">
        {selectedIds.length > 0 && (
          <Button
            icon={<SwapOutlined />}
            type="primary"
            disabled={selectedIds.length < 2}
            onClick={() => {
              if (selectedIds.length > COMPARE_MAX) {
                message.warning(t('execs.compare.limit', { max: COMPARE_MAX }));
                return;
              }
              setCompareOpen(true);
            }}
          >
            {t('execs.compare', { count: selectedIds.length })}
          </Button>
        )}
        <Input
          placeholder={t('execs.searchPlaceholder')}
          prefix={<SearchOutlined />}
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
          allowClear
          style={{ width: 200, maxWidth: '100%' }}
        />
        <Select
          placeholder={t('execs.statusAll')}
          allowClear
          style={{ width: 120, maxWidth: '100%' }}
          value={statusFilter}
          onChange={v => { setStatusFilter(v); setPage(1); }}
          suffixIcon={<FilterOutlined />}
          options={[
            { value: 'pending',   label: t('execs.status.pending') },
            { value: 'running',   label: t('execs.status.running') },
            { value: 'success',   label: t('execs.status.success') },
            { value: 'failed',    label: t('execs.status.failed') },
            { value: 'timeout',   label: t('execs.status.timeout') },
            { value: 'killed',    label: t('execs.status.killed') },
            { value: 'cancelled', label: t('execs.status.cancelled') },
          ]}
        />
        <Input
          placeholder={t('execs.executorPlaceholder')}
          value={executorFilter}
          onChange={e => { setExecutorFilter(e.target.value); setPage(1); }}
          allowClear
          style={{ width: 180, maxWidth: '100%' }}
        />
        <RangePicker
          showTime
          format="MM-DD HH:mm"
          placeholder={[t('execs.timeStart'), t('execs.timeEnd')]}
          value={timeRange}
          onChange={val => { setTimeRange(val as [Dayjs, Dayjs] | null); setPage(1); }}
          style={{ width: 320, maxWidth: '100%' }}
        />
        {hasFilters && (
          <Button size="small" onClick={clearFilters}>{t('execs.clearFilters')}</Button>
        )}
      </Space>

      {/* UI-16：列表请求失败不再只弹 toast —— 页内原位呈现错误块 + 重试入口
          （写操作失败仍走 toast，语义不变） */}
      {error ? (
        <StateError
          error={error}
          title={t('execs.error.title')}
          onRetry={() => void refetch()}
          style={{ marginBottom: 16 }}
        />
      ) : null}

      {isMobile ? (
        /* MOBILE-CARD-01：≤768px 卡片列表——此前 375px 下表格横向滚动，表头
           「任务名称」逐字竖排、操作列溢出。卡片按值班首查信息组织：状态 +
           任务名 / 触发·执行器 / 时间·耗时 / 错误 / 详情。 */
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {executions.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('execs.empty')} />
          ) : (
            executions.map((r) => {
              const cfg = statusMap[r.status] || { badge: 'default' as BadgeStatus, label: r.status };
              return (
                <Card key={r.id} size="small">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <Link to={`/tasks/${r.taskId}`} style={{ fontWeight: 500, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.taskName || r.taskId}
                    </Link>
                    <Badge status={cfg.badge} text={cfg.label} />
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12, color: 'var(--chart-axis-text)' }}>
                    {[triggerLabel(r.triggerType, t), r.executorAddress].filter(Boolean).join(' · ')}
                  </div>
                  <div style={{ marginTop: 4, fontSize: 12, color: 'var(--chart-axis-text)' }}>
                    {r.startTime ? `${formatRelativeTime(r.startTime, t)} · ${r.duration != null ? formatDuration(r.duration, t) : '-'}` : '-'}
                  </div>
                  {r.errorMessage && (
                    <Typography.Paragraph type="danger" style={{ marginTop: 6, marginBottom: 0, fontSize: 12 }} ellipsis={{ rows: 2, tooltip: r.errorMessage }}>
                      {r.errorMessage}
                    </Typography.Paragraph>
                  )}
                  <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 4 }}>
                    {r.status === 'running' && (
                      <Popconfirm
                        title={t('execs.killConfirm')}
                        onConfirm={() => handleKill(r)}
                        okText={t('execs.action.kill')} okButtonProps={{ danger: true }}
                      >
                        <Button size="small" danger icon={<StopOutlined />} loading={killingId === r.id}>
                          {t('execs.action.kill')}
                        </Button>
                      </Popconfirm>
                    )}
                    <Button size="small" icon={<EyeOutlined />} onClick={() => nav(`/tasks/${r.taskId}/executions/${r.id}`)}>
                      {t('execs.action.detail')}
                    </Button>
                  </div>
                </Card>
              );
            })
          )}
        </div>
      ) : (
      <Table
        rowKey="id"
        columns={columns}
        dataSource={executions}
        loading={loading}
        // UI-09：次要列窄屏收起（CSS 媒体查询 .ui09-hide-mobile）+ scroll.x 横向滚动兜底
        // UI 打磨：scroll.x 与列宽合计对齐（固定列 685 + 勾选 32 + 任务/错误两个弹性列
        // 最小各 ~160），原 640 < 合计，两个弹性列被压到勉强可读
        scroll={{ x: 1040 }}
        rowSelection={{
          selectedRowKeys: selectedIds,
          onChange: (keys) => setSelectedIds(keys as string[]),
        }}
        pagination={{
          total,
          current: page,
          pageSize,
          onChange: (p, ps) => { setPage(p); setPageSize(ps ?? 20); },
          showTotal: t2 => t('execs.count', { count: t2 }),
          showSizeChanger: true,
        }}
        locale={{
          emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('execs.empty')} />,
        }}
      />
      )}

      <ExecutionCompareModal
        open={compareOpen}
        onClose={() => setCompareOpen(false)}
        executions={executions}
        compareIds={selectedIds}
      />
    </div>
  );
}
