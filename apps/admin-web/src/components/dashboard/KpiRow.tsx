/**
 * T2（P1）数据诚实性：Dashboard KPI 区（随项目口径的三张统计卡 + 成功率/平均耗时）。
 *
 * 从 DashboardPage 外提（棘轮：页面只留一行组件调用）。核心口径：
 *   · summary **读失败** ⇒ 所有派生值（今日执行 / 运行中 / 成功率 / 计数）显示 `—`，
 *     成功率环**整个不渲染**（旧实现 `?? 0` + 红 strokeColor 把「没读到」画成「0%」）；
 *   · summary **读到且 successRate === 0** ⇒ 照常显示 0% 与红色环——控制组不能被吞；
 *   · totalTasks 沿用既有 `?? '—'` 口径，读失败时同样为 `—`。
 */
import { Row, Col, Card, Statistic, Badge, Typography, Tooltip, Progress } from 'antd';
import {
  CheckCircleOutlined, CloseCircleOutlined, RocketOutlined,
  ThunderboltOutlined, ClockCircleOutlined, MinusCircleOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import type { DailyTrend } from '../../api/metrics';
import { CHART_COLORS } from '../../theme/tokens';
import KpiSparkline, { buildSparklineData, SPARKLINE_HEIGHT } from './KpiSparkline';
import AvgDurationCard from './AvgDurationCard';
import PageSkeleton from '../PageSkeleton';
import '../../i18n';

const { Text } = Typography;

/** 与旧 DashboardPage 同形的 summary 最小面（跨页共享缓存的快照可能缺字段）。 */
export interface KpiSummary {
  successRate?: number;
  avgDurationMs?: number;
  todayRuns?: number;
  totalTasks?: number;
  executions?: { total?: number; running?: number; success?: number; failed?: number };
}

export interface KpiRowProps {
  summary: KpiSummary | undefined;
  summaryLoading: boolean;
  summaryError: unknown;
  isScoped: boolean;
  /** 调度统计只需这一个字段（与 tasksApi.schedulerStats 返回结构兼容）。 */
  schedulerStats: { totalScheduledTasks: number } | undefined;
  /** 7 天趋势（父页面已请求，queryKey 与主趋势图共用，无新增请求）。 */
  sparkTrend: DailyTrend[] | undefined;
}

/** 与 DashboardPage 的 KpiFootnote 同规格：四张 KPI 卡同排等高。 */
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

/** 读失败统一占位（不是 0，也不是空字符串）。 */
const UNKNOWN = '—';

export default function KpiRow({
  summary, summaryLoading, summaryError, isScoped, schedulerStats, sparkTrend,
}: KpiRowProps) {
  const { t } = useTranslation();
  const s = summary;
  const readFailed = Boolean(summaryError);

  const totalExec = s?.executions?.total ?? 0;
  const todayRuns = s?.todayRuns ?? totalExec;
  const runningCount = s?.executions?.running ?? 0;
  const execSuccess = s?.executions?.success ?? 0;
  const execFailed = s?.executions?.failed ?? 0;
  const execOther = Math.max(totalExec - execSuccess - execFailed, 0);
  const successRate = s?.successRate;

  const runSpark = buildSparklineData(sparkTrend, 7);
  const sparkHasData = runSpark.some(p => p.value > 0);

  if (summaryLoading && !s) {
    return <PageSkeleton variant="cards" rows={3} />;
  }

  return (
    <>
      <Row gutter={[16, 16]} align="stretch">
        <Col xs={12} sm={8}>
          <Card size="small" variant="borderless" style={{ background: 'var(--color-muted)', height: '100%' }}>
            <Statistic
              className="ui09-kpi-stat"
              title={<Text style={{ fontSize: 13 }}>{t('dashboard.kpi.tasks')}</Text>}
              value={s?.totalTasks ?? UNKNOWN}
              prefix={<RocketOutlined style={{ color: CHART_COLORS.cpu }} />}
              styles={{ content: { color: CHART_COLORS.cpu, fontSize: 28 } }}
            />
            <KpiFootnote>
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
        <Col xs={12} sm={8}>
          <Card size="small" variant="borderless" style={{ background: 'var(--color-muted)', height: '100%' }}>
            <div data-testid="kpi-today-runs">
              <Statistic
                className="ui09-kpi-stat"
                title={<Text style={{ fontSize: 13 }}>{t('dashboard.kpi.todayRuns')}</Text>}
                value={readFailed ? UNKNOWN : todayRuns}
                prefix={<ThunderboltOutlined style={{ color: CHART_COLORS.success }} />}
                styles={{ content: { color: CHART_COLORS.success, fontSize: 28 } }}
              />
            </div>
            <KpiSparkline color={CHART_COLORS.success} hasData={sparkHasData} data={runSpark} />
          </Card>
        </Col>
        <Col xs={12} sm={8}>
          <Card size="small" variant="borderless" style={{ background: 'var(--color-muted)', height: '100%' }}>
            <div data-testid="kpi-running">
              <Statistic
                className="ui09-kpi-stat"
                title={<Text style={{ fontSize: 13 }}>{t('dashboard.kpi.running')}</Text>}
                value={readFailed ? UNKNOWN : runningCount}
                prefix={<ClockCircleOutlined style={{ color: CHART_COLORS.concurrent }} />}
                styles={{ content: { color: !readFailed && runningCount > 0 ? CHART_COLORS.concurrent : 'var(--chart-axis-text)', fontSize: 28 } }}
                suffix={
                  !readFailed && runningCount > 0
                    ? <Badge status="processing" style={{ marginLeft: 6 }} />
                    : undefined
                }
              />
            </div>
            <KpiSparkline color={CHART_COLORS.concurrent} hasData={sparkHasData} data={runSpark} />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} align="stretch">
        <Col xs={24} md={12}>
          <Card
            size="small" variant="borderless"
            title={<Text strong style={{ fontSize: 14 }}>{t('dashboard.successRate')}</Text>}
            style={{ height: '100%' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <div data-testid="kpi-success-rate">
                {readFailed || successRate == null ? (
                  <Tooltip title={t('dashboard.successRateHint')}>
                    <Text style={{ fontSize: 28, fontWeight: 600 }}>{UNKNOWN}</Text>
                  </Tooltip>
                ) : (
                  <Tooltip title={t('dashboard.successRateHint')}>
                    <Progress
                      type="circle"
                      percent={Math.round(successRate * 100) / 100}
                      size={80}
                      strokeColor={successRate >= 95 ? CHART_COLORS.success : successRate >= 80 ? CHART_COLORS.concurrent : CHART_COLORS.failed}
                      format={p => <span style={{ fontSize: 14, fontWeight: 600 }}>{p}%</span>}
                    />
                  </Tooltip>
                )}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <CheckCircleOutlined style={{ color: CHART_COLORS.success }} />
                  <Text>{t('dashboard.success', { count: readFailed ? UNKNOWN : execSuccess })}</Text>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <CloseCircleOutlined style={{ color: CHART_COLORS.failed }} />
                  <Text>{t('dashboard.failed', { count: readFailed ? UNKNOWN : execFailed })}</Text>
                </div>
                {!readFailed && execOther > 0 && (
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
            <KpiSparkline color={CHART_COLORS.cpu} hasData={sparkHasData} data={runSpark} />
          </Card>
        </Col>
        <Col xs={24} md={12}>
          {readFailed ? (
            <Card size="small" variant="borderless" title={<Text strong style={{ fontSize: 14 }}>{t('dashboard.avgDuration')}</Text>} style={{ height: '100%' }}>
              <div data-testid="kpi-avg-duration" style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 80 }}>
                <ClockCircleOutlined style={{ fontSize: 24, color: CHART_COLORS.cpu }} />
                <Text style={{ fontSize: 28, fontWeight: 700, color: CHART_COLORS.cpu, lineHeight: 1.2 }}>{UNKNOWN}</Text>
              </div>
              <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 2 }}>
                {t('dashboard.avgHint')}
              </Text>
            </Card>
          ) : (
            <AvgDurationCard
              avgDurationMs={s?.avgDurationMs}
              todayRuns={todayRuns}
              runningCount={runningCount}
              sparkHasData={sparkHasData}
              sparkData={runSpark}
            />
          )}
        </Col>
      </Row>
    </>
  );
}
