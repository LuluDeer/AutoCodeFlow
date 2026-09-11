import { Card, Descriptions, Tag, Typography, Button, Space, Badge, message, Alert, Popconfirm, Result, Select, Input, Tabs } from 'antd';
import { ArrowLeftOutlined, SyncOutlined, RedoOutlined, CopyOutlined, StopOutlined, RobotOutlined, DownloadOutlined, SearchOutlined, BookOutlined, ExperimentOutlined, FieldTimeOutlined, LinkOutlined, AppstoreOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { tasksApi } from '../api/tasks';
import {
  useExecutionDetail,
  useExecutionReport,
  useExecutionRetryChain,
  useTaskDetail,
} from '../api/queries';
import { getApiBaseUrl } from '../api/client';
import { getErrMsg } from '../utils/error';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { useAuthStore } from '../store/auth';
import { formatDateTime, formatDuration } from '../utils/timeFormat';
import { LOG_LEVEL_VALUES, logLineHighlightClass } from '../utils/logLevel';
// UI-05: 搜索高亮分段（纯函数）+ 防抖常量
import { buildLogSearchSegments, LOG_SEARCH_DEBOUNCE_MS } from '../utils/log-search';
// UI-05: 失败定位映射（语义镜像 mcp FAILURE_RUNBOOK，BUG-10 十二类）
import { failureRunbookAction, FAILURE_CARD_STATUSES } from './failure-runbook';
// OBS-04: 分析报告/时间线面板（核心展示逻辑独立成组件文件，便于单独测试）
import ExecutionReportPanel from '../components/ExecutionReportPanel';
import PageHeader from '../components/PageHeader';
import PageSkeleton from '../components/PageSkeleton';
// FEAT-05 UI 半场：产物列表（003 产出组件，本任务作为「参数与产物」Tab 单点接入）
import ArtifactsList from '../components/ArtifactsList';
// CORE-02: 重试链纯逻辑（Card 迁入重试 Tab 时沿用）
import { buildRetryChain, nextPendingRetryAt, type RetryChainLink } from './retry-chain';

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

const TRIGGER_LABEL = (t: (k: string) => string): Record<string, string> => ({
  manual: t('execDetail.trigger.manual'), cron: t('execDetail.trigger.cron'), fixed_rate: t('execDetail.trigger.fixedRate'),
  dependency: t('execDetail.trigger.dependency'), misfire: t('execDetail.trigger.misfire'),
});

const FAILURE_REASON_MAP = (t: (k: string) => string): Record<string, { color: string; label: string; hint: string }> => ({
  package_fetch_failed: { color: 'gold', label: t('execDetail.failure.packageFetchFailed'), hint: t('execDetail.failure.packageFetchFailedHint') },
  // BUG-10 细化分类
  git_fetch_failed: { color: 'gold', label: t('execDetail.failure.gitFetchFailed'), hint: t('execDetail.failure.gitFetchFailedHint') },
  dependency_install_failed: { color: 'gold', label: t('execDetail.failure.dependencyInstallFailed'), hint: t('execDetail.failure.dependencyInstallFailedHint') },
  runtime_missing: { color: 'gold', label: t('execDetail.failure.runtimeMissing'), hint: t('execDetail.failure.runtimeMissingHint') },
  script_error: { color: 'red', label: t('execDetail.failure.scriptError'), hint: t('execDetail.failure.scriptErrorHint') },
  timeout: { color: 'orange', label: t('execDetail.failure.timeout'), hint: t('execDetail.failure.timeoutHint') },
  executor_offline: { color: 'volcano', label: t('execDetail.failure.executorOffline'), hint: t('execDetail.failure.executorOfflineHint') },
  executor_restart: { color: 'volcano', label: t('execDetail.failure.executorRestart'), hint: t('execDetail.failure.executorRestartHint') },
  stale_recovered: { color: 'volcano', label: t('execDetail.failure.staleRecovered'), hint: t('execDetail.failure.staleRecoveredHint') },
  killed: { color: 'default', label: t('execDetail.failure.killed'), hint: t('execDetail.failure.killedHint') },
  unknown: { color: 'default', label: t('execDetail.failure.unknown'), hint: t('execDetail.failure.unknownHint') },
});

// UI-05: 重试链状态 Tag（随重试链 Card 迁入重试 Tab，渲染逻辑与 CORE-02 一致）
const RETRY_STATUS_COLOR: Record<string, string> = {
  pending: 'default', running: 'processing', success: 'green',
  failed: 'red', timeout: 'orange', killed: 'volcano', cancelled: 'default',
};

// U1: SSE 与 axios API 必须同源——复用 client.ts 的 getApiBaseUrl
// （含 localStorage 内/外网开关 autoflow_use_external_api）。
// 旧实现恒优先 VITE_API_URL_EXTERNAL，双地址配置时内网环境 SSE 永远打外网。
function getSseBase(): string {
  return getApiBaseUrl();
}

/**
 * U2: 与 admin-api task.service.ts 的 LOG_TRUNCATION_MARKER 对齐——执行器回调
 * 载荷超限时插入的截断标记（后端不返回 truncated 标志，只嵌在日志文本里）：
 * Node:   "... [logs truncated, original length N chars] ..."
 * Python: "...[truncated, total N chars]..."
 */
const LOG_TRUNCATION_MARKER = /\[\s*(?:logs\s+)?truncated\b/i;
// 后端 getExecutionLogs 单页上限（task.controller.ts limit 封顶 2000）
const LOG_PAGE_LIMIT = 2000;
// 兜底页数上限，与后端 backfill MAX_PAGES 对齐，防 hasMore 异常导致死循环
const LOG_MAX_PAGES = 200;
// OBS-03: 级别过滤下拉——'ALL' 表示不过滤（不带 level，行为与之前完全一致）
const LOG_LEVEL_FILTER_ALL = 'ALL';
type LogLevelFilter = typeof LOG_LEVEL_FILTER_ALL | 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';

// UI-05: Tab key 与 URL ?tab= 双向记忆（ApplicationDetailPage 先例）——
// 刷新/分享链接回到原 Tab；非法值回退默认 Tab（日志）。
const TAB_KEY_DEFAULT = 'logs';
const TAB_KEYS = ['logs', 'report', 'retry', 'context'] as const;
type TabKey = (typeof TAB_KEYS)[number];

function normalizeTabKey(raw: string | null): TabKey {
  return (TAB_KEYS as readonly string[]).includes(raw || '') ? (raw as TabKey) : TAB_KEY_DEFAULT;
}

/** UI-09：执行信息 Descriptions 响应式列数（xs 单列 / sm 2 列 / md 3 列）。
 *  跨列项（失败分类/错误信息）用 antd 的 span="filled" 占满整行——它按当前
 *  列数动态取 span，避免窄屏 xs 单列时旧写法 span={3} 超出列数
 *  （antd「Sum of column span not match column」警告 + 内容按 3 列宽撑破卡片）。 */
export const UI09_DESCRIPTIONS_COLUMN = { xs: 1, sm: 2, md: 3 } as const;

export default function ExecutionDetailPage() {
  const { t } = useTranslation();
  const statusMap = STATUS_MAP(t);
  const triggerLabels = TRIGGER_LABEL(t);
  const failureReasonMap = FAILURE_REASON_MAP(t);
  const { taskId, execId } = useParams<{ taskId: string; execId: string }>();
  const nav = useNavigate();
  const logRef = useRef<HTMLPreElement>(null);
  const [retrying, setRetrying] = useState(false);
  const [killing, setKilling] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [streamLines, setStreamLines] = useState<string[] | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [streamDisconnected, setStreamDisconnected] = useState(false);
  const [reconnectKey, setReconnectKey] = useState(0);
  // OBS-03: 级别过滤拉取的时序守卫——快速连续切换级别时只让最新一次
  // 请求的响应落地，过期响应（晚到的旧 seq）直接丢弃。
  const levelFetchSeq = useRef(0);
  // U2: 截断日志兜底——"加载完整日志"成功后覆盖显示（null=未加载）
  const [fullLogs, setFullLogs] = useState<string | null>(null);
  const [loadingFullLogs, setLoadingFullLogs] = useState(false);
  // OBS-03: 级别过滤（服务端过滤）——非 ALL 时经分页端点带 level 拉取过滤后
  // 行集，结果落在 filteredLogs（优先级高于 fullLogs/rawLogs）
  const [levelFilter, setLevelFilter] = useState<LogLevelFilter>(LOG_LEVEL_FILTER_ALL);
  const [filteredLogs, setFilteredLogs] = useState<string | null>(null);
  const [loadingFilteredLogs, setLoadingFilteredLogs] = useState(false);
  // UI-05: 关键词搜索——inputKeyword 即时回显（受控输入）、activeKeyword
  // 防抖后生效触发分段重算（大日志逐键重切分代价高）。
  const [inputKeyword, setInputKeyword] = useState('');
  const [activeKeyword, setActiveKeyword] = useState('');
  const token = useAuthStore((s) => s.token);

  // UI-05: Tab 记忆走 searchParams（?tab=），与 ApplicationDetailPage 同款；
  // 页面自身路由无 hash 语义冲突，选实现稳的 searchParams 方案。
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = normalizeTabKey(searchParams.get('tab'));

  // FEAT-17: 主执行数据换 useExecutionDetail（queryKey 带 taskId+execId，
  // 等价 refreshDeps）；refresh 语义保留给 SSE done/断流轮询兜底调用方。
  const { data, refetch: refresh, isLoading: loading, error } = useExecutionDetail(taskId, execId);
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
  useEffect(() => {
    void refreshReport();
  }, [data?.status, refreshReport]);

  // SSE log streaming when running
  useEffect(() => {
    if (data?.status !== 'running' && data?.status !== 'pending') return;
    const base = getSseBase().replace(/\/$/, '');
    const url = `${base}/tasks/${taskId}/executions/${execId}/logs/stream`;
    // EventSource 无法设置请求头；后端仅对日志流路由支持 access_token 查询参数鉴权
    const es = new EventSource(url + (token ? `?access_token=${encodeURIComponent(token)}` : ''));
    setStreaming(true);
    setStreamDisconnected(false);
    setStreamLines([]);
    es.onmessage = (e) => {
      try {
        const line = JSON.parse(e.data) as string;
        setStreamLines((prev) => (prev ? [...prev, line] : [line]));
      } catch { /* ignore malformed */ }
    };
    es.addEventListener('done', () => {
      es.close();
      setStreaming(false);
      setStreamDisconnected(false);
      refresh(); // final status refresh
    });
    const handleStreamError = () => {
      es.close();
      setStreaming(false);
      // 执行仍未终态：标记断流，交由轮询兜底并提示用户
      if (data?.status === 'running' || data?.status === 'pending') setStreamDisconnected(true);
    };
    es.addEventListener('error', handleStreamError);
    es.onerror = handleStreamError;
    return () => { es.close(); setStreaming(false); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.status, execId, taskId, reconnectKey]);

  // SSE 断流后的轮询兜底：仅对未终态执行刷新，到达终态后自动停止。
  // U3: 标签页不可见时跳过请求（与 useRequest pollingWhenHidden:false 语义一致），
  // 定时器保留，回到前台后下一拍即恢复刷新。
  useEffect(() => {
    if (!streamDisconnected || !isLive) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, 8000);
    return () => clearInterval(timer);
  }, [streamDisconnected, isLive, refresh]);

  // U2: 切换执行记录时丢弃上一条已加载的完整日志与过滤结果
  useEffect(() => {
    setFullLogs(null);
    setLevelFilter(LOG_LEVEL_FILTER_ALL);
    setFilteredLogs(null);
    setInputKeyword('');
    setActiveKeyword('');
  }, [execId]);

  // UI-05: 搜索关键词防抖（LOG_SEARCH_DEBOUNCE_MS 后生效）
  useEffect(() => {
    const t = setTimeout(() => setActiveKeyword(inputKeyword.trim()), LOG_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [inputKeyword]);

  // U2: 当前展示的日志：级别过滤视图 > 完整日志 > SSE 流 > 实体回调日志
  const rawLogs = streamLines ? streamLines.join('\n') : (data?.logs ?? '');
  const displayLogs = filteredLogs ?? fullLogs ?? rawLogs;
  const logsTruncated = filteredLogs === null && fullLogs === null && LOG_TRUNCATION_MARKER.test(rawLogs);

  // 日志滚动到底部（displayLogs 覆盖流式追加/加载完整日志/切换过滤视图）
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [displayLogs]);

  /**
   * UI-05: 行级高亮（OBS-03 口径）× 关键词高亮双维度分段。
   * - 无关键词：与 OBS-03 完全同构（行 span 或聚合文本块）；
   * 有关键词：按行构建（行类 + 命中 mark 分段）。
   * 两个维度都由 useMemo 缓存，拼接文本与 displayLogs 逐字符一致
   * （复制/下载/滚动行为不受影响）。
   */
  const logSegments = useMemo(() => {
    if (!displayLogs) return null;
    if (!activeKeyword) {
      // OBS-03 原分段：无高亮行聚合为单块，控制节点数量
      const lines = displayLogs.split('\n');
      const segs: { text: string; cls: string }[] = [];
      let buf = '';
      for (let i = 0; i < lines.length; i++) {
        const sep = i < lines.length - 1 ? '\n' : '';
        const cls = logLineHighlightClass(lines[i]);
        if (cls) {
          if (buf) {
            segs.push({ text: buf, cls: '' });
            buf = '';
          }
          segs.push({ text: lines[i] + sep, cls });
        } else {
          buf += lines[i] + sep;
        }
      }
      if (buf) segs.push({ text: buf, cls: '' });
      return segs;
    }
    return buildLogSearchSegments(displayLogs, activeKeyword, logLineHighlightClass);
  }, [displayLogs, activeKeyword]);

  /**
   * U2/OBS-03 共用：分页拉全日志行（后端 limit 封顶 2000/页，hasMore 驱动
   * 翻页，LOG_MAX_PAGES 兜底防死循环）。level 传入时为服务端过滤模式——
   * 过滤后行集不再按行号连续，fromLine 语义是"过滤后序列的偏移量"（后端
   * SQL skip/OFFSET），客户端沿用既有翻页契约 fromLine += lines.length
   * （收到的行数即过滤后已消费的偏移量），与后端 hasMore =
   * fromLine + lines.length < totalLines（过滤后计数）自洽。
   */
  const fetchAllLogLines = async (level?: string): Promise<string[]> => {
    const all: string[] = [];
    let fromLine = 0;
    for (let page = 0; page < LOG_MAX_PAGES; page++) {
      const resp = await tasksApi.executionLogs(
        taskId!, execId!,
        level ? { fromLine, limit: LOG_PAGE_LIMIT, level } : { fromLine, limit: LOG_PAGE_LIMIT },
      );
      const lines = Array.isArray(resp?.lines) ? resp.lines : [];
      if (lines.length === 0) break;
      all.push(...lines);
      fromLine += lines.length;
      if (!resp?.hasMore) break;
    }
    return all;
  };

  // U2: 回调日志被执行器截断时，从全量日志端点按行分页拉全（后端 limit 上限
  // 2000/页，hasMore 驱动翻页）。成功替换显示与复制/下载内容；失败 toast 保留现状。
  const handleLoadFullLogs = async () => {
    if (!taskId || !execId) return;
    setLoadingFullLogs(true);
    try {
      const all = await fetchAllLogLines();
      if (all.length === 0) {
        throw new Error(t('execDetail.fullLogsNoRows'));
      }
      setFullLogs(all.join('\n'));
      message.success(t('execDetail.fullLogsLoaded'));
    } catch (err: unknown) {
      message.error(getErrMsg(err, t('execDetail.fullLogsLoadFail')));
    } finally {
      setLoadingFullLogs(false);
    }
  };

  /**
   * OBS-03: 级别过滤。选择非"全部"级别时调用分页端点带 level 重新拉取
   * （复用 fetchAllLogLines 的分页循环；请求不带 level 时行为不变）。
   * 取舍说明——与 SSE 流模式的关系采用"统一服务端过滤快照"最小方案：
   * 流的 DB 路径本就逐秒轮询持久化日志行（logLineRepo），分页端点在运行中
   * 同样可读同一行集（S3 路径与 SSE 流自身一样仅在终态可读），因此无需为
   * 流缓冲单做一条客户端过滤路径；代价是流模式下过滤视图为拉取时刻的快照，
   * 新增行需切回"全部"查看（实时流视图不受影响）。
   * 空结果属合法态（该级别无日志）→ 展示空视图不报错；失败 toast 且保留
   * 原视图。seq 计数防快速连续切换的过期响应回写。
   */
  const handleLevelFilterChange = async (value: LogLevelFilter) => {
    setLevelFilter(value);
    const seq = ++levelFetchSeq.current;
    if (value === LOG_LEVEL_FILTER_ALL) {
      setFilteredLogs(null);
      return;
    }
    if (!taskId || !execId) return;
    setLoadingFilteredLogs(true);
    try {
      const all = await fetchAllLogLines(value);
      if (levelFetchSeq.current !== seq) return;
      setFilteredLogs(all.join('\n'));
    } catch (err: unknown) {
      if (levelFetchSeq.current !== seq) return;
      setFilteredLogs(null);
      message.error(getErrMsg(err, t('execDetail.levelFilterFail')));
    } finally {
      if (levelFetchSeq.current === seq) setLoadingFilteredLogs(false);
    }
  };

  const handleKill = async () => {
    setKilling(true);
    try {
      await tasksApi.killExecution(taskId!, execId!);
      message.success(t('execDetail.killed'));
      refresh();
    } catch (err: unknown) {
      message.error(getErrMsg(err, t('execDetail.killFail')));
    } finally {
      setKilling(false);
    }
  };

  const handleRetry = async () => {
    setRetrying(true);
    try {
      await tasksApi.trigger(taskId!);
      message.success(t('execDetail.retriggered'));
      nav(`/tasks/${taskId}`);
    } catch (err: unknown) {
      message.error(getErrMsg(err, t('execDetail.triggerFail')));
    } finally {
      setRetrying(false);
    }
  };

  // UI-05: 失败定位卡片可见性（failed/timeout；killed 无排障价值不渲染）
  const showFailureCard = FAILURE_CARD_STATUSES.includes(data?.status || '');

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
  const failureReason = data?.failureReason
    ? failureReasonMap[data.failureReason] || {
        color: 'default',
        label: data.failureReason,
        hint: t('execDetail.failure.unrecognizedHint'),
      }
    : undefined;
  // UI-05: 建议动作（未知键回退 unknown 兜底）
  const runbookAction = failureRunbookAction(data?.failureReason);
  const runbookText = taskData?.runbook || null;

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
            {data?.status === 'running' && !streamDisconnected && (
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
                onClick={handleRetry}
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

      {streamDisconnected && isLive && (
        <Alert
          type="warning"
          showIcon
          title={t('execDetail.streamDisconnected')}
          style={{ marginBottom: 16 }}
          action={
            <Button
              size="small"
              icon={<SyncOutlined />}
              onClick={() => { setStreamDisconnected(false); setReconnectKey((k) => k + 1); refresh(); }}
            >
              {t('execDetail.reconnect')}
            </Button>
          }
        />
      )}

      {/* UI-05: 信息卡保留 Tab 外顶部——执行状态/耗时/执行器常驻视野 */}
      <Card title={t('execDetail.card.info')} style={{ marginBottom: 16 }}>
        <Descriptions column={UI09_DESCRIPTIONS_COLUMN} size="small">
          <Descriptions.Item label={t('execDetail.field.taskName')}>
            <a onClick={() => nav(`/tasks/${taskId}`)}>{data?.taskName}</a>
          </Descriptions.Item>
          <Descriptions.Item label={t('execDetail.field.trigger')}>
            {triggerLabels[data?.triggerType || ''] ?? data?.triggerType ?? '-'}
          </Descriptions.Item>
          <Descriptions.Item label={t('execDetail.field.executor')}>
            {data?.executorAddress ? (
              <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{data.executorAddress}</span>
            ) : '-'}
          </Descriptions.Item>
          <Descriptions.Item label={t('execDetail.field.taskVersion')}>{data?.taskVersion || '-'}</Descriptions.Item>
          <Descriptions.Item label={t('execDetail.field.retryCount')}>{data?.retryCount ?? 0}</Descriptions.Item>
          <Descriptions.Item label={t('execDetail.field.startTime')}>
            {data?.startTime ? formatDateTime(data.startTime) : '-'}
          </Descriptions.Item>
          <Descriptions.Item label={t('execDetail.field.endTime')}>
            {data?.endTime ? formatDateTime(data.endTime) : '-'}
          </Descriptions.Item>
          <Descriptions.Item label={t('execDetail.field.duration')}>
            {data?.duration != null ? formatDuration(data.duration) : '-'}
          </Descriptions.Item>
          <Descriptions.Item label={t('execDetail.field.exitCode')}>
            {data?.exitCode != null ? (
              <Text type={data.exitCode !== 0 ? 'danger' : undefined} code>
                {data.exitCode}
              </Text>
            ) : '-'}
          </Descriptions.Item>
          {/* OBS-01: traceId 有值时展示追踪标识 + 复制按钮。Jaeger/Tempo 跳转
              链接留配置项（collector 未部署，不硬编码 URL）——后续接入时在此
              追加 <a href={`${TRACE_BASE_URL}/search?service=autoflow&tags=${encodeURIComponent(`traceId=${data.traceId}`)}`}>。
              复制出的 trace-id 可直接粘贴到 Jaeger/Tempo 检索框。 */}
          {data?.traceId && (
            <Descriptions.Item label={t('execDetail.field.traceId')}>
              <Space size={4}>
                <Text code style={{ fontSize: 12 }} data-testid="execution-trace-id">
                  {data.traceId}
                </Text>
                <Button
                  type="text"
                  size="small"
                  icon={<CopyOutlined />}
                  aria-label={t('execDetail.copyTraceId')}
                  data-testid="copy-trace-id"
                  onClick={() => {
                    navigator.clipboard.writeText(data.traceId!).then(
                      () => message.success(t('execDetail.traceIdCopied')),
                      () => message.error(t('execDetail.copyFail')),
                    );
                  }}
                />
              </Space>
            </Descriptions.Item>
          )}
          {failureReason && (
            <Descriptions.Item label={t('execDetail.field.failureCategory')} span={UI09_DESCRIPTIONS_COLUMN}>
              <Space>
                <Tag color={failureReason.color}>{failureReason.label}</Tag>
                <Text type="secondary">{failureReason.hint}</Text>
              </Space>
            </Descriptions.Item>
          )}
          {data?.errorMessage && (
            <Descriptions.Item label={t('execDetail.field.errorMessage')} span={UI09_DESCRIPTIONS_COLUMN}>
              <Text type="danger">{data.errorMessage}</Text>
            </Descriptions.Item>
          )}
        </Descriptions>
      </Card>

      {/* UI-05: Tab 化信息架构——日志（默认）/时间线·报告/重试链/参数与产物 */}
      <Tabs
        activeKey={activeTab}
        onChange={handleTabChange}
        data-testid="execution-detail-tabs"
        items={[
          {
            key: 'logs',
            label: <span data-testid="tab-label-logs">{t('execDetail.tab.logs')}</span>,
            children: (
              <>
                {/* UI-05: 失败定位卡片——failed/timeout 时置顶日志 Tab */}
                {showFailureCard && (
                  <Alert
                    type={data?.status === 'timeout' ? 'warning' : 'error'}
                    showIcon
                    icon={<ExperimentOutlined />}
                    data-testid="failure-triage-card"
                    title={failureReason ? `${status.label}：${failureReason.label}` : status.label}
                    description={
                      <div>
                        <div style={{ marginBottom: 4 }}>
                          <Text strong>{t('execDetail.failureSuggestedAction')}</Text>
                          <Text>{runbookAction.action}</Text>
                        </div>
                        {data?.errorMessage && (
                          <div style={{ marginBottom: 4 }}>
                            <Text strong>{t('execDetail.failureErrorMessage')}</Text>
                            <Text type="danger">{data.errorMessage}</Text>
                          </div>
                        )}
                        {runbookText && (
                          <div data-testid="failure-runbook" style={{ marginTop: 8 }}>
                            <Space size={4}>
                              <BookOutlined />
                              <Text strong>{t('execDetail.runbookTitle')}</Text>
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
                              }}
                            >
                              {runbookText}
                            </pre>
                          </div>
                        )}
                        <Button
                          size="small"
                          type="link"
                          icon={<LinkOutlined />}
                          style={{ padding: 0, marginTop: 4 }}
                          onClick={() => handleTabChange('report')}
                        >
                          {t('execDetail.viewAiTimeline')}
                        </Button>
                      </div>
                    }
                    style={{ marginBottom: 16 }}
                    action={
                      data?.status === 'failed' ? (
                        <Button size="small" danger icon={<RedoOutlined />} onClick={handleRetry} loading={retrying}>
                          {t('execDetail.retrigger')}
                        </Button>
                      ) : undefined
                    }
                  />
                )}
                <Card
                  title={t('execDetail.log.title')}
                  className="ui09-log-toolbar-card"
                  styles={{ body: { paddingTop: 12 } }}
                  extra={
                    // UI-09：工具条 5 个控件最小宽 ~448px > 375px 卡头——窄屏
                    // 由 .ui09-log-toolbar-card 换行独占整行（见 index.css）
                    <Space wrap className="ui09-log-toolbar">
                      {streaming && <Badge status="processing" text={t('execDetail.log.live')} />}
                      {/* UI-05: 关键词搜索——前端对已加载行切分高亮，
                          防抖 300ms 生效；清空即恢复原渲染。 */}
                      <Input
                        size="small"
                        allowClear
                        prefix={<SearchOutlined />}
                        placeholder={t('execDetail.log.searchPlaceholder')}
                        aria-label={t('execDetail.log.searchAria')}
                        // data-testid 落在真实 <input> 上（allowClear 时 Input
                        // 根节点会包一层 span，取根会拿不到输入元素）
                        data-testid="log-search-input"
                        style={{ width: 180 }}
                        value={inputKeyword}
                        onChange={(e) => setInputKeyword(e.target.value)}
                      />
                      {/* OBS-03: 级别过滤（服务端）。"全部"不带 level——行为与
                          OBS-03 之前完全一致；选择具体级别后经分页端点重新拉取
                          过滤后行集（流模式下为拉取时刻的服务端快照，见
                          handleLevelFilterChange 注释）。 */}
                      <Select<LogLevelFilter>
                        size="small"
                        style={{ minWidth: 112 }}
                        aria-label={t('execDetail.log.levelFilterAria')}
                        value={levelFilter}
                        loading={loadingFilteredLogs}
                        disabled={loadingFilteredLogs}
                        onChange={handleLevelFilterChange}
                        options={[
                          { value: LOG_LEVEL_FILTER_ALL, label: t('execDetail.log.levelAll') },
                          ...LOG_LEVEL_VALUES.map((lv) => ({ value: lv, label: lv })),
                        ]}
                      />
                      <Button
                        size="small"
                        icon={<CopyOutlined />}
                        onClick={() => {
                          // OBS-03 取舍：复制反映"当前视图"（所见即所得）——级别
                          // 过滤生效时复制过滤视图，"全部"时复制当前展示内容
                          // （可能含 SSE 流缓冲）。需要全量请切回"全部"后复制。
                          navigator.clipboard.writeText(displayLogs);
                          message.success(t('execDetail.log.copied'));
                        }}
                      >
                        {t('execDetail.log.copy')}
                      </Button>
                      <Button
                        size="small"
                        icon={<DownloadOutlined />}
                        onClick={() => {
                          // OBS-03 取舍：与复制一致——下载当前视图（过滤生效时
                          // 即过滤结果），与页面展示严格一致，避免"看到的与拿到
                          // 的不同"。需要全量请切回"全部"后下载。
                          const blob = new Blob([displayLogs], { type: 'text/plain;charset=utf-8' });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = `exec-${execId}-${new Date().toISOString().slice(0, 10)}.log`;
                          a.click();
                          URL.revokeObjectURL(url);
                        }}
                      >
                        {t('execDetail.log.download')}
                      </Button>
                    </Space>
                  }
                >
                  {logsTruncated && (
                    <Alert
                      type="warning"
                      showIcon
                      title={t('execDetail.log.truncatedTitle')}
                      description={t('execDetail.log.truncatedDesc')}
                      style={{ marginBottom: 12 }}
                      action={
                        <Button
                          size="small"
                          icon={<DownloadOutlined />}
                          loading={loadingFullLogs}
                          onClick={handleLoadFullLogs}
                        >
                          {t('execDetail.log.loadFull')}
                        </Button>
                      }
                    />
                  )}
                  {/* OBS-03: 级别过滤空结果是合法态（该级别无日志行），显式提示而非空白 */}
                  {levelFilter !== LOG_LEVEL_FILTER_ALL && filteredLogs !== null && filteredLogs.length === 0 && (
                    <Alert
                      type="info"
                      showIcon
                      title={t('execDetail.log.noLevelLogs', { level: levelFilter })}
                      description={t('execDetail.log.noLevelLogsDesc')}
                      style={{ marginBottom: 12 }}
                    />
                  )}
                  {activeKeyword && displayLogs && !displayLogs.includes(activeKeyword) && (
                    <Alert
                      type="info"
                      showIcon
                      title={t('execDetail.log.noSearchHit', { keyword: activeKeyword })}
                      style={{ marginBottom: 12 }}
                    />
                  )}
                  <pre
                    ref={logRef}
                    data-testid="log-pre"
                    style={{
                      // UI-02：SSE 日志区双主题（亮面白底深字 / 暗面 MASTER OLED 画布）
                      background: 'var(--log-bg)',
                      color: 'var(--log-text)',
                      padding: 16,
                      borderRadius: 8,
                      maxHeight: 500,
                      overflow: 'auto',
                      fontSize: 12,
                      margin: 0,
                      // UI-01：MASTER.md §Typography——日志/等宽场景用 Fira Code
                      fontFamily: 'var(--font-mono)',
                      lineHeight: 1.6,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {logSegments === null
                      ? displayLogs
                      : logSegments.map((seg, i) => renderLogSegment(seg, i, activeKeyword))}
                  </pre>
                </Card>
              </>
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
                    style={{ borderColor: '#1677ff', marginBottom: 16 }}
                    styles={{ header: { background: 'linear-gradient(90deg, #e6f7ff, #f0f5ff)', color: '#1677ff' } }}
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
            children: (
              <>
                {/* CORE-02: 重试链 Card 原样迁入（构建逻辑/展示字段零改动） */}
                {retryChain.length > 0 && (
                  <Card
                    title={t('execDetail.retry.chainTitle')}
                    style={{ marginBottom: 16 }}
                    extra={
                      taskMaxRetry > 0 ? (
                        <Tag>
                          {t('execDetail.retry.budget', { attempt: (data?.retryCount ?? 0) + 1, total: taskMaxRetry + 1 })}
                          {taskMaxRetry - (data?.retryCount ?? 0) > 0
                            ? t('execDetail.retry.remaining', { count: taskMaxRetry - (data?.retryCount ?? 0) })
                            : t('execDetail.retry.exhausted')}
                        </Tag>
                      ) : undefined
                    }
                  >
                    {retryChain.map((link) => (
                      <div
                        key={link.execId}
                        data-testid="retry-chain-item"
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '6px 0',
                          borderBottom: '1px solid var(--color-border, #f0f0f0)',
                          flexWrap: 'wrap',
                        }}
                      >
                        <Tag color={RETRY_STATUS_COLOR[link.status] || 'default'}>Attempt #{link.retryCount}</Tag>
                        {link.execId === data?.id ? (
                          <Text strong>{t('execDetail.retry.currentExec')}</Text>
                        ) : (
                          <a onClick={() => nav(`/tasks/${taskId}/executions/${link.execId}`)}>
                            {link.execId.slice(0, 8)}…
                          </a>
                        )}
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {link.triggerType ? triggerLabels[link.triggerType] ?? link.triggerType : '-'}
                          {link.executorAddress ? ` · ${link.executorAddress}` : ''}
                        </Text>
                        {link.failureReason && (
                          <Tag>{failureReasonMap[link.failureReason]?.label ?? link.failureReason}</Tag>
                        )}
                        {link.errorMessage && (
                          <Text type="danger" style={{ fontSize: 12 }} ellipsis>
                            {link.errorMessage}
                          </Text>
                        )}
                      </div>
                    ))}
                    {pendingRetry && (
                      <Alert
                        type="info"
                        showIcon
                        style={{ marginTop: 12 }}
                        title={t('execDetail.retry.pendingAlert', { attempt: pendingRetry.retryCount })}
                      />
                    )}
                  </Card>
                )}
                {retryChain.length === 0 && (
                  <Card>
                    <Text type="secondary">{t('execDetail.retry.empty')}</Text>
                  </Card>
                )}
                {taskMaxRetry > 0 && (
                  <Card size="small">
                    <Text type="secondary">
                      {t('execDetail.retry.manualHint')}
                    </Text>
                  </Card>
                )}
              </>
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
    </div>
  );
}

/**
 * UI-05: 分段渲染。无关键词时沿用 OBS-03 的扁平 span 流（行类可选、
 * 无高亮行为纯文本节点）；有关键词时逐行渲染：行类 span 包裹整行 +
 * 命中片段 mark.log-search-hit，行间换行符跟随前一行（拼接保真）。
 */
function renderLogSegment(
  seg: unknown,
  index: number,
  activeKeyword: string,
): React.ReactNode {
  if (!activeKeyword) {
    const s = seg as { text: string; cls: string };
    return s.cls ? (
      <span key={index} className={s.cls}>{s.text}</span>
    ) : (
      s.text
    );
  }
  const line = seg as import('../utils/log-search').LogLineSegments;
  const separator = line.isLast ? '' : '\n';
  const inner = line.segments.map((piece, j) =>
    piece.hit ? (
      <mark key={j} className="log-search-hit">{piece.text}</mark>
    ) : (
      piece.text
    ),
  );
  return line.lineClass ? (
    <span key={index} className={line.lineClass}>
      {inner}
      {separator}
    </span>
  ) : (
    <span key={index}>
      {inner}
      {separator}
    </span>
  );
}

