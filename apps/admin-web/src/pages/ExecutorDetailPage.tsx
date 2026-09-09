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
    { manual: true, onSuccess: () => { message.success('更新成功'); setEditOpen(false); refreshExecutor(); } },
  );

  const { run: reloadConfig, loading: reloading } = useRequest(
    (values) => executorsApi.reloadConfig(id!, values),
    { manual: true, onSuccess: () => { message.success('配置已推送'); setConfigOpen(false); } },
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
          title: '新Token（请妥善保存，关闭后不再显示）',
          content: (
            <Space>
              <Text code copyable={{ text: res.token }}>{res.token}</Text>
            </Space>
          ),
        });
      },
      onError: (e) => { message.error(`轮换失败：${getErrMsg(e, '请重试')}`); },
    },
  );

  // AUTH-05 交接：删除执行器（此前前端无删除入口）。reason 可选随 body 写审计
  const { run: removeExecutor, loading: removing } = useRequest(
    (reason?: string) => executorsApi.remove(id!, reason?.trim() || undefined),
    {
      manual: true,
      onSuccess: () => {
        message.success('执行器已删除');
        navigate('/executors');
      },
      onError: (e) => { message.error(`删除失败：${getErrMsg(e, '请重试')}`); },
    },
  );

  const { run: setOffline, loading: settingOffline } = useRequest(
    () => executorsApi.setOffline(id!),
    {
      manual: true,
      onSuccess: () => { message.success('执行器已设置为离线'); refreshExecutor(); },
      onError: (e) => { message.error(`设置失败：${e.message}`); },
    },
  );

  // UI-08：首屏骨架屏替代裸 Spin
  if (loadingExecutor && !executor) return <PageSkeleton variant="table" rows={6} style={{ padding: 24 }} />;
  // U7: 请求失败 ≠ 执行器不存在——错误态给重试入口，数据确空才显示 Empty
  if (!executor && executorError) {
    return (
      <Result
        status="error"
        title="执行器详情加载失败"
        subTitle={getErrMsg(executorError, '请求失败，请重试')}
        extra={
          <Space>
            <Button onClick={() => navigate('/executors')}>返回执行器列表</Button>
            <Button type="primary" icon={<ReloadOutlined />} onClick={refreshExecutor}>重试</Button>
          </Space>
        }
      />
    );
  }
  if (!executor) return <div style={{ padding: 80 }}><Empty description="执行器不存在或已被删除" /></div>;

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
  const STATUS_MAP: Record<string, { badge: BadgeStatus; label: string }> = {
    pending:   { badge: 'default',    label: '等待中' },
    running:   { badge: 'processing', label: '运行中' },
    success:   { badge: 'success',    label: '成功'   },
    failed:    { badge: 'error',      label: '失败'   },
    timeout:   { badge: 'warning',    label: '超时'   },
    killed:    { badge: 'error',      label: '已终止' },
    cancelled: { badge: 'default',    label: '已取消' },
  };
  const execColumns = [
    // U10: 补任务名/退出码列，行点击直达执行详情页
    { title: '任务', dataIndex: 'taskName', key: 'taskName', ellipsis: true, render: (v: string | undefined, r: ExecutorExecution) => (
      <a onClick={(e) => { e.stopPropagation(); navigate(`/tasks/${r.taskId}/executions/${r.id}`); }}>{v || r.taskId}</a>
    )},
    { title: '状态', dataIndex: 'status', key: 'status', width: 90, render: (v: string) => {
      const cfg = STATUS_MAP[v] || { badge: 'default' as BadgeStatus, label: v };
      return <Badge status={cfg.badge} text={cfg.label} />;
    }},
    { title: '开始时间', dataIndex: 'startTime', key: 'startTime', width: 170, render: (v: string) => v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '-' },
    { title: '耗时', dataIndex: 'duration', key: 'duration', width: 90, render: (v: number) => v != null ? (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`) : '-' },
    { title: '退出码', dataIndex: 'exitCode', key: 'exitCode', width: 80, render: (v: number | null | undefined) => v != null ? <Text type={v !== 0 ? 'danger' : undefined} code>{v}</Text> : '-' },
    { title: '错误', dataIndex: 'errorMessage', key: 'errorMessage', ellipsis: true, render: (v: string) => v ? <Text type="danger" style={{ fontSize: 12 }}>{v}</Text> : '-' },
  ];

  return (
    <div>
      <Breadcrumb
        style={{ marginBottom: 16 }}
        items={[
          { title: <a onClick={() => navigate('/executors')}>执行器列表</a> },
          { title: executor.appName },
        ]}
      />

      <Card
        title="执行器详情"
        extra={
          isAdmin ? (
          <Space>
            <Button.Group>
              <Button onClick={() => { editForm.setFieldsValue(executor); setEditOpen(true); }}>编辑</Button>
              <Button onClick={() => setConfigOpen(true)}>配置热更新</Button>
              <Button
                danger
                disabled={!isOnline}
                loading={settingOffline}
                onClick={() => {
                  Modal.confirm({
                    title: '确认设置离线',
                    content: '将该执行器标记为离线，正在运行的任务不会被中断。确认继续？',
                    okText: '确认',
                    cancelText: '取消',
                    onOk: setOffline,
                  });
                }}
              >
                设置离线
              </Button>
            </Button.Group>
            <Tooltip title="轮换后旧Token 立即失效">
              <Button
                danger
                icon={<CopyOutlined />}
                onClick={() => { rotateForm.resetFields(); setRotateOpen(true); }}
              >轮换 Token</Button>
            </Tooltip>
            {/* AUTH-05 交接：删除执行器入口（高危，与列表批量操作互补的单台形态） */}
            <Tooltip title="删除后需执行器重新注册">
              <Button
                danger
                icon={<DeleteOutlined />}
                onClick={() => { removeForm.resetFields(); setRemoveOpen(true); }}
              >删除</Button>
            </Tooltip>
          </Space>
          ) : undefined
        }
      >
        <Descriptions column={3}>
          <Descriptions.Item label="AppName">{executor.appName}</Descriptions.Item>
          <Descriptions.Item label="地址">{executor.address}</Descriptions.Item>
          <Descriptions.Item label="状态">
            <Badge status={isOnline ? 'success' : 'default'} text={executor.status} />
          </Descriptions.Item>
          <Descriptions.Item label="类型">{executor.type || '-'}</Descriptions.Item>
          <Descriptions.Item label="版本">{executor.executorVersion || '-'}</Descriptions.Item>
          <Descriptions.Item label="分组">{executor.groupName || '-'}</Descriptions.Item>
          <Descriptions.Item label="标签">{executor.tags?.join(', ') || '-'}</Descriptions.Item>
          <Descriptions.Item label="最大并发">{executor.maxConcurrentTasks ?? '无限制'}</Descriptions.Item>
          <Descriptions.Item label="最后心跳（进页快照）">
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
          <Descriptions.Item label="描述" span={2}>{executor.description || '-'}</Descriptions.Item>
          <Descriptions.Item label="运行中执行（活性上报 · 进页快照）">
            {reportedIds === undefined || reportedIds === null ? (
              <Tooltip title="该执行器版本未上报运行中执行列表，stale 扫描对其不启用活性跳过">
                <Text type="secondary">未上报 <InfoCircleOutlined /></Text>
              </Tooltip>
            ) : reportedCount === 0 ? (
              <Text type="secondary">0（空闲）</Text>
            ) : (
              <Tooltip title={
                <div style={{ maxHeight: 240, overflowY: 'auto' }}>
                  {reportedIds.map((eid) => (
                    <div key={eid} style={{ fontFamily: 'monospace', fontSize: 12 }}>{eid}</div>
                  ))}
                </div>
              }>
                <Text>{reportedCount} 条 <InfoCircleOutlined /></Text>
              </Tooltip>
            )}
          </Descriptions.Item>
          {/* U16: 死信积压——回调持续失败的载荷落盘执行器本地 dead-letter */}
          <Descriptions.Item label="死信积压（活性上报 · 进页快照）">
            {executor.deadLetterCount === undefined || executor.deadLetterCount === null ? (
              <Tooltip title="该执行器版本未上报死信积压数（node ab4971f / python 001 起上报）">
                <Text type="secondary">未上报 <InfoCircleOutlined /></Text>
              </Tooltip>
            ) : executor.deadLetterCount === 0 ? (
              <Text type="success">0（无积压）</Text>
            ) : (
              <Tooltip title="回调持续失败已落盘执行器本地 dead-letter，需人工排查">
                <Text type="warning">
                  <WarningOutlined style={{ marginRight: 4 }} />
                  {executor.deadLetterCount} 条待重试 <InfoCircleOutlined />
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
          message="执行器离线，以下指标为最后一次心跳的缓存数据，可能已过期"
          style={{ marginTop: 16 }}
        />
      )}

      <Row gutter={16} style={{ marginTop: 16 }}>
        <Col span={12}>
          <Card
            title="实时资源使用"
            loading={loadingMetrics && !metrics}
            extra={<Text type="secondary" style={{ fontSize: 12 }}>每 30s 轮询</Text>}
          >
            <Row gutter={16}>
              {([
                { title: 'CPU 使用率', value: liveCpu, warn: 60, danger: 80 },
                { title: '内存使用率', value: liveMem, warn: 60, danger: 80 },
                // diskUsage 不在 metrics 接口内：仍取进页快照
                { title: '磁盘使用率', value: executor.diskUsage ?? 0, warn: 70, danger: 90 },
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
          <Card title="性能统计（近7天）" loading={loadingMetrics && !metrics}>
            {metrics ? (
              <Row gutter={16}>
                <Col span={8}><Statistic title="总执行次数" value={metrics.sevenDayStats.totalExecutions} /></Col>
                <Col span={8}>
                  <Statistic title="成功率" value={metrics.sevenDayStats.successRate} suffix="%" styles={{ content: { color: '#3f8600' } }} precision={1} />
                  <Text type="secondary" style={{ fontSize: 12 }}>成功 {metrics.sevenDayStats.successful} / 失败 {metrics.sevenDayStats.failed}</Text>
                </Col>
                <Col span={8}><Statistic title="平均耗时" value={metrics.sevenDayStats.averageDurationMs} suffix="ms" precision={0} /></Col>
              </Row>
            ) : (
              !loadingMetrics && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无性能数据，执行任务后将在此显示统计信息" />
            )}
          </Card>
        </Col>
      </Row>

      {/* FEAT-04: 24h 资源趋势——CPU/内存（左轴 %）与并发任务数（右轴）。
          数据随 metrics 端点 30s 轮询顺带刷新（后端 15 分钟聚合桶，变化慢）；
          空数据显示显式空态（执行器新建或历史采样未启用时为常态）。 */}
      <Card
        title="资源趋势（24h）"
        style={{ marginTop: 16 }}
        loading={loadingMetrics && !metrics}
        extra={<Text type="secondary" style={{ fontSize: 12 }}>15 分钟均值聚合 · 最多 96 点</Text>}
      >
        {historyPoints.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无历史采样" />
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
              <Line yAxisId="pct" type="monotone" dataKey="memUsage" name="内存 %" stroke={CHART_COLORS.memory} strokeWidth={1.5} dot={false} connectNulls />
              <Line yAxisId="cnt" type="monotone" dataKey="runningTaskCount" name="并发任务" stroke={CHART_COLORS.concurrent} strokeWidth={1.5} dot={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        )}
      </Card>

      <Row gutter={16} style={{ marginTop: 16 }}>
        <Col span={8}>
          <Card>
            <Statistic title="当前运行任务" value={runningCount} suffix={`/ ${executor.maxConcurrentTasks ?? '∞'}`} />
            {maxConcurrent > 0 && (
              <Progress percent={runningPercent} showInfo={false} strokeColor={usageColor(runningPercent, 70, 90)} style={{ marginTop: 8 }} />
            )}
            {reportedCount != null && reportedCount !== runningCount && (
              <Text type="warning" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
                活性上报 {reportedCount} 条，与运行计数 {runningCount} 不一致
              </Text>
            )}
          </Card>
        </Col>
        <Col span={8}>
          <Card><Statistic title="总执行任务数" value={executor.totalTaskCount ?? 0} /></Card>
        </Col>
        <Col span={8}>
          <Card><Statistic title="失败任务数" value={executor.failedTaskCount ?? 0} styles={{ content: { color: '#cf1322' } }} /></Card>
        </Col>
      </Row>

      <Card title="历史任务执行" style={{ marginTop: 16 }}>
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
            showTotal: (total) => `共${total} 条`,
          }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该执行器暂无历史执行记录" /> }}
        />
      </Card>

      <Modal title="编辑执行器" open={editOpen} onCancel={() => setEditOpen(false)} onOk={() => editForm.submit()} confirmLoading={updating}>
        <Form form={editForm} layout="vertical" onFinish={updateExecutor}>
          <Form.Item name="groupName" label="分组名称"><Input /></Form.Item>
          <Form.Item name="tags" label="标签" tooltip="输入标签名后按回车添加"><Select mode="tags" tokenSeparators={[',', ' ']} placeholder="输入后回车添加" /></Form.Item>
          <Form.Item name="description" label="描述"><Input.TextArea /></Form.Item>
          <Form.Item name="maxConcurrentTasks" label="最大并发数"><InputNumber min={1} /></Form.Item>
        </Form>
      </Modal>

      <Modal title="配置热更新" open={configOpen} onCancel={() => setConfigOpen(false)} onOk={() => configForm.submit()} confirmLoading={reloading}>
        <Form form={configForm} layout="vertical" onFinish={reloadConfig}>
          <Form.Item name="maxConcurrentTasks" label="最大并发数"><InputNumber min={1} /></Form.Item>
          <Form.Item name="taskTimeoutSeconds" label="任务超时(秒)"><InputNumber min={1} /></Form.Item>
          <Form.Item name="heartbeatIntervalSeconds" label="心跳间隔(秒)"><InputNumber min={5} /></Form.Item>
          <Form.Item name="adminApiUrl" label="Admin API地址"><Input placeholder="默认 Admin API 地址" /></Form.Item>
          <Form.Item name="adminApiUrlInternal" label="Admin API内部地址"><Input placeholder="执行器容器/内网访问地址" /></Form.Item>
          <Form.Item name="adminApiUrlExternal" label="Admin API外部地址"><Input placeholder="执行器回调优先使用的公网地址" /></Form.Item>
        </Form>
      </Modal>

      {/* AUTH-05 交接：单台轮换 Token 二次确认（受控 Modal——列出影响 + reason
          可选 ≤200 随请求体发送写审计；批量版形态见 BatchActionBar，本单台版
          增强点 = reason 输入与超限校验） */}
      <Modal
        title="确认轮换 Token"
        open={rotateOpen}
        onCancel={() => setRotateOpen(false)}
        onOk={() => rotateForm.submit()}
        confirmLoading={rotating}
        okText="确认轮换"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        width={520}
        destroyOnHidden
      >
        <Alert
          type="warning"
          showIcon
          message="高危操作"
          description="轮换后旧 Token 立即失效，该执行器将短暂重新注册后恢复连接（node/python 执行器在一个心跳间隔内自动对齐）。新 Token 仅在结果弹窗中展示一次。"
          style={{ marginBottom: 12 }}
        />
        <Descriptions size="small" column={1} style={{ marginBottom: 12 }}>
          <Descriptions.Item label="执行器">{executor.appName}</Descriptions.Item>
          <Descriptions.Item label="地址"><Text code>{executor.address}</Text></Descriptions.Item>
          <Descriptions.Item label="影响">Token 将轮换，执行器短暂重新注册</Descriptions.Item>
        </Descriptions>
        <Form form={rotateForm} layout="vertical" onFinish={(v: { reason?: string }) => rotateToken(v.reason)}>
          <Form.Item
            name="reason"
            label="操作原因（可选，记录到审计日志）"
            rules={[{ max: MAX_REASON_LENGTH, message: `原因不能超过 ${MAX_REASON_LENGTH} 个字符` }]}
          >
            <Input.TextArea
              rows={2}
              maxLength={MAX_REASON_LENGTH}
              showCount
              placeholder="如：token 疑似泄露 / 例行轮换"
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* AUTH-05 交接：删除执行器二次确认（删除不可恢复 + reason 可选写审计） */}
      <Modal
        title="确认删除执行器"
        open={removeOpen}
        onCancel={() => setRemoveOpen(false)}
        onOk={() => removeForm.submit()}
        confirmLoading={removing}
        okText="确认删除"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        width={520}
        destroyOnHidden
      >
        <Alert
          type="warning"
          showIcon
          message="高危操作 · 不可恢复"
          description="删除后该执行器记录将永久移除，正在其上运行的任务不受影响但不再派发；执行器需重新注册才能恢复接入。"
          style={{ marginBottom: 12 }}
        />
        <Descriptions size="small" column={1} style={{ marginBottom: 12 }}>
          <Descriptions.Item label="执行器">{executor.appName}</Descriptions.Item>
          <Descriptions.Item label="地址"><Text code>{executor.address}</Text></Descriptions.Item>
          <Descriptions.Item label="影响">执行器记录删除，需重新注册</Descriptions.Item>
        </Descriptions>
        <Form form={removeForm} layout="vertical" onFinish={(v: { reason?: string }) => removeExecutor(v.reason)}>
          <Form.Item
            name="reason"
            label="操作原因（可选，记录到审计日志）"
            rules={[{ max: MAX_REASON_LENGTH, message: `原因不能超过 ${MAX_REASON_LENGTH} 个字符` }]}
          >
            <Input.TextArea
              rows={2}
              maxLength={MAX_REASON_LENGTH}
              showCount
              placeholder="如：主机已下线 / 迁移至新机器"
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
