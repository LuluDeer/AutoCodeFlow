import { useParams, useNavigate } from 'react-router-dom';
import { Card, Descriptions, Table, Badge, Button, Modal, Form, Input, InputNumber, Select, message, Statistic, Row, Col, Progress, Typography, Breadcrumb, Empty, Tooltip, Space, Alert, Result } from 'antd';
import { WarningOutlined, CopyOutlined, InfoCircleOutlined, ReloadOutlined, DeleteOutlined } from '@ant-design/icons';
// FEAT-04: 24h 资源趋势折线图（Tooltip 别名避开 antd Tooltip，DashboardPage 同法）
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartTooltip, Legend, ResponsiveContainer } from 'recharts';
import { useRequest } from 'ahooks';
import { useQueryClient } from '@tanstack/react-query';
import { executorsApi, type ExecutorExecution } from '../api/executors';
import {
  useExecutorDetail,
  useExecutorMetrics,
  useExecutorExecutions,
  invalidateExecutorData,
} from '../api/queries';
import { getErrMsg } from '../utils/error';
import { useAuthStore, isAdminUser } from '../store/auth';
import { useThemeStore, selectResolvedTheme } from '../theme/store';
import { CHART_COLORS } from '../theme/tokens';
import PageSkeleton from '../components/PageSkeleton';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
// UI-10：导入 i18n 实例（模块副作用完成初始化；树内用 useTranslation 读 key）
import '../i18n';

const { Text } = Typography;

/** AUTH-05 交接：高危操作 reason 上限（对齐 admin-api DTO 契约：≤200 字符） */
const MAX_REASON_LENGTH = 200;

function relativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  return `${Math.floor(hours / 24)}天前`;
}

function isHeartbeatStale(isoString: string): boolean {
  return Date.now() - new Date(isoString).getTime() > 5 * 60 * 1000;
}

/** Returns Ant Design token color based on usage percent and thresholds */
function usageColor(value: number, warn =60, danger = 80): string {
  if (value >= danger) return '#cf1322';
  if (value >= warn) return '#faad14';
  return '#3f8600';
}

/** FEAT-04: 折线图 X 轴刻度——按小时:分钟显示（样本桶距 15 分钟起） */
function trendTickFormatter(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** FEAT-04: Tooltip 标题——完整本地时间，区分同日/跨日 */
function trendTooltipLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString('zh-CN', { hour12: false })
    : d.toLocaleString('zh-CN', { hour12: false });
}

