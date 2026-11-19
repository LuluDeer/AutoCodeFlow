import { useState, type ReactNode } from 'react';
import {
  Row, Col, Card, Statistic, Badge, Typography,
  Segmented, Progress, Tag, Space, Tooltip, Button, Alert,
} from 'antd';
import {
  CheckCircleOutlined, CloseCircleOutlined, ThunderboltOutlined,
  ClockCircleOutlined, RocketOutlined, ApiOutlined, ReloadOutlined,
  WarningOutlined, MinusCircleOutlined, ProjectOutlined, GlobalOutlined,
} from '@ant-design/icons';
import { useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip as RechartTooltip, Legend, ResponsiveContainer,
} from 'recharts';
import type { SchedulerMetricsResponse } from '../api/metrics';
import {
  useMetricsSummary,
  useMetricsTrend,
  useExecutorStats,
  useRecentFailures,
  useSchedulerMetrics,
  useSchedulerStats,
} from '../api/queries';
import { formatDuration } from '../utils/timeFormat';
// python_task_multiversion（P2-3）：失败分类标签读面唯一事实源，
// ExecutionCompare 共用，避免再出现"详情页有标签、Dashboard 露裸枚举"的漂移。
import { failureReasonLabel } from '../utils/failure-reason-label';
import { useThemeStore, selectResolvedTheme } from '../theme/store';
import { CHART_COLORS, SEMANTIC_COLORS } from '../theme/tokens';
import PageHeader from '../components/PageHeader';
import PageSkeleton from '../components/PageSkeleton';
import StateError from '../components/StateError';
import KpiSparkline, { buildSparklineData, recentDateKeys, SPARKLINE_HEIGHT } from '../components/dashboard/KpiSparkline';
import FailureTopList from '../components/dashboard/FailureTopList';
import ExecutorHeatBars from '../components/dashboard/ExecutorHeatBars';
import SchedulerLatencyCard from '../components/dashboard/SchedulerLatencyCard';
import DashboardEmptyGuide from '../components/dashboard/DashboardEmptyGuide';
import { useMetricsStream, useMetricsStreamDegraded, type MetricsStreamStatus } from '../hooks/useMetricsStream';
import { useProjectFilter } from '../hooks/useProjectFilter';
// UI-10：导入 i18n 实例（模块副作用完成初始化；树内用 useTranslation 读 key）
import '../i18n';

const { Text } = Typography;

/** UI 打磨：KPI 卡底部 36px 辅佐信息行——与卡 2/3 的 sparkline 等高，保证四张
 *  KPI 卡同排等高（此前 1/4 卡无底部行，同行底部差 ~36px 高低不齐）。 */
function KpiFootnote({ children }: { children?: ReactNode }) {
  return (
    <div
      style={{
        height: SPARKLINE_HEIGHT,
        display: 'flex',
        alignItems: 'center',
        fontSize: 11,
        color: 'var(--chart-axis-text)',
        opacity: 0.7,
      }}
    >
      {children}
    </div>
  );
}

/**
 * P2-1（Dashboard 口径分离）：指标口径分组。
 * - `project`：随顶栏当前项目过滤（请求带 projectId，切项目数值变化）；
 * - `global`：机队/调度全局口径（无项目归属，请求不带 projectId，切项目数值不变）。
 * 分组依据逐字对齐后端 metrics.service.ts：执行器计数 / 调度计数器 / 队列深度
 * 无项目归属，summary 内的 onlineExecutors/totalExecutors 虽随 summary 响应下发，
 * 但后端用 executorRepo.count() 不带项目条件计算（见 service.ts 114–123 行注释）。
 */
type MetricScope = 'project' | 'global';

/**
 * 口径徽章：文字标签 + 图标双编码——不靠颜色单一维度区分。全局卡 hover 显示
 * 「该指标为机队/调度全局统计，不随当前项目过滤」；随项目卡文案直陈口径。
 */
function ScopeBadge({ scope }: { scope: MetricScope }) {
  const { t } = useTranslation();
  if (scope === 'global') {
    return (
      <Tooltip title={t('projectCtx.globalScope.tooltip')}>
        <Tag
          data-testid="scope-badge-global"
          icon={<GlobalOutlined />}
          style={{ fontSize: 10, lineHeight: '16px', marginInlineEnd: 0 }}
        >
          {t('projectCtx.globalScope')}
        </Tag>
      </Tooltip>
    );
  }
  return (
    <Tag
      data-testid="scope-badge-project"
      icon={<ProjectOutlined />}
      style={{ fontSize: 10, lineHeight: '16px', marginInlineEnd: 0 }}
    >
      {t('projectCtx.scopedScope')}
    </Tag>
  );
}

