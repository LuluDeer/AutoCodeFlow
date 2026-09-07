import { useState } from 'react';
import {
  Row, Col, Card, Statistic, Badge, Typography, Table,
  Segmented, Spin, Progress, Tag, Space, Tooltip, Button, Alert,
} from 'antd';
import {
  CheckCircleOutlined, CloseCircleOutlined, ThunderboltOutlined,
  ClockCircleOutlined, RocketOutlined, ApiOutlined, ReloadOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { useNavigate } from 'react-router-dom';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip as RechartTooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { metricsApi } from '../api/metrics';
import { tasksApi } from '../api/tasks';
import { formatDuration } from '../utils/timeFormat';
import { useThemeStore, selectResolvedTheme } from '../theme/store';
import { CHART_COLORS } from '../theme/tokens';
import PageHeader from '../components/PageHeader';

const { Text } = Typography;

export default function DashboardPage() {
  const nav = useNavigate();
  const [trendDays, setTrendDays] = useState<number>(7);
  // UI-02：图表双主题——网格线/轴文字随 data-theme 切换
  const isDark = useThemeStore(selectResolvedTheme) === 'dark';

  const { data: summary, loading: summaryLoading, refresh: refreshSummary } = useRequest(
    () => metricsApi.getSummary(),
    { pollingInterval: 30000, pollingWhenHidden: false },
  );

  const { data: trend, loading: trendLoading } = useRequest(
    () => metricsApi.getDailyTrend(trendDays),
    { refreshDeps: [trendDays] },
  );

  const { data: executorStats, loading: execLoading } = useRequest(
    () => metricsApi.getExecutorStats(),
    { pollingInterval: 30000, pollingWhenHidden: false },
  );

  const { data: failures, loading: failLoading } = useRequest(
    () => metricsApi.getRecentFailures(),
    { pollingInterval: 30000, pollingWhenHidden: false },
  );

  const { data: schedulerStats } = useRequest(
    () => tasksApi.schedulerStats(),
    { pollingInterval: 30000, pollingWhenHidden: false },
  );

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
  const successRate = s?.successRate ?? 0;
  const totalExec = s?.executions?.total ?? 0;
  const runningCount = s?.executions?.running ?? 0;

  const topExecutors = [...(executorStats ?? [])]
    .sort((a, b) => b.runningTaskCount - a.runningTaskCount)
    .slice(0, 5);

  const failureList = (failures ?? []).slice(0, 8);

  const trendData = (trend ?? []).map(d => ({
    date: d.date.slice(5),
    成功: d.success,
    失败: d.failed,
  }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* UI-03：页头标准化（原 Typography.Title 区块迁入 PageHeader，调度器健康 Tag/刷新进 extra） */}
      <PageHeader
        title="控制台"
        description="系统运行总览，每 30 秒自动刷新"
        extra={
          <>
            {schedulerStats && (
              <Tag
                icon={schedulerStats.healthy ? <CheckCircleOutlined /> : <WarningOutlined />}
                color={schedulerStats.healthy ? 'success' : 'warning'}
              >
                调度器 {schedulerStats.healthy ? '健康' : '异常'} · {schedulerStats.totalScheduledTasks} 任务
              </Tag>
            )}
            <Button icon={<ReloadOutlined />} size="small" onClick={refreshSummary}>刷新</Button>
          </>
        }
      />

      {/* KPI 卡片——UI-02：卡片底色接入 CSS 变量（双主题），强调色取 token 语义面 */}
      <Spin spinning={summaryLoading}>
        <Row gutter={[16, 16]}>
          <Col xs={12} sm={6}>
            <Card size="small" variant="borderless" style={{ background: 'var(--color-muted)', borderRadius: 10 }}>
              <Statistic
                title={<Text style={{ fontSize: 13 }}>任务总数</Text>}
                value={s?.totalTasks ?? '-'}
                prefix={<RocketOutlined style={{ color: CHART_COLORS.cpu }} />}
                styles={{ content: { color: CHART_COLORS.cpu, fontSize: 28 } }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small" variant="borderless" style={{ background: 'var(--color-muted)', borderRadius: 10 }}>
              <Statistic
                title={<Text style={{ fontSize: 13 }}>今日执行</Text>}
                value={s?.todayRuns ?? totalExec}
                prefix={<ThunderboltOutlined style={{ color: CHART_COLORS.success }} />}
                styles={{ content: { color: CHART_COLORS.success, fontSize: 28 } }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small" variant="borderless" style={{ background: 'var(--color-muted)', borderRadius: 10 }}>
              <Statistic
                title={<Text style={{ fontSize: 13 }}>运行中</Text>}
                value={runningCount}
                prefix={<ClockCircleOutlined style={{ color: CHART_COLORS.concurrent }} />}
                styles={{ content: { color: runningCount > 0 ? CHART_COLORS.concurrent : 'var(--chart-axis-text)', fontSize: 28 } }}
                suffix={
                  runningCount > 0
                    ? <Badge status="processing" style={{ marginLeft: 6 }} />
                    : undefined
                }
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small" variant="borderless" style={{ background: 'var(--color-muted)', borderRadius: 10 }}>
              <Statistic
                title={<Text style={{ fontSize: 13 }}>在线执行器</Text>}
                value={`${s?.onlineExecutors ?? '-'} / ${s?.totalExecutors ?? '-'}`}
                prefix={<ApiOutlined style={{ color: CHART_COLORS.memory }} />}
                styles={{ content: { color: CHART_COLORS.memory, fontSize: 28 } }}
              />
            </Card>
          </Col>
        </Row>
      </Spin>

      {/* 成功率 + 平均耗时 */}
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12}>
          <Card
            size="small" variant="borderless"
            title={<Text strong style={{ fontSize: 14 }}>执行成功率</Text>}
            style={{ borderRadius: 10 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <Progress
                type="circle"
                percent={Math.round(successRate * 100) / 100}
                size={80}
                strokeColor={successRate >= 95 ? CHART_COLORS.success : successRate >= 80 ? CHART_COLORS.concurrent : CHART_COLORS.failed}
                format={p => <span style={{ fontSize: 14, fontWeight: 600 }}>{p}%</span>}
              />
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <CheckCircleOutlined style={{ color: CHART_COLORS.success }} />
                  <Text>成功 {s?.executions?.success ?? 0}</Text>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <CloseCircleOutlined style={{ color: CHART_COLORS.failed }} />
                  <Text>失败 {s?.executions?.failed ?? 0}</Text>
                </div>
              </div>
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={12}>
          <Card
            size="small" variant="borderless"
            title={<Text strong style={{ fontSize: 14 }}>平均执行时长</Text>}
            style={{ borderRadius: 10 }}
          >
            <div style={{ textAlign: 'center', paddingTop: 8 }}>
              <Text style={{ fontSize: 32, fontWeight: 700, color: CHART_COLORS.cpu }}>
                {formatDuration(s?.avgDurationMs)}
              </Text>
              <div style={{ marginTop: 8 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>基于近期全部执行记录</Text>
              </div>
            </div>
          </Card>
        </Col>
      </Row>

      {/* 趋势图 */}
      <Card
        size="small" variant="borderless"
        title={<Text strong style={{ fontSize: 14 }}>执行趋势</Text>}
        style={{ borderRadius: 10 }}
        extra={
          <Segmented
            size="small"
            value={trendDays}
            onChange={v => setTrendDays(Number(v))}
            options={[
              { label: '7天', value: 7 },
              { label: '14天', value: 14 },
              { label: '30天', value: 30 },
            ]}
          />
        }
      >
        <Spin spinning={trendLoading}>
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
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Area type="monotone" dataKey="成功" stroke={CHART_COLORS.success} fill="url(#gradSuccess)" strokeWidth={2} />
              <Area type="monotone" dataKey="失败" stroke={CHART_COLORS.failed} fill="url(#gradFailed)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </Spin>
      </Card>

      {/* 执行器状态 + 最近失败 */}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card
            size="small" variant="borderless"
            title={<Text strong style={{ fontSize: 14 }}>执行器负载 TOP 5</Text>}
            style={{ borderRadius: 10 }}
            extra={<a onClick={() => nav('/executors')} style={{ fontSize: 12 }}>全部</a>}
          >
            <Spin spinning={execLoading}>
              <Table
                rowKey="id"
                size="small"
                pagination={false}
                dataSource={topExecutors}
                locale={{ emptyText: '暂无在线执行器' }}
                columns={[
                  {
                    title: '地址',
                    dataIndex: 'address',
                    ellipsis: true,
                    render: (v: string, r: { id: string }) => (
                      <a onClick={() => nav(`/executors/${r.id}`)} style={{ fontSize: 12 }}>{v}</a>
                    ),
                  },
                  {
                    title: '状态',
                    dataIndex: 'status',
                    width: 70,
                    render: (v: string) => (
                      <Badge
                        status={v === 'online' ? 'success' : v === 'busy' ? 'processing' : 'default'}
                        text={<Text style={{ fontSize: 11 }}>{v === 'online' ? '在线' : v === 'busy' ? '忙碌' : '离线'}</Text>}
                      />
                    ),
                  },
                  {
                    title: 'CPU',
                    dataIndex: 'cpuUsage',
                    width: 65,
                    render: (v: number) => (
                      <Text style={{ fontSize: 11, color: v > 80 ? CHART_COLORS.failed : v > 60 ? CHART_COLORS.concurrent : CHART_COLORS.success }}>
                        {v?.toFixed(0)}%
                      </Text>
                    ),
                  },
                  {
                    title: '运行中',
                    dataIndex: 'runningTaskCount',
                    width: 60,
                    render: (v: number) => <Text style={{ fontSize: 11 }}>{v}</Text>,
                  },
                ]}
              />
            </Spin>
          </Card>
        </Col>

        <Col xs={24} lg={12}>
          <Card
            size="small" variant="borderless"
            title={<Text strong style={{ fontSize: 14 }}>最近失败</Text>}
            style={{ borderRadius: 10 }}
            extra={<a onClick={() => nav('/executions')} style={{ fontSize: 12 }}>全部记录</a>}
          >
            <Spin spinning={failLoading}>
              {failureList.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '24px 0' }}>
                  <CheckCircleOutlined style={{ fontSize: 28, color: CHART_COLORS.success }} />
                  <div style={{ marginTop: 8 }}>
                    <Text type="secondary">近期无失败记录</Text>
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
                            <a
                              onClick={() => nav(`/tasks/${f.taskId}/executions/${f.id}`)}
                              style={{ fontSize: 12, fontWeight: 500, display: 'block' }}
                            >
                              {f.taskName}
                            </a>
                            <Tooltip title={f.errorMessage}>
                              <Text
                                type="secondary"
                                style={{ fontSize: 11, display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 200 }}
                              >
                                {f.errorMessage || '未知错误'}
                              </Text>
                            </Tooltip>
                            {/* U6: 消费后端 failureReason + exitCode */}
                            {(f.failureReason || f.exitCode != null) && (
                              <Space size={4} style={{ marginTop: 2 }}>
                                {f.failureReason && (
                                  <Tooltip title={f.failureReason}>
                                    <Tag color="volcano" style={{ fontSize: 10, lineHeight: '16px', marginInlineEnd: 0 }}>
                                      {f.failureReason.length > 12 ? `${f.failureReason.slice(0, 12)}…` : f.failureReason}
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
                            {formatDuration(f.duration)}
                          </Text>
                        </div>
                      }
                    />
                  ))}
                </div>
              )}
            </Spin>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
