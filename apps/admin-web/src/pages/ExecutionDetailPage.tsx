import { Tag, Typography, Button, Space, Badge, Alert, Popconfirm, Result, Tabs, theme, Modal, Card } from 'antd';
import { message } from '../utils/toast';
import { ArrowLeftOutlined, SyncOutlined, RedoOutlined, StopOutlined, RobotOutlined, FieldTimeOutlined, AppstoreOutlined, BookOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { tasksApi } from '../api/tasks';
import {
  useExecutionDetail,
  useExecutionReport,
  useExecutionRetryChain,
  useTaskDetail,
  invalidateExecutionData,
} from '../api/queries';
import { getErrMsg } from '../utils/error';
import { useTranslation } from 'react-i18next';
import '../i18n';
// OBS-04: 分析报告/时间线面板（核心展示逻辑独立成组件文件，便于单独测试）
import ExecutionReportPanel from '../components/ExecutionReportPanel';
import PageHeader from '../components/PageHeader';
import PageSkeleton from '../components/PageSkeleton';
// FEAT-05 UI 半场：产物列表（003 产出组件，本任务作为「参数与产物」Tab 单点接入）
import ArtifactsList from '../components/ArtifactsList';
// REFACTOR-EXEC-01/02/03：信息卡 / 重试链 / 日志子系统（本页只保留编排与页级动作）
import ExecutionInfoCard from '../components/ExecutionInfoCard';
import ExecutionRetryChain from '../components/ExecutionRetryChain';
import ExecutionLogSection from '../components/ExecutionLogSection';
// CORE-02: 重试链纯逻辑（Card 迁入重试 Tab 时沿用）
import { buildRetryChain, nextPendingRetryAt, type RetryChainLink } from './retry-chain';

// REFACTOR-EXEC-01 兼容导出：ui09-mobile-pages.test 从本页锚定列数配置
// （常量的事实源已随信息卡迁至 components/ExecutionInfoCard.tsx）。
export { UI09_DESCRIPTIONS_COLUMN } from '../components/ExecutionInfoCard';

// REFACTOR-EXEC-01 兼容导出：ui09-mobile-pages.test 从本页锚定列数配置
// （常量的事实源已随信息卡迁至 components/ExecutionInfoCard.tsx）。

const { Text } = Typography;

const STATUS_MAP = (t: (k: string) => string): Record<string, { color: string; label: string }> => ({
  pending: { color: 'default', label: t('execDetail.status.pending') },
  running: { color: 'processing', label: t('execDetail.status.running') },
  success: { color: 'green', label: t('execDetail.status.success') },
  failed: { color: 'red', label: t('execDetail.status.failed') },
  timeout: { color: 'orange', label: t('execDetail.status.timeout') },
  killed: { color: 'volcano', label: t('execDetail.status.killed') },
  cancelled: { color: 'default', label: t('execDetail.status.cancelled') },
});

// UI-05: Tab key 与 URL ?tab= 双向记忆（ApplicationDetailPage 先例）——
// 刷新/分享链接回到原 Tab；非法值回退默认 Tab（日志）。
const TAB_KEY_DEFAULT = 'logs';
const TAB_KEYS = ['logs', 'report', 'retry', 'context'] as const;
type TabKey = (typeof TAB_KEYS)[number];

function normalizeTabKey(raw: string | null): TabKey {
  return (TAB_KEYS as readonly string[]).includes(raw || '') ? (raw as TabKey) : TAB_KEY_DEFAULT;
}

export default function ExecutionDetailPage() {
  const { t } = useTranslation();
  // F-15（DEEP_REVIEW 0ef3bbe）：语义色/边框走 antd token，暗色主题自适应。
  const { token: antdToken } = theme.useToken();
  const statusMap = STATUS_MAP(t);
  const { taskId, execId } = useParams<{ taskId: string; execId: string }>();
  const nav = useNavigate();
  const [retrying, setRetrying] = useState(false);
  // P1-26：重新触发确认 Modal 可见性
  const [retriggerOpen, setRetriggerOpen] = useState(false);
  const [killing, setKilling] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  // REFACTOR-EXEC-03：SSE 生命周期由 ExecutionLogSection 上报（页头「实时更新」
  // 徽标与断流告警条的消费端在页头，DOM 位置无法随日志子系统迁移）。
  const [streamStatus, setStreamStatus] = useState({ streaming: false, disconnected: false });
  const handleStreamStatusChange = useCallback((s: { streaming: boolean; disconnected: boolean }) => {
    setStreamStatus((prev) => (prev.streaming === s.streaming && prev.disconnected === s.disconnected ? prev : s));
  }, []);
  // 断流告警「重新连接」：递增键 → 日志子系统重建 SSE（内部自行复位断流标记）
  const [reconnectKey, setReconnectKey] = useState(0);

  // UI-05: Tab 记忆走 searchParams（?tab=），与 ApplicationDetailPage 同款；
  // 页面自身路由无 hash 语义冲突，选实现稳的 searchParams 方案。
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = normalizeTabKey(searchParams.get('tab'));

  // FEAT-17: 主执行数据换 useExecutionDetail（queryKey 带 taskId+execId，
  // 等价 refreshDeps）；refresh 语义保留给 SSE done/断流轮询兜底调用方。
  const { data, refetch: refresh, isLoading: loading, error } = useExecutionDetail(taskId, execId);
  const queryClient = useQueryClient();
  const isLive = data?.status === 'running' || data?.status === 'pending';

  // ===== UI-05: 重试链数据（CORE-02 语义原样迁移，Card 移入「重试链」Tab）=====
  // FEAT-17: 任务详情与兄弟执行列表均由 Query 管理，切页/卸载时共享
  // Query AbortSignal 取消底层 axios 请求。
  const { data: taskData } = useTaskDetail(taskId);
  const { data: siblingPage } = useExecutionRetryChain(taskId);
  const siblings = useMemo(() => siblingPage?.items ?? [], [siblingPage]);

  const retryChain: RetryChainLink[] = useMemo(
    () => (data ? buildRetryChain(siblings, { id: data.id, retryCount: data.retryCount ?? 0 }) : []),
    [siblings, data],
  );
  const pendingRetry = useMemo(() => nextPendingRetryAt(retryChain), [retryChain]);
  const taskMaxRetry = taskData?.maxRetry ?? 0;

  // ===== OBS-04: 分析报告 / 时间线 =====
  // 一次性拉取 report 端点（execution 行 + DB 时间戳映射的 timeline +
  // execution_reports 当日聚合行；缺行 report=null 属正常态，面板内降级）。
  // Query 在路由切换/卸载时将 signal 传到底层 axios。
  const {
    data: reportPayload,
    isLoading: reportLoading,
    error: reportErr,
    refetch: refreshReport,
  } = useExecutionReport(taskId, execId);
  const reportError = reportErr ? getErrMsg(reportErr, t('execDetail.reportLoadFail')) : null;
  // F-17（DEEP_REVIEW 0ef3bbe）：修复挂载即双发 report。useExecutionReport 的
  // useQuery 已在挂载时首取一次；旧 effect 在 deps 里无条件 refreshReport()，
  // mount 即再发一废请求。现用 ref 跳过首帧（prevStatus 初始 undefined），
  // 仅在执行状态真正变化时重拉 report（running→success 等）。
  const prevReportStatusRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const status = data?.status;
    if (prevReportStatusRef.current === undefined) {
      prevReportStatusRef.current = status;
      return;
    }
    if (prevReportStatusRef.current !== status) {
      prevReportStatusRef.current = status;
      void refreshReport();
    }
  }, [data?.status, refreshReport]);

  const handleKill = async () => {
    setKilling(true);
    try {
      await tasksApi.killExecution(taskId!, execId!);
      message.success(t('execDetail.killed'));
      refresh();
      // NETOPT-C P2-4: kill 是终态写——只 refetch 本行的话，跳回 /executions
      // 该行仍显示 running（详情页无 SSE 消费者）。与 ExecutionsPage 对齐，
      // 双面失效（executions.all + metrics.all）。
      await invalidateExecutionData(queryClient);
    } catch (err: unknown) {
      message.error(getErrMsg(err, t('execDetail.killFail')));
    } finally {
      setKilling(false);
    }
  };

  // P1-26（UX-AUDIT-2026-09-21）：「重新触发」此前静默丢弃本次执行参数
  // （trigger(taskId!) 不传第二参 params），且成功后立刻 nav() 离开现场。
  // 现：① 携带本次执行的 params 重跑；② 触发前 Modal 告知参数差异；③ 不再自动导航。
  const openRetrigger = () => setRetriggerOpen(true);
  const doRetrigger = async () => {
    setRetrying(true);
    try {
      await tasksApi.trigger(taskId!, data?.params ?? undefined);
      message.success(t('execDetail.retriggered'));
      setRetriggerOpen(false);
    } catch (err: unknown) {
      message.error(getErrMsg(err, t('execDetail.triggerFail')));
    } finally {
      setRetrying(false);
    }
  };

  // P1-26：本次执行参数 vs 任务当前默认参数，供 Modal 内展示差异。
  const retriggerThisParams = data?.params && Object.keys(data.params).length > 0 ? data.params : null;
  const retriggerDefaultParams = taskData?.params && Object.keys(taskData.params).length > 0 ? taskData.params : null;
  const retriggerParamsDiffer = retriggerThisParams != null
    && JSON.stringify(retriggerThisParams) !== JSON.stringify(retriggerDefaultParams ?? {});

  if (loading && !data) {
    // UI-08：首屏骨架屏替代裸 Spin（仅此加载区块；Tab 结构与业务 JSX 不动）
    return <PageSkeleton variant="table" rows={6} style={{ padding: 24 }} />;
  }

  // U7: 请求失败 ≠ 记录不存在——给出错误态与重试，而非全 '-' 空壳
  if (!data && error) {
    return (
      <Result
        status="error"
        title={t('execDetail.loadErrorTitle')}
        subTitle={getErrMsg(error, t('execDetail.loadErrorDesc'))}
        extra={
          <Space>
            <Button onClick={() => nav(`/tasks/${taskId}`)}>{t('execDetail.backToTask')}</Button>
            <Button type="primary" icon={<SyncOutlined />} onClick={() => void refresh()}>{t('execDetail.retry')}</Button>
          </Space>
        }
      />
    );
  }

  const status = statusMap[data?.status || ''] || { color: 'default', label: data?.status };

  /** UI-05: Tab 切换写回 ?tab=（非法值 normalize 已兜底） */
  const handleTabChange = (key: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', normalizeTabKey(key));
      return next;
    }, { replace: true });
  };

  return (
    // UI-09：页面根类承载窄屏工具类作用域（面包屑收缩/工具条换行见 index.css）
    <div className="ui09-exec-detail">
      {/* UI-03：页头标准化（面包屑/返回/状态标签/操作按钮迁入 PageHeader；
          终止/重新触发/AI 分析/刷新原样保留于 extra，语义不变） */}
      <PageHeader
        title={t('execDetail.title')}
        description={
          data?.taskName ? (
            <span className="ui09-pageheader-description" title={data.taskName}>
              {data.taskName}
            </span>
          ) : undefined
        }
        breadcrumb={[
          { title: t('execDetail.breadcrumb.executions'), to: '/executions' },
          // UI-09：超长不可断任务名（构建号/英文长名）会撑破面包屑（li
          // min-width:auto 不收缩），窄屏由 .ui09-crumb-ellipsis 收敛为省略号
          { title: <span className="ui09-crumb-ellipsis" title={data?.taskName}>{data?.taskName || t('execDetail.breadcrumb.taskFallback')}</span> },
          { title: t('execDetail.title') },
        ]}
        extra={
          <>
            <Button icon={<ArrowLeftOutlined />} onClick={() => nav(`/tasks/${taskId}`)}>{t('execDetail.backToTask')}</Button>
            <Tag color={status.color} style={{ fontSize: 14, padding: '2px 10px' }}>
              {status.label}
            </Tag>
            {data?.status === 'running' && !streamStatus.disconnected && (
              <Badge status="processing" text={<Text type="secondary">{t('execDetail.liveUpdating')}</Text>} />
            )}
            {(data?.status === 'running' || data?.status === 'pending') && (
              <Popconfirm
                title={t('execDetail.killConfirmTitle')}
                description={t('execDetail.killConfirmDesc')}
                onConfirm={handleKill}
                okText={t('execDetail.killAction')} okButtonProps={{ danger: true }}
              >
                <Button
                  icon={<StopOutlined />}
                  danger
                  loading={killing}
                >
                  {t('execDetail.killButton')}
                </Button>
              </Popconfirm>
            )}
            {data?.status === 'failed' && (
              <Button
                icon={<RedoOutlined />}
                type="primary"
                danger
                loading={retrying}
                onClick={openRetrigger}
              >
                {t('execDetail.retrigger')}
              </Button>
            )}
            {(data?.status === 'failed' || data?.status === 'timeout') && (
              <Button
                icon={<RobotOutlined />}
                loading={analyzing}
                onClick={async () => {
                  setAnalyzing(true);
                  try {
                    await tasksApi.analyzeExecution(taskId!, execId!);
                    message.success(t('execDetail.aiAnalyzeDone'));
                    refresh();
                  } catch (err: unknown) {
                    message.error(getErrMsg(err, t('execDetail.aiAnalyzeFail')));
                  } finally {
                    setAnalyzing(false);
                  }
                }}
              >
                {t('execDetail.aiAnalyze')}
              </Button>
            )}
            <Button icon={<SyncOutlined />} onClick={() => void refresh()} loading={loading}>{t('execDetail.refresh')}</Button>
          </>
        }
      />

      {streamStatus.disconnected && isLive && (
        <Alert
          type="warning"
          showIcon
          title={t('execDetail.streamDisconnected')}
          style={{ marginBottom: 16 }}
          action={
            <Button
              size="small"
              icon={<SyncOutlined />}
              onClick={() => { setReconnectKey((k) => k + 1); refresh(); }}
            >
              {t('execDetail.reconnect')}
            </Button>
          }
        />
      )}

      {/* UI-05: 信息卡保留 Tab 外顶部——执行状态/耗时/执行器常驻视野
          （REFACTOR-EXEC-01：展示逻辑在 ExecutionInfoCard，本页只传数据） */}
      <ExecutionInfoCard taskId={taskId!} data={data} />

      {/* UI-05: Tab 化信息架构——日志（默认）/时间线·报告/重试链/参数与产物 */}
      <Tabs
        activeKey={activeTab}
        onChange={handleTabChange}
        data-testid="execution-detail-tabs"
        items={[
          {
            key: 'logs',
            label: <span data-testid="tab-label-logs">{t('execDetail.tab.logs')}</span>,
            // REFACTOR-EXEC-03：日志子系统（SSE 流/级别过滤/完整日志/窗口化渲染/
            // 失败定位卡片）整体在 ExecutionLogSection，本页只传接缝 props。
            children: (
              <ExecutionLogSection
                taskId={taskId!}
                execId={execId!}
                data={data}
                refresh={refresh}
                isLive={isLive}
                onStreamStatusChange={handleStreamStatusChange}
                reconnectKey={reconnectKey}
                runbookText={taskData?.runbook || null}
                statusLabel={status.label}
                onRetrigger={openRetrigger}
                retriggering={retrying}
                onJumpToReport={() => handleTabChange('report')}
              />
            ),
          },
          {
            key: 'report',
            label: <span data-testid="tab-label-report"><FieldTimeOutlined /> {t('execDetail.tab.report')}</span>,
            children: (
              <>
                {data?.aiAnalysis && (
                  <Card
                    title={t('execDetail.report.aiAnalysisTitle')}
                    style={{ borderColor: antdToken.colorPrimary, marginBottom: 16 }}
                    styles={{ header: { background: `linear-gradient(90deg, ${antdToken.colorPrimaryBg}, ${antdToken.colorPrimaryBgHover})`, color: antdToken.colorPrimary } }}
                  >
                    <Text style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.8 }}>
                      {data.aiAnalysis}
                    </Text>
                  </Card>
                )}
                {/* OBS-04: 分析报告 / 时间线——核心逻辑在独立组件 ExecutionReportPanel
                    （时间线映射/AI 分析段/当日报告段），本页仅做一次数据拉取与
                    最小挂载（原页尾纵向堆叠整体迁入本 Tab）。 */}
                <ExecutionReportPanel
                  payload={reportPayload}
                  loadError={reportError}
                  loading={reportLoading}
                />
              </>
            ),
          },
          {
            key: 'retry',
            label: <span data-testid="tab-label-retry">{t('execDetail.tab.retry')}</span>,
            // REFACTOR-EXEC-02：重试链展示面板（构建逻辑仍在 pages/retry-chain.ts）
            children: (
              <ExecutionRetryChain
                taskId={taskId!}
                data={data}
                taskMaxRetry={taskMaxRetry}
                retryChain={retryChain}
                pendingRetry={pendingRetry}
              />
            ),
          },
          {
            key: 'context',
            label: <span data-testid="tab-label-context"><AppstoreOutlined /> {t('execDetail.tab.context')}</span>,
            children: (
              <>
                <Card title={t('execDetail.context.paramsTitle')} style={{ marginBottom: 16 }}>
                  {taskData?.params && Object.keys(taskData.params).length > 0 ? (
                    // UI-09：参数 Tag 含长 URL/无空格值时 nowrap（antd Tag 默认）
                    // 会撑到上千像素——窄屏由 .ui09-param-tag 换行折行兜底
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {Object.entries(taskData.params).map(([k, v]) => (
                        <Tag key={k} className="ui09-param-tag" style={{ fontFamily: 'monospace', fontSize: 12 }}>
                          {k} = {String(v)}
                        </Tag>
                      ))}
                    </div>
                  ) : (
                    <Text type="secondary">{t('execDetail.context.paramsEmpty')}</Text>
                  )}
                  {taskData?.runbook && (
                    <div style={{ marginTop: 12 }}>
                      <Space size={4}>
                        <BookOutlined />
                        <Text strong>{t('execDetail.context.runbookTitle')}</Text>
                      </Space>
                      <pre
                        style={{
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          margin: '4px 0 0',
                          padding: 8,
                          borderRadius: 6,
                          fontSize: 12,
                          background: 'var(--log-bg)',
                          color: 'var(--log-text)',
                          fontFamily: 'var(--font-mono)',
                          maxHeight: 320,
                          overflow: 'auto',
                        }}
                      >
                        {taskData.runbook}
                      </pre>
                    </div>
                  )}
                </Card>
                {/* FEAT-05 UI 半场（003）：产物列表组件单点接入——
                    空清单整段不渲染（组件内 return null），故外层不包空态。 */}
                <Card title={t('execDetail.context.artifactsTitle')}>
                  <ArtifactsList execId={execId!} />
                </Card>
              </>
            ),
          },
        ]}
      />

      {/* P1-26：重新触发确认 Modal——展示本次执行参数（即将沿用）与任务默认参数的差异 */}
      <Modal
        title={t('execDetail.retriggerConfirm.title')}
        open={retriggerOpen}
        onCancel={() => setRetriggerOpen(false)}
        onOk={doRetrigger}
        confirmLoading={retrying}
        okText={t('execDetail.retriggerConfirm.ok')}
      >
        <div style={{ marginBottom: 12 }}>{t('execDetail.retriggerConfirm.body')}</div>
        {retriggerThisParams ? (
          <>
            <Text strong>{t('execDetail.retriggerConfirm.thisParams')}</Text>
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                padding: 8,
                borderRadius: 6,
                fontSize: 12,
                background: 'var(--log-bg)',
                color: 'var(--log-text)',
                fontFamily: 'var(--font-mono)',
                margin: '8px 0',
              }}
            >
              {Object.entries(retriggerThisParams).map(([k, v]) => `${k} = ${String(v)}`).join('\n')}
            </pre>
            {retriggerParamsDiffer && (
              <Alert
                type="warning"
                showIcon
                title={t('execDetail.retriggerConfirm.differs')}
                style={{ marginTop: 8 }}
              />
            )}
          </>
        ) : (
          <Text type="secondary">{t('execDetail.retriggerConfirm.noParams')}</Text>
        )}
      </Modal>
    </div>
  );
}