/** 口径分区标题：标题 + 徽章图例 + 一句口径说明，两组在同一屏内分区清晰。 */
function ScopeSectionHeader({ scope, testId }: { scope: MetricScope; testId: string }) {
  const { t } = useTranslation();
  const title = scope === 'global'
    ? t('dashboard.scope.groupGlobal.title')
    : t('dashboard.scope.groupProject.title');
  const desc = scope === 'global'
    ? t('dashboard.scope.groupGlobal.desc')
    : t('dashboard.scope.groupProject.desc');
  return (
    <div
      data-testid={testId}
      style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 4 }}
    >
      <Text strong style={{ fontSize: 15 }}>{title}</Text>
      <ScopeBadge scope={scope} />
      <Text type="secondary" style={{ fontSize: 12 }}>{desc}</Text>
    </div>
  );
}

/** UI-14: SSE 连接状态点——Badge 颜色/文案随连接态切换（导出供测试锚定；
 *  UI-10：label 从 i18n key 取，由调用侧 t() 渲染） */
export function streamStatusBadge(status: MetricsStreamStatus): { color: string; labelKey: string } {
  switch (status) {
    case 'live':
      // D-P2-04（设计审计）：硬编码 hex 改走 theme/tokens.ts 语义色单源
      return { color: SEMANTIC_COLORS.success, labelKey: 'dashboard.stream.live' };
    case 'reconnecting':
      return { color: SEMANTIC_COLORS.warning, labelKey: 'dashboard.stream.reconnecting' };
    default:
      return { color: SEMANTIC_COLORS.neutral, labelKey: 'dashboard.stream.connecting' };
  }
}

/**
 * A6（第二轮审计）：主趋势图序列构建——按「最近 days 天含今日」的完整日期轴
 * 补零。getDailyTrend 只返回**有执行的日**的行，此前直接 map 渲染会在零执行
 * 日出现断点（折线从上周五直接跳到今天，看起来像数据缺失而非「零执行」）。
 * 思路与 KpiSparkline.buildSparklineData 同源（recentDateKeys 生成日期轴 +
 * Map 查表补零）；纯函数导出供测试锚定。
 */
export function buildTrendData(
  trend: { date: string; success: number; failed: number; timeout?: number }[] | undefined,
  days: number,
): { date: string; success: number; failed: number }[] {
  const byDate = new Map(
    (trend ?? []).map(d => [String(d.date).slice(0, 10), d]),
  );
  return recentDateKeys(days).map(key => {
    const row = byDate.get(key);
    return {
      date: key.slice(5),
      success: row?.success ?? 0,
      // A-10（审计趋势口径）：TIMEOUT 并入失败曲线——告警口径为
      // failed|timeout（alerts.yml AUTOFLOW_EXECUTION_FAILURE_RATE_HIGH/
      // _STORM 的 status=~"failed|timeout"），此前超时被丢弃，超时风暴时
      // 失败曲线平稳而告警齐鸣。后端 /metrics/trend 已透出 timeout 键。
      failed: (row?.failed ?? 0) + (row?.timeout ?? 0),
    };
  });
}

