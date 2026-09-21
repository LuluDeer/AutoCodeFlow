import { useParams, useNavigate, Link } from 'react-router-dom';
import { Card, Descriptions, Table, Badge, Button, Modal, Form, Input, InputNumber, Select, message, Statistic, Row, Col, Progress, Typography, Breadcrumb, Empty, Tooltip, Space, Alert, Result, Tag, theme, Divider } from 'antd';
import { WarningOutlined, CopyOutlined, InfoCircleOutlined, ReloadOutlined, DeleteOutlined } from '@ant-design/icons';
// FEAT-04: 24h 资源趋势折线图（Tooltip 别名避开 antd Tooltip，DashboardPage 同法）
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartTooltip, Legend, ResponsiveContainer } from 'recharts';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { executorsApi, type ExecutorExecution } from '../api/executors';
import {
  useExecutorDetail,
  useExecutorMetrics,
  useExecutorExecutions,
  useExecutorRuntimeConfig,
  invalidateExecutorData,
} from '../api/queries';
import { getErrMsg } from '../utils/error';
// F-26（DEEP_REVIEW 0ef3bbe）：locale 单一来源 currentLocale() + 统一相对时间 formatRelativeTime()
import { currentLocale } from '../utils/locale';
import { formatRelativeTime, formatDurationShort, formatDateTime } from '../utils/timeFormat';
// P2-5（executor lifecycle audit）：心跳陈旧判定与后端判死阈值同源
import { HEARTBEAT_TIMEOUT_FALLBACK_MS, isHeartbeatStale } from '../utils/executorLiveness';
// ARCH-33（ADR-016）：pull 控制面可用性判据（UI-18 判据的修订版）
import { isControlPlaneUnavailable } from '../utils/control-plane';
// F-36（DEEP_REVIEW 0ef3bbe）：编辑弹窗字段白名单（回填/提交都不再整体快照透传）。
import { executorEditFormValues, pickExecutorEditPayload, type ExecutorEditValues } from './executor-edit';
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

// F-26（DEEP_REVIEW 0ef3bbe）：原此处自写的 relativeTime() 已删除——与
// utils/timeFormat.ts 的 formatRelativeTime() 语义重复，且无 key 回退时输出中文硬编码；
// 统一改用 formatRelativeTime（见 line 206 heartbeatText）。
//
// P2-5（executor lifecycle audit）：原本文件内还有一个硬编码 5 分钟的
// isHeartbeatStale()，而后端判死阈值是 heartbeatInterval × multiplier
// （默认 30s×3=90s）——后端判死后最长约 3.5 分钟里详情页同时显示离线
// Alert 与绿色「刚刚」。已删除本地实现，改用 utils/executorLiveness 的
// 同源判定，阈值取 GET /executors/runtime-config。

/** Returns Ant Design token color based on usage percent and thresholds.
 * F-15（DEEP_REVIEW 0ef3bbe）：语义色改由 antd token 提供（双主题自适应）。 */
type AntdToken = ReturnType<typeof theme.useToken>['token'];
function usageColor(token: AntdToken, value: number, warn = 60, danger = 80): string {
  if (value >= danger) return token.colorError;
  if (value >= warn) return token.colorWarning;
  return token.colorSuccess;
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
    ? d.toLocaleTimeString(currentLocale(), { hour12: false })
    : d.toLocaleString(currentLocale(), { hour12: false });
}