export default function ExecutorDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  // W2 对齐：管理写操作（编辑/配置热更新/设置离线/轮换 Token）后端已收紧
  // ADMIN-only，非 admin 隐藏入口，避免"可见但点击 403"（R5 门控模式）。
  const isAdmin = isAdminUser(useAuthStore((s) => s.user));
  // UI-02：资源趋势图双主题（网格线/轴文字）
  const isDark = useThemeStore(selectResolvedTheme) === 'dark';
  const [editOpen, setEditOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [execPage, setExecPage] = useState(1);
  // AUTH-05 交接：单台高危操作二次确认（受控 Modal，含可选 reason ≤200）
  const [rotateOpen, setRotateOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [editForm] = Form.useForm();
  const [configForm] = Form.useForm();
  const [rotateForm] = Form.useForm();
  const [removeForm] = Form.useForm();

  // FEAT-17: TanStack Query 改造——读侧三个 useRequest 换 queries.ts hooks
  // （metrics 30s 轮询由 refetchInterval 承担；分页参数进 queryKey）。
  const { data: executor, isLoading: loadingExecutor, error: executorError } = useExecutorDetail(id);

  const { data: metrics, isLoading: loadingMetrics } = useExecutorMetrics(id);

  const { data: executions, isLoading: loadingExecutions } = useExecutorExecutions(id, {
    page: execPage,
    pageSize: 20,
  });

  // 写后失效：原 useRequest refresh → invalidateExecutorData（执行器面 +
  // 任务面联动；executor pinning/分组影响任务派发读面）。
  const queryClient = useQueryClient();
  const refreshExecutor = () => void invalidateExecutorData(queryClient);

  const { run: updateExecutor, loading: updating } = useRequest(
    (values) => executorsApi.update(id!, values),
    { manual: true, onSuccess: () => { message.success(t('executorDetail.updateSuccess')); setEditOpen(false); refreshExecutor(); } },
  );

  const { run: reloadConfig, loading: reloading } = useRequest(
    (values) => executorsApi.reloadConfig(id!, values),
    { manual: true, onSuccess: () => { message.success(t('executorDetail.configPushed')); setConfigOpen(false); } },
  );

  // AUTH-05 交接：轮换请求体携带可选 reason（≤200，审计 executor.rotate_token）
  const { run: rotateToken, loading: rotating } = useRequest(
    (reason?: string) => executorsApi.rotateToken(id!, reason?.trim() || undefined),
    {
      manual: true,
      onSuccess: (res) => {
        setRotateOpen(false);
        rotateForm.resetFields();
        Modal.success({
          title: t('executorDetail.rotate.newTokenTitle'),
          content: (
            <Space>
              <Text code copyable={{ text: res.token }}>{res.token}</Text>
            </Space>
          ),
        });
      },
      onError: (e) => { message.error(t('executorDetail.rotate.rotateFail', { err: getErrMsg(e, t('executorDetail.retry')) })); },
    },
  );

  // AUTH-05 交接：删除执行器（此前前端无删除入口）。reason 可选随 body 写审计
  const { run: removeExecutor, loading: removing } = useRequest(
    (reason?: string) => executorsApi.remove(id!, reason?.trim() || undefined),
    {
      manual: true,
      onSuccess: () => {
        message.success(t('executorDetail.remove.removeSuccess'));
        navigate('/executors');
      },
      onError: (e) => { message.error(t('executorDetail.remove.removeFail', { err: getErrMsg(e, t('executorDetail.retry')) })); },
    },
  );

  const { run: setOffline, loading: settingOffline } = useRequest(
    () => executorsApi.setOffline(id!),
    {
      manual: true,
      onSuccess: () => { message.success(t('executorDetail.offline.offlineSuccess')); refreshExecutor(); },
      onError: (e) => { message.error(t('executorDetail.offline.offlineFail', { err: e.message })); },
    },
  );

  // UI-08：首屏骨架屏替代裸 Spin
  if (loadingExecutor && !executor) return <PageSkeleton variant="table" rows={6} style={{ padding: 24 }} />;
  // U7: 请求失败 ≠ 执行器不存在——错误态给重试入口，数据确空才显示 Empty
  if (!executor && executorError) {
    return (
      <Result
        status="error"
        title={t('executorDetail.loadErrorTitle')}
        subTitle={getErrMsg(executorError, t('executorDetail.loadErrorFallback'))}
        extra={
          <Space>
            <Button onClick={() => navigate('/executors')}>{t('executorDetail.backToList')}</Button>
            <Button type="primary" icon={<ReloadOutlined />} onClick={refreshExecutor}>{t('executorDetail.retryBtn')}</Button>
          </Space>
        }
      />
    );
  }
  if (!executor) return <div style={{ padding: 80 }}><Empty description={t('executorDetail.notFound')} /></div>;

  const isOnline = executor.status === 'online';
  const maxConcurrent = executor.maxConcurrentTasks ?? 0;
  // FEAT-04: 24h 资源趋势采样点（后端 15 分钟 AVG 桶，≤96 点，升序；
  // history 缺失（旧响应）与空数组同视——走空态兜底）。
  const historyPoints = metrics?.history ?? [];
  // U5: CPU/内存/运行计数取 30s 轮询的 metrics.current（首轮返回前回退进页快照）。
  // diskUsage/lastHeartbeat/runningExecutionIds 不在 metrics 接口内，仍来自 get 快照，
  // 活性区（最后心跳/运行中执行）在 UI 标注快照语义。
  const liveCpu = metrics?.current?.cpuUsage ?? executor.cpuUsage ?? 0;
  const liveMem = metrics?.current?.memUsage ?? executor.memUsage ?? 0;
  const runningCount = metrics?.current?.runningTaskCount ?? executor.runningTaskCount ?? 0;
  const runningPercent = maxConcurrent > 0 ? Math.min(100, Math.round((runningCount / maxConcurrent) * 100)) : 0;

  // CONSISTENCY-02: 执行器心跳上报的运行中 executionId（null = 旧版未上报）。
  // 与 runningTaskCount 交叉核对：长期不一致提示执行器计数或回调链路异常。
  const reportedIds = executor.runningExecutionIds;
  const reportedCount = reportedIds?.length;

  const heartbeatStale = executor.lastHeartbeat ? isHeartbeatStale(executor.lastHeartbeat) : false;
  const heartbeatText = executor.lastHeartbeat ? relativeTime(executor.lastHeartbeat) : '-';
  const heartbeatAbsolute = executor.lastHeartbeat ? new Date(executor.lastHeartbeat).toLocaleString() : '';

  type BadgeStatus = 'success' | 'processing' | 'error' | 'default' | 'warning';
  const STATUS_MAP = (t: (k: string) => string): Record<string, { badge: BadgeStatus; label: string }> => ({
    pending:   { badge: 'default',    label: t('executorDetail.status.pending') },
    running:   { badge: 'processing', label: t('executorDetail.status.running') },
    success:   { badge: 'success',    label: t('executorDetail.status.success') },
    failed:    { badge: 'error',      label: t('executorDetail.status.failed') },
    timeout:   { badge: 'warning',    label: t('executorDetail.status.timeout') },
    killed:    { badge: 'error',      label: t('executorDetail.status.killed') },
    cancelled: { badge: 'default',    label: t('executorDetail.status.cancelled') },
  });
  const statusMap = STATUS_MAP(t);
  const execColumns = [
    // U10: 补任务名/退出码列，行点击直达执行详情页
    { title: t('executorDetail.history.col.task'), dataIndex: 'taskName', key: 'taskName', ellipsis: true, render: (v: string | undefined, r: ExecutorExecution) => (
      <a onClick={(e) => { e.stopPropagation(); navigate(`/tasks/${r.taskId}/executions/${r.id}`); }}>{v || r.taskId}</a>
    )},
    { title: t('executorDetail.history.col.status'), dataIndex: 'status', key: 'status', width: 90, render: (v: string) => {
      const cfg = statusMap[v] || { badge: 'default' as BadgeStatus, label: v };
      return <Badge status={cfg.badge} text={cfg.label} />;
    }},
    { title: t('executorDetail.history.col.startTime'), dataIndex: 'startTime', key: 'startTime', width: 170, render: (v: string) => v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '-' },
    { title: t('executorDetail.history.col.duration'), dataIndex: 'duration', key: 'duration', width: 90, render: (v: number) => v != null ? (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`) : '-' },
    { title: t('executorDetail.history.col.exitCode'), dataIndex: 'exitCode', key: 'exitCode', width: 80, render: (v: number | null | undefined) => v != null ? <Text type={v !== 0 ? 'danger' : undefined} code>{v}</Text> : '-' },
    { title: t('executorDetail.history.col.error'), dataIndex: 'errorMessage', key: 'errorMessage', ellipsis: true, render: (v: string) => v ? <Text type="danger" style={{ fontSize: 12 }}>{v}</Text> : '-' },
  ];

  return (
    <div>
      <Breadcrumb
        style={{ marginBottom: 16 }}
        items={[
          { title: <a onClick={() => navigate('/executors')}>{t('executorDetail.breadcrumb.list')}</a> },
          { title: executor.appName },
        ]}
      />

      <Card
        title={t('executorDetail.title')}
        extra={
          isAdmin ? (
          <Space>
            <Button.Group>
              <Button onClick={() => { editForm.setFieldsValue(executor); setEditOpen(true); }}>{t('executorDetail.edit')}</Button>
              <Button onClick={() => setConfigOpen(true)}>{t('executorDetail.configHotReload')}</Button>
              <Button
                danger
                disabled={!isOnline}
                loading={settingOffline}
                onClick={() => {
                  Modal.confirm({
                    title: t('executorDetail.offline.confirmTitle'),
                    content: t('executorDetail.offline.confirmContent'),
                    okText: t('executorDetail.confirm'),
                    cancelText: t('executorDetail.cancel'),
                    onOk: setOffline,
                  });
                }}
              >
                {t('executorDetail.offline.setOffline')}
              </Button>
            </Button.Group>
            <Tooltip title={t('executorDetail.rotate.oldTokenInvalidTip')}>
              <Button
                danger
                icon={<CopyOutlined />}
                onClick={() => { rotateForm.resetFields(); setRotateOpen(true); }}
              >{t('executorDetail.rotate.rotateToken')}</Button>
            </Tooltip>
            {/* AUTH-05 交接：删除执行器入口（高危，与列表批量操作互补的单台形态） */}
            <Tooltip title={t('executorDetail.remove.reRegisterTip')}>
              <Button
                danger
                icon={<DeleteOutlined />}
                onClick={() => { removeForm.resetFields(); setRemoveOpen(true); }}
              >{t('executorDetail.remove.delete')}</Button>
            </Tooltip>
          </Space>
          ) : undefined
        }
      >
        <Descriptions column={3}>
          <Descriptions.Item label={t('executorDetail.field.appName')}>{executor.appName}</Descriptions.Item>
          <Descriptions.Item label={t('executorDetail.field.address')}>{executor.address}</Descriptions.Item>
          <Descriptions.Item label={t('executorDetail.field.status')}>
            <Badge status={isOnline ? 'success' : 'default'} text={executor.status} />
          </Descriptions.Item>
          <Descriptions.Item label={t('executorDetail.field.type')}>{executor.type || '-'}</Descriptions.Item>
          <Descriptions.Item label={t('executorDetail.field.version')}>{executor.executorVersion || '-'}</Descriptions.Item>
          <Descriptions.Item label={t('executorDetail.field.group')}>{executor.groupName || '-'}</Descriptions.Item>
          <Descriptions.Item label={t('executorDetail.field.tags')}>{executor.tags?.join(', ') || '-'}</Descriptions.Item>
          <Descriptions.Item label={t('executorDetail.field.maxConcurrent')}>{executor.maxConcurrentTasks ?? t('executorDetail.unlimited')}</Descriptions.Item>
          <Descriptions.Item label={t('executorDetail.field.lastHeartbeat')}>
            <Tooltip title={heartbeatAbsolute}>
              {heartbeatStale ? (
                <Text style={{ color: '#fa8c16' }}>
                  <WarningOutlined style={{ marginRight: 4 }} />
                  {heartbeatText}
                </Text>
              ) : (
                <Text>{heartbeatText}</Text>
              )}
            </Tooltip>
          </Descriptions.Item>
          <Descriptions.Item label={t('executorDetail.field.description')} span={2}>{executor.description || '-'}</Descriptions.Item>
          <Descriptions.Item label={t('executorDetail.field.runningExecutions')}>
            {reportedIds === undefined || reportedIds === null ? (
              <Tooltip title={t('executorDetail.running.notReportedTip')}>
                <Text type="secondary">{t('executorDetail.notReported')} <InfoCircleOutlined /></Text>
              </Tooltip>
            ) : reportedCount === 0 ? (
              <Text type="secondary">{t('executorDetail.running.idle')}</Text>
            ) : (
              <Tooltip title={
                <div style={{ maxHeight: 240, overflowY: 'auto' }}>
                  {reportedIds.map((eid) => (
                    <div key={eid} style={{ fontFamily: 'monospace', fontSize: 12 }}>{eid}</div>
                  ))}
                </div>
              }>
                <Text>{t('executorDetail.running.count', { count: reportedCount })} <InfoCircleOutlined /></Text>
              </Tooltip>
            )}
          </Descriptions.Item>
          {/* U16: 死信积压——回调持续失败的载荷落盘执行器本地 dead-letter */}
          <Descriptions.Item label={t('executorDetail.field.deadLetter')}>
            {executor.deadLetterCount === undefined || executor.deadLetterCount === null ? (
              <Tooltip title={t('executorDetail.deadLetter.notReportedTip')}>
                <Text type="secondary">{t('executorDetail.notReported')} <InfoCircleOutlined /></Text>
              </Tooltip>
            ) : executor.deadLetterCount === 0 ? (
              <Text type="success">{t('executorDetail.deadLetter.none')}</Text>
            ) : (
              <Tooltip title={t('executorDetail.deadLetter.tip')}>
                <Text type="warning">
                  <WarningOutlined style={{ marginRight: 4 }} />
                  {t('executorDetail.deadLetter.count', { count: executor.deadLetterCount })} <InfoCircleOutlined />
                </Text>
              </Tooltip>
            )}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      {!isOnline && (
        <Alert
          type="warning"
          showIcon
          message={t('executorDetail.offline.alert')}
          style={{ marginTop: 16 }}
        />
      )}

      <Row gutter={16} style={{ marginTop: 16 }}>
        <Col span={12}>
          <Card
            title={t('executorDetail.live.title')}
            loading={loadingMetrics && !metrics}
            extra={<Text type="secondary" style={{ fontSize: 12 }}>{t('executorDetail.live.pollInterval')}</Text>}
          >
            <Row gutter={16}>
              {([
                { title: t('executorDetail.live.cpu'), value: liveCpu, warn: 60, danger: 80 },
                { title: t('executorDetail.live.memory'), value: liveMem, warn: 60, danger: 80 },
                // diskUsage 不在 metrics 接口内：仍取进页快照
                { title: t('executorDetail.live.disk'), value: executor.diskUsage ?? 0, warn: 70, danger: 90 },
              ] as const).map(({ title, value, warn, danger }) => (
                <Col span={8} key={title}>
                  <Statistic title={title} value={value} suffix="%" precision={1} styles={{ content: { color: usageColor(value, warn, danger) } }} />
                  <Progress percent={Math.round(value)} showInfo={false} strokeColor={usageColor(value, warn, danger)} style={{ marginTop: 8 }} />
                </Col>
              ))}
            </Row>
          </Card>
        </Col>
        <Col span={12}>
          <Card title={t('executorDetail.stats.title')} loading={loadingMetrics && !metrics}>
            {metrics ? (
              <Row gutter={16}>
                <Col span={8}><Statistic title={t('executorDetail.stats.totalExecutions')} value={metrics.sevenDayStats.totalExecutions} /></Col>
                <Col span={8}>
                  <Statistic title={t('executorDetail.stats.successRate')} value={metrics.sevenDayStats.successRate} suffix="%" styles={{ content: { color: '#3f8600' } }} precision={1} />
                  <Text type="secondary" style={{ fontSize: 12 }}>{t('executorDetail.stats.succFail', { succ: metrics.sevenDayStats.successful, fail: metrics.sevenDayStats.failed })}</Text>
                </Col>
                <Col span={8}><Statistic title={t('executorDetail.stats.avgDuration')} value={metrics.sevenDayStats.averageDurationMs} suffix="ms" precision={0} /></Col>
              </Row>
            ) : (
              !loadingMetrics && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('executorDetail.stats.empty')} />
            )}
          </Card>
        </Col>
      </Row>

      {/* FEAT-04: 24h 资源趋势——CPU/内存（左轴 %）与并发任务数（右轴）。
          数据随 metrics 端点 30s 轮询顺带刷新（后端 15 分钟聚合桶，变化慢）；
          空数据显示显式空态（执行器新建或历史采样未启用时为常态）。 */}
      <Card
        title={t('executorDetail.resourceTrend')}
        style={{ marginTop: 16 }}
        loading={loadingMetrics && !metrics}
        extra={<Text type="secondary" style={{ fontSize: 12 }}>{t('executorDetail.resourceTrendExtra')}</Text>}
      >
        {historyPoints.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('executorDetail.history.empty')} />
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={historyPoints} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
              {/* UI-02：网格/轴随双主题切换 */}
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={CHART_COLORS.grid(isDark)} />
              <XAxis
                dataKey="timestamp"
                tickFormatter={trendTickFormatter}
                tick={{ fontSize: 11, fill: CHART_COLORS.axisText(isDark) }}
                minTickGap={32}
                interval="preserveStartEnd"
              />
              {/* 左轴：CPU/内存百分比；右轴：并发任务数（独立量纲） */}
              <YAxis yAxisId="pct" domain={[0, 100]} width={36} tick={{ fontSize: 11, fill: CHART_COLORS.axisText(isDark) }} />
              <YAxis yAxisId="cnt" orientation="right" allowDecimals={false} width={36} tick={{ fontSize: 11, fill: CHART_COLORS.axisText(isDark) }} />
              <RechartTooltip labelFormatter={(label) => trendTooltipLabel(String(label))} labelStyle={{ fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line yAxisId="pct" type="monotone" dataKey="cpuUsage" name="CPU %" stroke={CHART_COLORS.cpu} strokeWidth={1.5} dot={false} connectNulls />
              <Line yAxisId="pct" type="monotone" dataKey="memUsage" name={t('executorDetail.trend.mem')} stroke={CHART_COLORS.memory} strokeWidth={1.5} dot={false} connectNulls />
              <Line yAxisId="cnt" type="monotone" dataKey="runningTaskCount" name={t('executorDetail.trend.concurrent')} stroke={CHART_COLORS.concurrent} strokeWidth={1.5} dot={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        )}
      </Card>

      <Row gutter={16} style={{ marginTop: 16 }}>
        <Col span={8}>
          <Card>
            <Statistic title={t('executorDetail.currentRunning')} value={runningCount} suffix={`/ ${executor.maxConcurrentTasks ?? '∞'}`} />
            {maxConcurrent > 0 && (
              <Progress percent={runningPercent} showInfo={false} strokeColor={usageColor(runningPercent, 70, 90)} style={{ marginTop: 8 }} />
            )}
            {reportedCount != null && reportedCount !== runningCount && (
              <Text type="warning" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
                {t('executorDetail.inconsistent', { reported: reportedCount, running: runningCount })}
              </Text>
            )}
          </Card>
        </Col>
        <Col span={8}>
          <Card><Statistic title={t('executorDetail.totalTasks')} value={executor.totalTaskCount ?? 0} /></Card>
        </Col>
        <Col span={8}>
          <Card><Statistic title={t('executorDetail.failedTasks')} value={executor.failedTaskCount ?? 0} styles={{ content: { color: '#cf1322' } }} /></Card>
        </Col>
      </Row>

      <Card title={t('executorDetail.historyTitle')} style={{ marginTop: 16 }}>
        <Table
          rowKey="id"
          columns={execColumns}
          dataSource={executions?.items ?? []}
          loading={loadingExecutions}
          onRow={(r: ExecutorExecution) => ({
            onClick: () => navigate(`/tasks/${r.taskId}/executions/${r.id}`),
            style: { cursor: 'pointer' },
          })}
          pagination={{
            total: executions?.total,
            pageSize: 20,
            current: execPage,
            onChange: (page) => setExecPage(page),
            showTotal: (total) => t('executorDetail.history.total', { total }),
          }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('executorDetail.history.emptyList')} /> }}
        />
      </Card>

      <Modal title={t('executorDetail.editModal.title')} open={editOpen} onCancel={() => setEditOpen(false)} onOk={() => editForm.submit()} confirmLoading={updating}>
        <Form form={editForm} layout="vertical" onFinish={updateExecutor}>
          <Form.Item name="groupName" label={t('executorDetail.editModal.groupName')}><Input /></Form.Item>
          <Form.Item name="tags" label={t('executorDetail.editModal.tags')} tooltip={t('executorDetail.editModal.tagsTip')}><Select mode="tags" tokenSeparators={[',', ' ']} placeholder={t('executorDetail.editModal.tagsPlaceholder')} /></Form.Item>
          <Form.Item name="description" label={t('executorDetail.editModal.description')}><Input.TextArea /></Form.Item>
          <Form.Item name="maxConcurrentTasks" label={t('executorDetail.editModal.maxConcurrent')}><InputNumber min={1} /></Form.Item>
        </Form>
      </Modal>

      <Modal title={t('executorDetail.config.title')} open={configOpen} onCancel={() => setConfigOpen(false)} onOk={() => configForm.submit()} confirmLoading={reloading}>
        <Form form={configForm} layout="vertical" onFinish={reloadConfig}>
          <Form.Item name="maxConcurrentTasks" label={t('executorDetail.editModal.maxConcurrent')}><InputNumber min={1} /></Form.Item>
          <Form.Item name="taskTimeoutSeconds" label={t('executorDetail.config.taskTimeout')}><InputNumber min={1} /></Form.Item>
          <Form.Item name="heartbeatIntervalSeconds" label={t('executorDetail.config.heartbeatInterval')}><InputNumber min={5} /></Form.Item>
          <Form.Item name="adminApiUrl" label={t('executorDetail.config.adminApiUrl')}><Input placeholder={t('executorDetail.config.adminApiUrlPlaceholder')} /></Form.Item>
          <Form.Item name="adminApiUrlInternal" label={t('executorDetail.config.adminApiUrlInternal')}><Input placeholder={t('executorDetail.config.adminApiUrlInternalPlaceholder')} /></Form.Item>
          <Form.Item name="adminApiUrlExternal" label={t('executorDetail.config.adminApiUrlExternal')}><Input placeholder={t('executorDetail.config.adminApiUrlExternalPlaceholder')} /></Form.Item>
        </Form>
      </Modal>

      {/* AUTH-05 交接：单台轮换 Token 二次确认（受控 Modal——列出影响 + reason
          可选 ≤200 随请求体发送写审计；批量版形态见 BatchActionBar，本单台版
          增强点 = reason 输入与超限校验） */}
      <Modal
        title={t('executorDetail.rotate.confirmTitle')}
        open={rotateOpen}
        onCancel={() => setRotateOpen(false)}
        onOk={() => rotateForm.submit()}
        confirmLoading={rotating}
        okText={t('executorDetail.rotate.confirmOk')}
        okButtonProps={{ danger: true }}
        cancelText={t('executorDetail.cancel')}
        width={520}
        destroyOnHidden
      >
        <Alert
          type="warning"
          showIcon
          message={t('executorDetail.highrisk.title')}
          description={t('executorDetail.rotate.desc')}
          style={{ marginBottom: 12 }}
        />
        <Descriptions size="small" column={1} style={{ marginBottom: 12 }}>
          <Descriptions.Item label={t('executorDetail.field.executor')}>{executor.appName}</Descriptions.Item>
          <Descriptions.Item label={t('executorDetail.field.address')}><Text code>{executor.address}</Text></Descriptions.Item>
          <Descriptions.Item label={t('executorDetail.field.impact')}>{t('executorDetail.rotate.impactValue')}</Descriptions.Item>
        </Descriptions>
        <Form form={rotateForm} layout="vertical" onFinish={(v: { reason?: string }) => rotateToken(v.reason)}>
          <Form.Item
            name="reason"
            label={t('executorDetail.reasonLabel')}
            rules={[{ max: MAX_REASON_LENGTH, message: t('executorDetail.reasonMax', { max: MAX_REASON_LENGTH }) }]}
          >
            <Input.TextArea
              rows={2}
              maxLength={MAX_REASON_LENGTH}
              showCount
              placeholder={t('executorDetail.rotate.reasonPlaceholder')}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* AUTH-05 交接：删除执行器二次确认（删除不可恢复 + reason 可选写审计） */}
      <Modal
        title={t('executorDetail.remove.confirmTitle')}
        open={removeOpen}
        onCancel={() => setRemoveOpen(false)}
        onOk={() => removeForm.submit()}
        confirmLoading={removing}
        okText={t('executorDetail.remove.confirmOk')}
        okButtonProps={{ danger: true }}
        cancelText={t('executorDetail.cancel')}
        width={520}
        destroyOnHidden
      >
        <Alert
          type="warning"
          showIcon
          message={t('executorDetail.highrisk.irreversible')}
          description={t('executorDetail.remove.desc')}
          style={{ marginBottom: 12 }}
        />
        <Descriptions size="small" column={1} style={{ marginBottom: 12 }}>
          <Descriptions.Item label={t('executorDetail.field.executor')}>{executor.appName}</Descriptions.Item>
          <Descriptions.Item label={t('executorDetail.field.address')}><Text code>{executor.address}</Text></Descriptions.Item>
          <Descriptions.Item label={t('executorDetail.field.impact')}>{t('executorDetail.remove.impactValue')}</Descriptions.Item>
        </Descriptions>
        <Form form={removeForm} layout="vertical" onFinish={(v: { reason?: string }) => removeExecutor(v.reason)}>
          <Form.Item
            name="reason"
            label={t('executorDetail.reasonLabel')}
            rules={[{ max: MAX_REASON_LENGTH, message: t('executorDetail.reasonMax', { max: MAX_REASON_LENGTH }) }]}
          >
            <Input.TextArea
              rows={2}
              maxLength={MAX_REASON_LENGTH}
              showCount
              placeholder={t('executorDetail.remove.reasonPlaceholder')}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