/**
 * R281-DEEPLINK-01 · 本文件的失败深链：**一处改多值、一处刻意保持不带 status**。
 *
 * ## 调用点清单（改之前先读这张表）
 *
 * | 位置 | 卡片 | 传参 | 为什么 |
 * |---|---|---|---|
 * | 失败 Top 卡片「全部失败」 | 榜单（Top N 任务的失败次数） | `executionsHref('failed,timeout')` | ✅ 已改多值，见下 |
 * | 最近失败卡片「全部记录」 | 最近失败明细（最多 8 条） | `executionsHref()`（**不带** status） | ❌ **刻意不改**，见下 |
 *
 * ## 为什么「全部失败」必须是多值
 *
 * 「失败」的唯一事实源是后端的
 * `FAILED_EXECUTION_STATUSES = [ExecutionStatus.FAILED, ExecutionStatus.TIMEOUT]`
 * （`apps/admin-api/src/modules/task/entities/task-execution.entity.ts:61`，
 *  R280 立的唯一口径；本文件两张卡的数据源 `/metrics/failures` 与趋势曲线的失败
 *  也已并入 timeout）。而 `/executions` 的 status 过滤是**等值/IN** 过滤：
 *  单值 `?status=failed` 只返回 failed。
 * ⇒ 超时风暴（10 条 timeout、0 条 failed）下「本卡有内容、点进去 0 条」，
 *    用户刚看到 10 条失败却被告知没有匹配——比数字不对更伤信任。
 *
 * ## 为什么「全部记录」**刻意**不带 status（别为了「保持一致」改掉它）
 *
 * 「全部记录」承诺的是**全部**执行记录——用户点它是想看「最近失败那一片之外的上下文」，
 * 它此前（不带 status）就能看到那 10 条 timeout，不存在「漏筛选」缺陷。
 * 若改成 `failed,timeout`，按钮就变成「只能看失败」，「全部」二字成了**新的谎报**
 * （把一个问题换成另一个更坏的问题）。**两处文案都是「全部」但不是同一个承诺**：
 * 一个是「全部失败」，一个是「全部记录」。
 *
 * ## 为什么不能在别处看到 `'failed'` 就顺手统一过来
 *
 * 执行页状态下拉（`ExecutionsPage.tsx:903-904`）的 `failed` / `timeout` 是两个**独立
 * 单值选项**，代表「我主动只想看失败」/「只想看超时」两个筛选意图；深链则是
 * 「从汇总点进来」的快捷路径。**主动筛选**与**从汇总进来**是两个意图，不共用同一个词。
 *
 * ## 深链落到执行页后的下拉表现（实测，非推断）
 *
 * 下拉是受控组件 `value={statusFilter}`，选项只认单值 ⇒ `failed,timeout` 匹配不到任何
 * 选项，**显示为未选中**（antd 把该串放进 `.ant-select-content` 的 title 上），
 * 不报错、不崩、不影响请求（`status: 'failed,timeout'` 原样交给后端）。**属预期**：
 * 深链是汇总入口，用户可在下拉里重新选单值。
 *
 * ## 注意别认错常量
 *
 * `src/utils/failure-reason-aggregate.ts:24` 有**同名** `FAILED_EXECUTION_STATUSES`，
 * 但内容含 `killed`，是「失败原因分布」的口径，**不是**本深链要的那个集合。
 * 本文件按契约传字面量（不新增 import/常量：size-caps 对本文件的 nonCommentLines 与
 * 最长函数体都是**零余量**棘轮，函数体内加一行即红——故注释全部落在模块级）。
 */