export default function ExecutorDetailPage() {
  const { t } = useTranslation();
  // F-15（DEEP_REVIEW 0ef3bbe）：语义色走 antd token，暗色主题自适应。
  const { token } = theme.useToken();
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

  // P2-5：判死阈值以后端有效配置为准（默认 90s）；端点失败回退默认值。
  const { data: runtimeConfig } = useExecutorRuntimeConfig();
  const heartbeatTimeoutMs = runtimeConfig?.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_FALLBACK_MS;

  // 写后失效：原 useRequest refresh → invalidateExecutorData（执行器面 +
  // 指标面；NETOPT-D P3-4 起不再联动任务面——删执行器不改任务定义，tasks.all
  // 过宽，低频自愈 ≤30s 由 ExecutorsPage 自身轮询承担）。
  const queryClient = useQueryClient();
  const refreshExecutor = () => void invalidateExecutorData(queryClient);

  // F-16（DEEP_REVIEW 0ef3bbe）：写操作从 ahooks useRequest 统一迁到 TanStack
  // Query useMutation（项目主栈）。onSuccess/onError 与原 useRequest 语义一一对应，
  // 写后失效仍走 invalidateExecutorData。
  const updateExecMut = useMutation({
    mutationFn: (values: ExecutorEditValues) => executorsApi.update(id!, values),
    onSuccess: () => { message.success(t('executorDetail.updateSuccess')); setEditOpen(false); refreshExecutor(); },
  });
  // F-36（DEEP_REVIEW 0ef3bbe）：onFinish 提交前按白名单裁剪——只发可编辑字段，
  // 不把整行 executor 快照（id/status/lastHeartbeat/cpuUsage 等只读/敏感字段）回传。
  const updateExecutor = (values: Record<string, unknown>) => updateExecMut.mutate(pickExecutorEditPayload(values));
  const updating = updateExecMut.isPending;

  const reloadConfigMut = useMutation({
    mutationFn: (values: Record<string, unknown>) => executorsApi.reloadConfig(id!, values),
    // NETOPT-D P2-D4: 推送配置（maxConcurrentTasks/taskTimeout/heartbeatInterval）
    // 后执行器热更生效——此前漏失效，详情页无 refetchInterval，最长滞后 30s。
    onSuccess: () => { message.success(t('executorDetail.configPushed')); setConfigOpen(false); refreshExecutor(); },
  });
  const reloadConfig = (values: Record<string, unknown>) => reloadConfigMut.mutate(values);
  const reloading = reloadConfigMut.isPending;

  // AUTH-05 交接：轮换请求体携带可选 reason（≤200，审计 executor.rotate_token）
  // NETOPT-E P3-4 / NETOPT-G P3: rotate 是执行器面写操作——onSuccess 关弹窗+
  // 展示新 token 后调用 refreshExecutor()（:146），页面级测试已锁死该刷新必须
  // 发生（executor-detail-highrisk.test.tsx 断言 invalidate ['executors']+
  // ['metrics'] 双前缀）。旧注释"从不 refreshExecutor"与实现/测试三方矛盾，
  // 已改正。
  const rotateTokenMut = useMutation({
    mutationFn: (reason?: string) => executorsApi.rotateToken(id!, reason?.trim() || undefined),
    onSuccess: (res) => {
      setRotateOpen(false);
      rotateForm.resetFields();
      refreshExecutor();
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
  });
  const rotateToken = (reason?: string) => rotateTokenMut.mutate(reason);
  const rotating = rotateTokenMut.isPending;

  // AUTH-05 交接：删除执行器（此前前端无删除入口）。reason 可选随 body 写审计
  const removeExecMut = useMutation({
    mutationFn: (reason?: string) => executorsApi.remove(id!, reason?.trim() || undefined),
    onSuccess: () => {
      message.success(t('executorDetail.remove.removeSuccess'));
      // NETOPT-C P3: remove 是执行器面终态写——此前只 navigate 完全不走失效，
      // 列表页残留已删行直到轮询自愈。与其余写操作对齐走 invalidateExecutorData。
      refreshExecutor();
      navigate('/executors');
    },
    onError: (e) => { message.error(t('executorDetail.remove.removeFail', { err: getErrMsg(e, t('executorDetail.retry')) })); },
  });
  const removeExecutor = (reason?: string) => removeExecMut.mutate(reason);
  const removing = removeExecMut.isPending;

  const setOfflineMut = useMutation({
    mutationFn: () => executorsApi.setOffline(id!),
    onSuccess: () => { message.success(t('executorDetail.offline.offlineSuccess')); refreshExecutor(); },
    // UX-11（本轮体验审查）：此前直接取 `e.message`，绕过了全站的错误消息归一。
    // axios 错误的 `message` 是 **"Request failed with status code 400"** 这类
    // 英文技术串，而后端给用户看的原因在 `response.data.message` 里（如
    // 「执行器正在运行任务，无法置为离线」）。后果：同一次失败，本页显示英文
    // 技术串，而**同一文件第 161 行**（removeExecutor）已是正确的 getErrMsg
    // 写法——同一页面两种错误文案。
    // 直接取 `e.message` 还有个隐患：`e` 若是非 Error 值（reject 了字符串或
    // 普通对象）会得到 `undefined`，页面上直接出现 "undefined"。
    onError: (e) => { message.error(t('executorDetail.offline.offlineFail', { err: getErrMsg(e) })); },
  });
  const setOffline = () => setOfflineMut.mutate();
  const settingOffline = setOfflineMut.isPending;

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
  // 补充 P2（UX-AUDIT 第 4 路）：满载语义。runningCount 达到并发上限即饱和——
  // 调度器不再向这台派发新任务；用户需把「目标执行器已饱和」与「根本没有可用执行器」区分开。
  const isSaturated = maxConcurrent > 0 && runningCount >= maxConcurrent;

  // CONSISTENCY-02: 执行器心跳上报的运行中 executionId（null = 旧版未上报）。
  // 与 runningTaskCount 交叉核对：长期不一致提示执行器计数或回调链路异常。
  const reportedIds = executor.runningExecutionIds;
  const reportedCount = reportedIds?.length;

  const heartbeatStale = executor.lastHeartbeat
    ? isHeartbeatStale(new Date(executor.lastHeartbeat).getTime(), Date.now(), heartbeatTimeoutMs)
    : false;
  const heartbeatText = executor.lastHeartbeat ? formatRelativeTime(executor.lastHeartbeat, t) : '-';
  const heartbeatAbsolute = executor.lastHeartbeat ? formatDateTime(executor.lastHeartbeat) : '';

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
    { title: t('executorDetail.history.col.task'), dataIndex: 'taskName', key: 'taskName', ellipsis: true, minWidth: 175, render: (v: string | undefined, r: ExecutorExecution) => (
      // F-33（DEEP_REVIEW 0ef3bbe）：原 <a onClick> 无 href——键盘不可达、读屏不识别；
      // 改 react-router <Link>（渲染真实 href、SPA 跳转，行为/视觉不变），保留行点击
      // 的 stopPropagation 避免双跳。
      <Link to={`/tasks/${r.taskId}/executions/${r.id}`} onClick={(e) => e.stopPropagation()}>{v || r.taskId}</Link>
    )},
    { title: t('executorDetail.history.col.status'), dataIndex: 'status', key: 'status', width: 90, render: (v: string) => {
      const cfg = statusMap[v] || { badge: 'default' as BadgeStatus, label: v };
      return <Badge status={cfg.badge} text={cfg.label} />;
    }},
    { title: t('executorDetail.history.col.startTime'), dataIndex: 'startTime', key: 'startTime', width: 170, render: (v: string) => v ? new Date(v).toLocaleString(currentLocale(), { hour12: false }) : '-' },
    // F-35（DEEP_REVIEW 0ef3bbe）：时长格式统一走 formatDurationShort（含小时档）
    { title: t('executorDetail.history.col.duration'), dataIndex: 'duration', key: 'duration', width: 90, render: (v: number) => formatDurationShort(v) },
    { title: t('executorDetail.history.col.exitCode'), dataIndex: 'exitCode', key: 'exitCode', width: 80, render: (v: number | null | undefined) => v != null ? <Text type={v !== 0 ? 'danger' : undefined} code>{v}</Text> : '-' },
    { title: t('executorDetail.history.col.error'), dataIndex: 'errorMessage', key: 'errorMessage', ellipsis: true, minWidth: 175, render: (v: string) => v ? <Text type="danger" style={{ fontSize: 12 }}>{v}</Text> : '-' },
  ];

  return (
    <div>
      <Breadcrumb
        style={{ marginBottom: 16 }}
        items={[
          { title: <Link to="/executors">{t('executorDetail.breadcrumb.list')}</Link> },
          { title: executor.appName },
        ]}
      />

      <Card
        title={t('executorDetail.title')}
        extra={
          isAdmin ? (
          // UI 打磨：头部 5 个操作按钮窄屏收纳换行（wrap + 紧凑间距），不引入 Dropdown
          <Space wrap size={4}>
            <Button.Group>
              <Button onClick={() => { editForm.setFieldsValue(executorEditFormValues(executor)); setEditOpen(true); }}>{t('executorDetail.edit')}</Button>
              {/* UI-18 → ARCH-33（ADR-016）修订：判据由「pull 模式」改为
                  「pull 且协议 < 2」。ADR-016 把控制面搬上 pull 通道后，
                  协议 v2 的 pull 执行器可以正常热更新；v1 及未上报版本的
                  pull 执行器仍必须禁用——它们会**静默忽略** commands 字段，
                  比入站失败更危险（失败可见，静默不可见）。 */}
              <Tooltip title={isControlPlaneUnavailable(executor) ? t('executorDetail.config.pullDisabledTooltip') : undefined}>
                <Button disabled={isControlPlaneUnavailable(executor)} onClick={() => setConfigOpen(true)}>{t('executorDetail.configHotReload')}</Button>
              </Tooltip>
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
            {/* 常规操作与高危操作（轮换/删除）之间的视觉分组 */}
            <Divider type="vertical" style={{ margin: 0 }} />
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
        {/* UI 打磨：列数随断点收敛（全站 Descriptions 惯例），窄屏不再三列挤压 */}
        <Descriptions column={{ xs: 1, sm: 2, md: 3 }}>
          <Descriptions.Item label={t('executorDetail.field.appName')}>{executor.appName}</Descriptions.Item>
          <Descriptions.Item label={t('executorDetail.field.address')}>{executor.address}</Descriptions.Item>
          <Descriptions.Item label={t('executorDetail.field.status')}>
            {/* P1-28：详情页此前 text={executor.status} 直接渲染裸枚举（online/offline），
                与列表页同一概念两种措辞（列表页用 execList.status.online=在线）。
                执行器状态只有 online/offline 两态（executor.entity.ts:15-16），
                直接复用列表页 i18n 键。 */}
            <Badge
              status={isOnline ? 'success' : 'default'}
              text={isOnline ? t('execList.status.online') : t('execList.status.offline')}
            />
          </Descriptions.Item>
          <Descriptions.Item label={t('executorDetail.field.type')}>{executor.type || '-'}</Descriptions.Item>
          <Descriptions.Item label={t('executorDetail.field.version')}>{executor.executorVersion || '-'}</Descriptions.Item>
          {/* UI-17/ARCH-32: 派发模式（pull = NAT 内零入站，长轮询取件） */}
          <Descriptions.Item label={t('executorDetail.field.dispatchMode')}>
            {executor.dispatchMode === 'pull'
              ? <Tag color="purple">{t('executorDetail.dispatchMode.pull')}</Tag>
              : <Tag>{t('executorDetail.dispatchMode.push')}</Tag>}
          </Descriptions.Item>
          <Descriptions.Item label={t('executorDetail.field.group')}>{executor.groupName || '-'}</Descriptions.Item>
          <Descriptions.Item label={t('executorDetail.field.tags')}>{executor.tags?.join(', ') || '-'}</Descriptions.Item>
          <Descriptions.Item label={t('executorDetail.field.maxConcurrent')}>{executor.maxConcurrentTasks ?? t('executorDetail.unlimited')}</Descriptions.Item>
          <Descriptions.Item label={t('executorDetail.field.lastHeartbeat')}>
            <Tooltip title={heartbeatAbsolute}>
              {heartbeatStale ? (
                <Text style={{ color: token.colorWarning }}>
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
          {/* P2-6（executor lifecycle audit）：Python 解释器池清单。
              后端随心跳三态上报（CONTRACT §2.2 D5）：null/缺字段 = 旧版执行器
              未上报（调度按未知处理，回退 ["3.12"]）；[] = 已上报但池内确实
              没有可用解释器（声明 runtimeVersion 的任务不应派到这台，会以
              interpreter_unavailable 失败）；非空 = 可用版本清单。此前该字段
              一直在响应体里却无任何 UI 渲染，只能在任务失败后从执行详情的
              快照里看到——派发前无核对入口。 */}
          <Descriptions.Item
            label={
              <Tooltip title={t('executorDetail.interpreters.labelTip')}>
                <span>{t('executorDetail.field.interpreters')} <InfoCircleOutlined /></span>
              </Tooltip>
            }
          >
            {executor.interpreters === undefined || executor.interpreters === null ? (
              <Tooltip title={t('executorDetail.interpreters.notReportedTip')}>
                <Text type="secondary">{t('executorDetail.notReported')} <InfoCircleOutlined /></Text>
              </Tooltip>
            ) : executor.interpreters.length === 0 ? (
              <Tooltip title={t('executorDetail.interpreters.emptyTip')}>
                <Text type="warning">
                  <WarningOutlined style={{ marginRight: 4 }} />
                  {t('executorDetail.interpreters.empty')}
                </Text>
              </Tooltip>
            ) : (
              <Space size={4} wrap>
                {executor.interpreters.map((it) => {
                  const ok = it.available !== false;
                  const tipLines = [
                    it.path ? it.path : t('executorDetail.interpreters.pathUnknown'),
                    it.discoveredAt
                      ? `${t('executorDetail.interpreters.discoveredAt')} ${formatDateTime(it.discoveredAt)}`
                      : '',
                    ok ? '' : t('executorDetail.interpreters.unavailableTip'),
                  ].filter(Boolean);
                  return (
                    <Tooltip
                      key={`${it.version}-${it.path ?? ''}`}
                      title={(
                        <div>
                          {tipLines.map((line) => <div key={line} style={{ fontSize: 12 }}>{line}</div>)}
                        </div>
                      )}
                    >
                      <Tag
                        color={ok ? 'green' : 'orange'}
                        style={{ marginInlineEnd: 0, textDecoration: ok ? undefined : 'line-through' }}
                      >
                        Python {it.version}
                      </Tag>
                    </Tooltip>
                  );
                })}
              </Space>
            )}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      {/* P1-24（UX-AUDIT-2026-09-21）：「为什么离线」必须可回答。
          旧实现只渲染一句通用文案（executorDetail.offline.alert），判死阈值
          heartbeatTimeoutMs 取到手后只用于染色、数值从不渲染，用户无法判断
          「手动下线还是超时判死？静默多久了？91s 抖动还是 3 天故障？」。
          现 Alert 带上：①判死阈值（秒）②最后心跳绝对时刻 ③已静默时长（相对）。
          注：后端区分优雅 markOffline 与 stale sweep 两条路径，但 GET /executors/:id
          响应里**没有**区分字段——不编造字段，只呈现确实可得的三个事实，由用户推断；
          后端缺口见交付报告。 */}
      {!isOnline && (
        <Alert
          type="warning"
          showIcon
          title={t('executorDetail.offline.alert')}
          description={
            <Space orientation="vertical" size={2} style={{ fontSize: 12 }}>
              {/* 遗留 P1-24：消费后端 offlineReason（manual/stale_timeout），区分
                  优雅下线与心跳超时判死——此前 GET /:id 无此字段，只能笼统说离线。 */}
              <div>
                {(executor as { offlineReason?: string | null }).offlineReason === 'manual'
                  ? t('executorDetail.offline.reasonManual')
                  : (executor as { offlineReason?: string | null }).offlineReason === 'stale_timeout'
                    ? t('executorDetail.offline.reasonStale')
                    : t('executorDetail.offline.reasonUnknown')}
              </div>
              <div>
                {t('executorDetail.offline.threshold', {
                  seconds: Math.round(heartbeatTimeoutMs / 1000),
                })}
              </div>
              {executor.lastHeartbeat && (
                <div>
                  {t('executorDetail.offline.lastSeen', {
                    absolute: heartbeatAbsolute,
                    silent: heartbeatText,
                  })}
                </div>
              )}
            </Space>
          }
          style={{ marginTop: 16 }}
        />
      )}

      {/* UI 打磨：窄屏两卡纵向堆叠（xs=24）、md 起并排且等高 */}
      <Row gutter={[16, 16]} align="stretch" style={{ marginTop: 16 }}>
        <Col xs={24} md={12}>
          <Card
            title={t('executorDetail.live.title')}
            loading={loadingMetrics && !metrics}
            style={{ height: '100%' }}
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
                  <Statistic title={title} value={value} suffix="%" precision={1} styles={{ content: { color: usageColor(token, value, warn, danger) } }} />
                  <Progress percent={Math.round(value)} showInfo={false} strokeColor={usageColor(token, value, warn, danger)} style={{ marginTop: 8 }} />
                </Col>
              ))}
            </Row>
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card title={t('executorDetail.stats.title')} loading={loadingMetrics && !metrics} style={{ height: '100%' }}>
            {metrics ? (
              <Row gutter={16}>
                <Col span={8}><Statistic title={t('executorDetail.stats.totalExecutions')} value={metrics.sevenDayStats.totalExecutions} /></Col>
                <Col span={8}>
                  <Statistic title={t('executorDetail.stats.successRate')} value={metrics.sevenDayStats.successRate} suffix="%" styles={{ content: { color: token.colorSuccess } }} precision={1} />
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

      {/* UI 打磨：窄屏三卡纵向堆叠（xs=24）、sm 起三等分且等高 */}
      <Row gutter={[16, 16]} align="stretch" style={{ marginTop: 16 }}>
        <Col xs={24} sm={8}>
          <Card style={{ height: '100%' }}>
            <Statistic title={t('executorDetail.currentRunning')} value={runningCount} suffix={`/ ${executor.maxConcurrentTasks ?? '∞'}`} />
            {maxConcurrent > 0 && (
              <>
                <Progress percent={runningPercent} strokeColor={usageColor(token, runningPercent, 70, 90)} style={{ marginTop: 8 }} />
                {isSaturated && (
                  <Text type="warning" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
                    {t('executorDetail.saturated')}
                  </Text>
                )}
              </>
            )}
            {reportedCount != null && reportedCount !== runningCount && (
              <Text type="warning" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
                {t('executorDetail.inconsistent', { reported: reportedCount, running: runningCount })}
              </Text>
            )}
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card style={{ height: '100%' }}><Statistic title={t('executorDetail.totalTasks')} value={executor.totalTaskCount ?? 0} /></Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card style={{ height: '100%' }}><Statistic title={t('executorDetail.failedTasks')} value={executor.failedTaskCount ?? 0} styles={{ content: { color: token.colorError } }} /></Card>
        </Col>
      </Row>

      <Card title={t('executorDetail.historyTitle')} style={{ marginTop: 16 }}>
        <Table
          rowKey="id"
          columns={execColumns}
          dataSource={executions?.items ?? []}
          loading={loadingExecutions}
          // UI 打磨：固定列合计 430 + 两个弹性列（任务名/错误摘要）最小 ≈175 → 窄屏横向滚动兜底
          scroll={{ x: 780 }}
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