export default function DashboardPage() {
  const nav = useNavigate();
  const { t } = useTranslation();
  const [trendDays, setTrendDays] = useState<number>(7);
  // UI-02：图表双主题——网格线/轴文字随 data-theme 切换
  const isDark = useThemeStore(selectResolvedTheme) === 'dark';

  // P1-2：全局当前项目上下文（?project=）。任务/执行派生的聚合按项目过滤；
  // 执行器机队与调度器无项目归属，保持全局口径并在对应卡片显式标注。
  const { backendProjectId, isScoped } = useProjectFilter();

  // UI-14: Dashboard 汇总流——SSE 推送 summary/executors/scheduler 快照直接
  // 写入 queryClient 缓存（setQueryData），连接活跃时页面免轮询；断线自动退避
  // 重连，页头状态点实时提示。
  const streamStatus = useMetricsStream();
  // A-4（审计降级黑洞）：SSE live 期间后端查询降级（具名 error 帧）时
  // useMetricsStream 会触发失败段补拉并置降级标志——这里消费该标志，在页头
  // 显示「数据延迟」角标，避免 live 状态点掩盖数据已陈旧的事实。
  const streamDegraded = useMetricsStreamDegraded();

  // ARCH-26: TanStack Query 改造——六个 useRequest 轮询合并为 queries.ts 薄层
  // hooks（全局默认 staleTime 30s 保底新鲜度，切页 30s 内返回不再重复拉取；
  // queryKey 归一后 summary/trend/executors/failures 跨页共享缓存）。
  // UI-14: Dashboard 汇总流（GET /metrics/stream SSE）推送 summary 快照直接
  // 写入 queryClient 缓存（setQueryData，见 useMetricsStream），连接活跃时
  // 免轮询；断线时 30s refetchInterval 兜底恢复轮询节奏（与 SSE 推送互斥共存）。

  // P2-1：随项目口径的 summary（任务数 / 今日执行 / 运行中 / 成功率 / 平均耗时）。
  const { data: summary, isLoading: summaryLoading, refetch: refetchSummary, error: summaryError } = useMetricsSummary(backendProjectId);

  // P2-1：机队执行器计数无项目归属——后端 executorRepo.count() 不带项目条件
  // （metrics.service.ts 114–123），单独走不带 projectId 的全局 summary 键，
  // 与 metrics/stream 全局快照共享缓存；切项目时这一路数值保持不变。
  const { data: globalSummary, refetch: refetchGlobalSummary } = useMetricsSummary();

  const { data: trend, isLoading: trendLoading, refetch: refetchTrend, error: trendError } = useMetricsTrend(trendDays, backendProjectId);

  // UI-04 ①：sparkline 用近 7 天趋势（含 24h；趋势图主卡共用一次请求，
  // days=1 时后端按日桶仅 1~2 点形状无意义，故 sparkline 取 7 天窗口）
  // queryKey 与主趋势卡 days=7 时自动合并为同一请求。
  const { data: sparkTrend } = useMetricsTrend(7, backendProjectId);

  // 执行器机队无项目归属——即便选中具体项目，热力条仍是全局机队口径（卡片上有标注）。
  const { data: executorStats, isLoading: execLoading, refetch: refetchExecutors, error: execError } = useExecutorStats();

  const { data: failures, isLoading: failLoading, refetch: refetchFailures, error: failError } = useRecentFailures(backendProjectId);

  // UI-04 ④：调度延迟卡数据源（既有 /metrics/scheduler，CORE-06 字段已在）
  // R171（P2-3）：两路调度的 error 此前被丢弃 ⇒ ① 延迟卡落到「暂无定时触发样本」；
  // ② 页头健康 Tag 整块消失（比显示「未知」更糟：读者会以为没有问题）。都收进来。
  const { data: schedulerMetrics, error: schedMetricsError, refetch: refetchSchedMetrics } = useSchedulerMetrics();

  const { data: schedulerStats, error: schedStatsError, refetch: refetchSchedStats } = useSchedulerStats();

  interface DashboardSummary {
    successRate?: number;
    avgDurationMs?: number;
    todayRuns?: number;
    totalTasks?: number;
    onlineExecutors?: number;
    totalExecutors?: number;
    executions?: { total?: number; running?: number; success?: number; failed?: number };
  }
  const s = summary as unknown as DashboardSummary | undefined;
  const g = globalSummary as unknown as DashboardSummary | undefined;
  const successRate = s?.successRate ?? 0;
  const totalExec = s?.executions?.total ?? 0;
  const runningCount = s?.executions?.running ?? 0;
  // METRIC-01：图例补「其他状态」行——successRate 分母（total）含超时/已终止/
  // 运行中，图例此前只展示成功/失败两数，73.33% 与 11+1 在 UI 上对不上。
  // 其他 = total − 成功 − 失败（后端未单列 timeout/cancelled，差值即为其和）。
  const execSuccess = s?.executions?.success ?? 0;
  const execFailed = s?.executions?.failed ?? 0;
  const execOther = Math.max(totalExec - execSuccess - execFailed, 0);

  // UI-16：任一指标读请求失败即整页错误块（互斥/并存均可，取首个非空）。
  // R171（P2-3）：六路（含两路调度）都算——此前调度两路不在其中，失败时整页
  // 完好如初，只有卡片静默变成空态。
  const dashboardError = [summaryError, trendError, execError, failError, schedMetricsError, schedStatsError].find(Boolean);

  // R171（P2-3）：刷新/重试必须覆盖**六路**（页头按钮与错误块共用这一个出口）——
  // 此前两处各抄四行且都不含调度两路 ⇒ 调度失败时点重试是假动作。
  const refetchAll = () => {
    void refetchSummary(); void refetchGlobalSummary(); void refetchTrend(); void refetchExecutors();
    void refetchFailures(); void refetchSchedMetrics(); void refetchSchedStats();
  };

  const failureList = (failures ?? []).slice(0, 8);

  // P1-2：跳执行列表的深链保留当前项目上下文（?project=），与既有筛选参数并存。
  const executionsHref = (status?: string) => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (backendProjectId) params.set('project', backendProjectId);
    const qs = params.toString();
    return `/executions${qs ? `?${qs}` : ''}`;
  };

  // I18N-DATAKEY-01：dataKey 用稳定英文键，展示名由 Area name 走 i18n——
  // 此前用中文「成功/失败」当 dataKey、靠 Legend formatter 映射，Tooltip
  // 仍是裸中文键，属权宜方案。
  // A6（第二轮审计）：趋势图按日期轴补零（见 buildTrendData 注释）。
  const trendData = buildTrendData(trend, trendDays);

  // UI-04 ①：三张 KPI 卡各自的 sparkline 序列（补零 7 天窗，形状稳定）
  const runSpark = buildSparklineData(sparkTrend, 7);
  const sparkHasData = runSpark.some(p => p.value > 0);

  const schedMetrics = schedulerMetrics as SchedulerMetricsResponse | undefined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* UI-03：页头标准化（原 Typography.Title 区块迁入 PageHeader，调度器健康 Tag/刷新进 extra） */}
      <PageHeader
        title={t('dashboard.title')}
        description={t('dashboard.description')}
        extra={
          <>
            {/* UI-14: 汇总流连接状态点 */}
            <Tooltip title={t('dashboard.stream.tooltip', { status: t(streamStatusBadge(streamStatus).labelKey) })}>
              <Badge
                color={streamStatusBadge(streamStatus).color}
                text={<Text type="secondary" style={{ fontSize: 12 }}>{t(streamStatusBadge(streamStatus).labelKey)}</Text>}
                data-testid="metrics-stream-status"
              />
            </Tooltip>
            {/* A-4：查询降级角标——live 期间后端快照查询失败（数据陈旧已补拉） */}
            {streamDegraded && (
              <Tooltip title={t('dashboard.stream.degradedTooltip')}>
                <Badge
                  color={SEMANTIC_COLORS.warning}
                  text={<Text type="warning" style={{ fontSize: 12 }}>{t('dashboard.stream.degraded')}</Text>}
                  data-testid="metrics-stream-degraded"
                />
              </Tooltip>
            )}
            {/* R171（P2-3）：读不到时也要有 Tag，且明说「未知（读取失败）」——旧实现
                `schedulerStats && (…)` 在失败时让 Tag 整块消失，未知 ≠ 健康。 */}
            {(schedulerStats || schedStatsError) && (
              <Tag
                icon={schedulerStats?.healthy ? <CheckCircleOutlined /> : <WarningOutlined />}
                color={schedulerStats?.healthy ? 'success' : schedulerStats ? 'warning' : 'default'}
              >
                {schedulerStats
                  ? t('dashboard.scheduler', { state: t(schedulerStats.healthy ? 'dashboard.scheduler.healthy' : 'dashboard.scheduler.unhealthy'), count: schedulerStats.totalScheduledTasks })
                  : t('dashboard.schedulerUnknown')}
              </Tag>
            )}
            {/* 刷新按钮与下方 StateError 重试同口径（共用 refetchAll 六路）：
                只 refetch summary 会造成「点了刷新但趋势/执行器/失败榜还是旧数据」
                的假刷新（SSE live 时 summary 自动推送，按钮更显多余）。 */}
            <Button icon={<ReloadOutlined />} size="small" onClick={refetchAll}>
              {t('dashboard.refresh')}
            </Button>
          </>
        }
      />

      {/* UI-16：任一指标读请求失败 → 页内错误块（重试=全部 refetch）。
          此前失败表现为各卡骨架/空数字，用户无从判断是「无数据」还是「加载失败」。 */}
      {dashboardError && (
        <StateError error={dashboardError} title={t('dashboard.error.title')} onRetry={refetchAll} />
      )}

      {/* UI-04 ⑤：空态引导——无任何任务时整页引导创建，替代空指标噪音 */}
      <DashboardEmptyGuide totalTasks={s?.totalTasks} onCreateTask={() => nav('/tasks/new')} />

      {/* P2-1 口径分组（随当前项目）：任务/执行类聚合，请求带 projectId，切项目数值变化。 */}
      <ScopeSectionHeader scope="project" testId="scope-group-project" />

      {/* KPI 卡片——UI-02：卡片底色接入 CSS 变量（双主题），强调色取 token 语义面。
          UI-08：首屏（无数据加载中）以骨架形态替代 Spin 包裹，刷新态仍原样 */}
      {/* UI-09：KPI 卡 xs={12} 两列并排时内容宽仅 ~144px——十位数统计值按
          28px 字号会溢出卡片（实测 1,234,567,890 顶出右边界），窄屏由
          .ui09-kpi-stat 媒体查询降字号兜底（见 index.css） */}
      {summaryLoading && !s ? (
        // UI 打磨：KPI 行首屏骨架用 cards 变体（3 张随项目卡），与真实布局同形，
        // 此前 table 行骨架在加载完成瞬间明显跳动
        <PageSkeleton variant="cards" rows={3} />
      ) : (
        <Row gutter={[16, 16]} align="stretch">
          <Col xs={12} sm={8}>
            <Card size="small" variant="borderless" style={{ background: 'var(--color-muted)', height: '100%' }}>
              <Statistic
                className="ui09-kpi-stat"
                title={<Text style={{ fontSize: 13 }}>{t('dashboard.kpi.tasks')} <ScopeBadge scope="project" /></Text>}
                value={s?.totalTasks ?? '-'}
                prefix={<RocketOutlined style={{ color: CHART_COLORS.cpu }} />}
                styles={{ content: { color: CHART_COLORS.cpu, fontSize: 28 } }}
              />
              <KpiFootnote>
                {/* 2026-10-23 口径修正：此前直接写「调度中 N」（N = 内存里的
                    timers.size + cronTasks.size）。它与左边的「任务总数」是两个
                    坐标系——前者是**运行期已注册的定时器**，后者是 DB 行数，
                    暂停/失败补偿/启动窗口都会让两者不等（实测：任务 3、调度中 2）。
                    同一张卡里并排两个数却没有一句解释，读起来就是矛盾。
                    现改词为「已注册调度」并加 tooltip 说明差异来源。 */}
                {schedulerStats ? (
                  <Tooltip title={t('dashboard.kpi.scheduledHint')}>
                    <span>
                      {t('dashboard.kpi.scheduled', { count: schedulerStats.totalScheduledTasks })}
                      {isScoped ? ` · ${t('projectCtx.globalScope')}` : ''}
                    </span>
                  </Tooltip>
                ) : ' '}
              </KpiFootnote>
            </Card>
          </Col>
          {/* UI-04 ①：24h 执行量 + sparkline（随项目） */}
          <Col xs={12} sm={8}>
            <Card size="small" variant="borderless" style={{ background: 'var(--color-muted)', height: '100%' }}>
              <Statistic
                className="ui09-kpi-stat"
                title={<Text style={{ fontSize: 13 }}>{t('dashboard.kpi.todayRuns')} <ScopeBadge scope="project" /></Text>}
                value={s?.todayRuns ?? totalExec}
                prefix={<ThunderboltOutlined style={{ color: CHART_COLORS.success }} />}
                styles={{ content: { color: CHART_COLORS.success, fontSize: 28 } }}
              />
              <KpiSparkline color={CHART_COLORS.success} hasData={sparkHasData} data={runSpark} />
            </Card>
          </Col>
          {/* UI-04 ①：运行中 + sparkline（随项目） */}
          <Col xs={12} sm={8}>
            <Card size="small" variant="borderless" style={{ background: 'var(--color-muted)', height: '100%' }}>
              <Statistic
                className="ui09-kpi-stat"
                title={<Text style={{ fontSize: 13 }}>{t('dashboard.kpi.running')} <ScopeBadge scope="project" /></Text>}
                value={runningCount}
                prefix={<ClockCircleOutlined style={{ color: CHART_COLORS.concurrent }} />}
                styles={{ content: { color: runningCount > 0 ? CHART_COLORS.concurrent : 'var(--chart-axis-text)', fontSize: 28 } }}
                suffix={
                  runningCount > 0
                    ? <Badge status="processing" style={{ marginLeft: 6 }} />
                    : undefined
                }
              />
              <KpiSparkline color={CHART_COLORS.concurrent} hasData={sparkHasData} data={runSpark} />
            </Card>
          </Col>
        </Row>
      )}

      {/* 成功率 + 平均耗时（UI 打磨：两卡等高，右卡内容垂直居中消化空白） */}
      <Row gutter={[16, 16]} align="stretch">
        <Col xs={24} md={12}>
          <Card
            size="small" variant="borderless"
            title={<Text strong style={{ fontSize: 14 }}>{t('dashboard.successRate')} <ScopeBadge scope="project" /></Text>}
            style={{ height: '100%' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <Tooltip title={t('dashboard.successRateHint')}>
                <Progress
                  type="circle"
                  percent={Math.round(successRate * 100) / 100}
                  size={80}
                  strokeColor={successRate >= 95 ? CHART_COLORS.success : successRate >= 80 ? CHART_COLORS.concurrent : CHART_COLORS.failed}
                  format={p => <span style={{ fontSize: 14, fontWeight: 600 }}>{p}%</span>}
                />
              </Tooltip>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <CheckCircleOutlined style={{ color: CHART_COLORS.success }} />
                  <Text>{t('dashboard.success', { count: execSuccess })}</Text>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <CloseCircleOutlined style={{ color: CHART_COLORS.failed }} />
                  <Text>{t('dashboard.failed', { count: execFailed })}</Text>
                </div>
                {execOther > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                    <Tooltip title={t('dashboard.other.tooltip')}>
                      <MinusCircleOutlined style={{ color: 'var(--chart-axis-text)' }} />
                    </Tooltip>
                    <Text type="secondary">{t('dashboard.other', { count: execOther })}</Text>
                  </div>
                )}
              </div>
            </div>
            <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 2 }}>
              {t('dashboard.successRateHint')}
            </Text>
            {/* UI-04 ①：成功率随执行量趋势（同一 sparkline 序列，失败率高时观感即成功率走势） */}
            <KpiSparkline color={CHART_COLORS.cpu} hasData={sparkHasData} data={runSpark} />
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card
            size="small" variant="borderless"
            title={<Text strong style={{ fontSize: 14 }}>{t('dashboard.avgDuration')} <ScopeBadge scope="project" /></Text>}
            style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
            styles={{ body: { flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' } }}
          >
            <div style={{ textAlign: 'center' }}>
              <Text style={{ fontSize: 32, fontWeight: 700, color: CHART_COLORS.cpu }}>
                {formatDuration(s?.avgDurationMs, t)}
              </Text>
              <div style={{ marginTop: 8 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('dashboard.avgHint')}</Text>
              </div>
            </div>
          </Card>
        </Col>
      </Row>

      {/* 趋势图 */}
      <Card
        size="small" variant="borderless"
        title={<Text strong style={{ fontSize: 14 }}>{t('dashboard.trend')} <ScopeBadge scope="project" /></Text>}
        extra={
          <Segmented
            size="small"
            value={trendDays}
            onChange={v => setTrendDays(Number(v))}
            options={[
              { label: t('dashboard.trend.7d'), value: 7 },
              { label: t('dashboard.trend.14d'), value: 14 },
              { label: t('dashboard.trend.30d'), value: 30 },
            ]}
          />
        }
      >
        {/* UI-08：首屏（无数据加载中）骨架形态替代 Spin 包裹；趋势图刷新态原样 */}
        {trendLoading && !trend ? (
          // UI 打磨：骨架高度与图表区（200px）对齐，避免加载完成时卡片高度跳动
          <PageSkeleton variant="table" rows={2} style={{ height: 200 }} />
        ) : (
        <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={trendData} margin={{ top: 5, right: 16, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="gradSuccess" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={CHART_COLORS.success} stopOpacity={0.25} />
                  <stop offset="95%" stopColor={CHART_COLORS.success} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gradFailed" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={CHART_COLORS.failed} stopOpacity={0.25} />
                  <stop offset="95%" stopColor={CHART_COLORS.failed} stopOpacity={0} />
                </linearGradient>
              </defs>
              {/* UI-02：网格/轴随双主题切换 */}
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid(isDark)} />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: CHART_COLORS.axisText(isDark) }} />
              <YAxis tick={{ fontSize: 11, fill: CHART_COLORS.axisText(isDark) }} allowDecimals={false} />
              <RechartTooltip />
              {/* I18N-DATAKEY-01：Legend/Tooltip 直接消费 Area name（i18n），
                  不再需要 formatter 映射中文 dataKey */}
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Area type="monotone" dataKey="success" name={t('dashboard.trend.success')} stroke={CHART_COLORS.success} fill="url(#gradSuccess)" strokeWidth={2} />
              <Area type="monotone" dataKey="failed" name={t('dashboard.trend.failed')} stroke={CHART_COLORS.failed} fill="url(#gradFailed)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </Card>

      {/* 失败 Top 任务榜（UI-04 ②） + 最近失败明细——UI 打磨：同上 md 两列 + 等高 */}
      <Row gutter={[16, 16]} align="stretch">
        <Col xs={24} md={12}>
          <Card
            size="small" variant="borderless"
            title={<Text strong style={{ fontSize: 14 }}>{t('dashboard.failureTop')} <ScopeBadge scope="project" /></Text>}
            style={{ height: '100%' }}
            extra={<Link to={executionsHref('failed,timeout') /* R281-DEEPLINK-01：多值 FAILED∪TIMEOUT，**不要**「统一」回 'failed'——理由见模块级注释块 */} style={{ fontSize: 12 }}>{t('dashboard.failureTop.all')}</Link>}
          >
            {/* UI-08：首屏（无数据加载中）骨架形态替代 Spin 包裹 */}
            {failLoading && !failures ? (
              <PageSkeleton variant="table" rows={2} />
            ) : (
              <FailureTopList failures={failures} onOpenTask={id => nav(`/tasks/${id}`)} />
            )}
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card
            size="small" variant="borderless"
            title={<Text strong style={{ fontSize: 14 }}>{t('dashboard.recentFailures')} <ScopeBadge scope="project" /></Text>}
            style={{ height: '100%' }}
            extra={<Link to={executionsHref() /* R281-DEEPLINK-01：此处**刻意**不带 status——「全部记录」承诺的是全部，改成 failed,timeout 会把「全部」变成「全部失败」，属另一个（更坏的）谎报。详见模块级注释 */} style={{ fontSize: 12 }}>{t('dashboard.recentFailures.all')}</Link>}
          >
            {/* UI-08：首屏（无数据加载中）骨架形态替代 Spin 包裹 */}
            {failLoading && !failures ? (
              <PageSkeleton variant="table" rows={2} />
            ) : (
            <>
              {failureList.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '24px 0' }}>
                  <CheckCircleOutlined style={{ fontSize: 28, color: CHART_COLORS.success }} />
                  <div style={{ marginTop: 8 }}>
                    <Text type="secondary">{t('dashboard.noFailures')}</Text>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {failureList.map(f => (
                    <Alert
                      key={f.id}
                      type="error"
                      showIcon={false}
                      style={{ padding: '6px 10px', borderRadius: 6 }}
                      title={
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            {/* U6: 直接链到执行详情页，失败溯源一步到位 */}
                            {/* F-33（DEEP_REVIEW 0ef3bbe）：原 <a onClick> 无 href，改 <Link>（键盘可达 + 真实 href） */}
                            <Link
                              to={`/tasks/${f.taskId}/executions/${f.id}`}
                              style={{ fontSize: 12, fontWeight: 500, display: 'block' }}
                            >
                              {f.taskName}
                            </Link>
                            <Tooltip title={f.errorMessage}>
                              <Text
                                type="secondary"
                                style={{ fontSize: 11, display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                              >
                                {f.errorMessage || t('dashboard.unknownError')}
                              </Text>
                            </Tooltip>
                            {/* U6: 消费后端 failureReason + exitCode */}
                            {(f.failureReason || f.exitCode != null) && (
                              <Space size={4} style={{ marginTop: 2 }}>
                                {f.failureReason && (
                                  <Tooltip title={f.failureReason}>
                                    <Tag color="volcano" style={{ fontSize: 10, lineHeight: '16px', marginInlineEnd: 0 }}>
                                      {/* 此前直接渲染**原始枚举**并按 12 字符截断，于是
                                          `interpreter_unavailable` 显示成 `interpreter_…`
                                          ——既不是中文也不是英文，用户看不出是什么失败。
                                          改为查 i18n 标签（键与 ExecutionDetailPage 的
                                          FAILURE_REASON_MAP 同一族）；未知值仍回退原始
                                          token（宁可露出 `some_new_reason` 也不显示
                                          "未知原因"把可诊断信息抹掉），此时才截断。 */}
                                      {failureReasonLabel(f.failureReason, t)}
                                    </Tag>
                                  </Tooltip>
                                )}
                                {f.exitCode != null && (
                                  <Tag style={{ fontSize: 10, lineHeight: '16px', marginInlineEnd: 0 }}>exit {f.exitCode}</Tag>
                                )}
                              </Space>
                            )}
                          </div>
                          <Text type="secondary" style={{ fontSize: 11, marginLeft: 8, whiteSpace: 'nowrap' }}>
                            {formatDuration(f.duration, t)}
                          </Text>
                        </div>
                      }
                    />
                  ))}
                </div>
              )}
            </>
            )}
          </Card>
        </Col>
      </Row>

      {/* P2-1 口径分组（全局口径：机队/调度）：执行器机队、调度计数器与队列深度无项目
          归属，请求不带 projectId；切项目时这一组数值保持不变。 */}
      <ScopeSectionHeader scope="global" testId="scope-group-global" />
      <Row gutter={[16, 16]} align="stretch">
        <Col xs={12} md={8}>
          <Card size="small" variant="borderless" style={{ background: 'var(--color-muted)', height: '100%' }}>
            <Statistic
              className="ui09-kpi-stat"
              title={<Text style={{ fontSize: 13 }}>{t('dashboard.kpi.onlineExecutors')} <ScopeBadge scope="global" /></Text>}
              value={`${g?.onlineExecutors ?? '-'} / ${g?.totalExecutors ?? '-'}`}
              prefix={<ApiOutlined style={{ color: CHART_COLORS.memory }} />}
              styles={{ content: { color: CHART_COLORS.memory, fontSize: 28 } }}
            />
            <KpiFootnote>
              {g?.onlineExecutors != null && g?.totalExecutors != null
                ? t('dashboard.kpi.offline', { count: g.totalExecutors - g.onlineExecutors })
                : ' '}
            </KpiFootnote>
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card
            size="small" variant="borderless"
            title={<Text strong style={{ fontSize: 14 }}>{t('dashboard.executors')} <ScopeBadge scope="global" /></Text>}
            style={{ height: '100%' }}
            extra={<Link to="/executors" style={{ fontSize: 12 }}>{t('dashboard.executors.all')}</Link>}
          >
            {/* UI-08：首屏（无数据加载中）骨架形态替代 Spin 包裹 */}
            {execLoading && !executorStats ? (
              <PageSkeleton variant="table" rows={2} />
            ) : (
              <ExecutorHeatBars executors={executorStats ?? []} onOpenExecutor={id => nav(`/executors/${id}`)} />
            )}
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card
            size="small" variant="borderless"
            title={<Text strong style={{ fontSize: 14 }}>{t('dashboard.schedulerLatency')} <ScopeBadge scope="global" /></Text>}
            style={{ height: '100%' }}
          >
            {/* R171（P2-3）：读不到不能渲染成「暂无样本」（那是「确实没有」的文案）。 */}
            {schedMetricsError ? <Text type="danger">{t('dashboard.schedulerLatencyReadFailed')}</Text> : <SchedulerLatencyCard metrics={schedMetrics} />}
          </Card>
        </Col>
      </Row>
    </div>
  );
}
