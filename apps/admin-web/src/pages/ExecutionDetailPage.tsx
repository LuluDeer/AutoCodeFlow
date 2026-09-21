import { Card, Descriptions, Tag, Typography, Button, Space, Badge, message, Alert, Popconfirm, Result, Select, Input, Tabs, theme, Modal } from 'antd';
import { ArrowLeftOutlined, SyncOutlined, RedoOutlined, CopyOutlined, StopOutlined, RobotOutlined, DownloadOutlined, SearchOutlined, BookOutlined, ExperimentOutlined, FieldTimeOutlined, LinkOutlined, AppstoreOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { tasksApi } from '../api/tasks';
import {
  useExecutionDetail,
  useExecutionReport,
  useExecutionRetryChain,
  useTaskDetail,
  invalidateExecutionData,
} from '../api/queries';
import { getApiBaseUrl } from '../api/client';
import { createSseClient } from '../api/sse-client';
import { getErrMsg } from '../utils/error';
import { copyText } from '../utils/clipboard';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { formatDateTime, formatDuration } from '../utils/timeFormat';
import { LOG_LEVEL_VALUES, logLineHighlightClass } from '../utils/logLevel';
// UI-05: 搜索高亮分段（纯函数）+ 防抖常量
import { buildLogSearchSegments, LOG_SEARCH_DEBOUNCE_MS } from '../utils/log-search';
// UI-05: 失败定位映射（语义镜像 mcp FAILURE_RUNBOOK，BUG-10 分类 + 解释器不可用）
import { failureRunbookAction, FAILURE_CARD_STATUSES } from './failure-runbook';
// python_task_multiversion（FR-12 / AC-12a）：执行记录里 `result.interpreter` 的
// 防御式读取层。**必须**走它而不是直接 `data.result.interpreter`——result 是 jsonb
// 自由列且该留痕只有新执行器才写，历史记录可能是 null/{}/脏值，直接取属性会把
// 排障入口页打成白屏（详见 interpreter-context.ts 头注释）。
import {
  extractInterpreterContext,
  interpreterNeedsOfflinePrefill,
  INTERPRETER_REASON_T_KEY,
} from './interpreter-context';
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
  // EXP-01（本轮体验审查）：沙箱已配置但不可用（bwrap 缺失 / Windows 上配了
  // TASK_SANDBOX=bwrap / 用户命名空间被禁）。执行器 fail-closed 拒绝无沙箱运行，
  // 属「环境/配置」族故同为 gold；处置动作是装 bubblewrap 或取消 TASK_SANDBOX，
  // 与 runtime_missing（装运行时本体）不同，故独立分类而非并入。
  sandbox_unavailable: { color: 'gold', label: t('execDetail.failure.sandboxUnavailable'), hint: t('execDetail.failure.sandboxUnavailableHint') },
  // python_task_multiversion：解释器不可用。与 runtime_missing 同属
  // 「环境/配置」族，故同为 gold；刻意不在默认重试集内——重跑不会让 3.7 变得
  // 可下载，必须由运维修环境（前端只是如实展示分类，重试白名单由任务配置决定）。
  interpreter_unavailable: { color: 'gold', label: t('execDetail.failure.interpreterUnavailable'), hint: t('execDetail.failure.interpreterUnavailableHint') },
  script_error: { color: 'red', label: t('execDetail.failure.scriptError'), hint: t('execDetail.failure.scriptErrorHint') },
  timeout: { color: 'orange', label: t('execDetail.failure.timeout'), hint: t('execDetail.failure.timeoutHint') },
  executor_offline: { color: 'volcano', label: t('execDetail.failure.executorOffline'), hint: t('execDetail.failure.executorOfflineHint') },
  executor_restart: { color: 'volcano', label: t('execDetail.failure.executorRestart'), hint: t('execDetail.failure.executorRestartHint') },
  stale_recovered: { color: 'volcano', label: t('execDetail.failure.staleRecovered'), hint: t('execDetail.failure.staleRecoveredHint') },
  killed: { color: 'default', label: t('execDetail.failure.killed'), hint: t('execDetail.failure.killedHint') },
  // P0-4（UX-AUDIT-2026-09-21）：引用的应用已删除 → 环境/配置类（gold），处置动作
  // 是"重新指定代码来源"，与 package_fetch_failed（查网络/地址）不同故独立分类。
  application_missing: { color: 'gold', label: t('execDetail.failure.applicationMissing'), hint: t('execDetail.failure.applicationMissingHint') },
  // P0-8（UX-AUDIT-2026-09-21）：从未派发 → volcano（与 executor_offline 同族，
  // 都是"任务没能到达执行器"），但提示明确区分：它没有任何日志可看。
  never_dispatched: { color: 'volcano', label: t('execDetail.failure.neverDispatched'), hint: t('execDetail.failure.neverDispatchedHint') },
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
// F-11（DEEP_REVIEW 0ef3bbe）: "加载完整日志"行数上限。此前最多 200 页 × 2000
// 行 = 40 万行，全量 join('\n') 产生巨型字符串导致内存/CPU 峰值。
// G-3：上限由 10 万行进一步下调到 2 万行——即便单行日志，10 万行在真机
// <pre> 内仍会造成明显布局掉帧；超过 2 万行直接停拉并强引导「下载」查看
// （下载走 blob，不受渲染层约束）。虚拟滚动（react-window）为后续演进方向。
const FULL_LOGS_MAX_LINES = 20_000;
// O-5：SSE 断流后轮询兜底的指数退避参数。起步 8s，每次成功轮询后翻倍，
// 封顶 60s——避免长时间断流时固定每 8s 打一次请求。新断流（重新连上又断开）
// 会把延迟重置回起步值。
const SSE_POLL_BASE_MS = 8000;
const SSE_POLL_MAX_MS = 60_000;
// OBS-03: 级别过滤下拉——'ALL' 表示不过滤（不带 level，行为与之前完全一致）
const LOG_LEVEL_FILTER_ALL = 'ALL';
type LogLevelFilter = typeof LOG_LEVEL_FILTER_ALL | 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';

// O-25：SSE 断线短退避自动重连预算——初次断线后先重连至多 MAX_SSE_AUTO_RETRIES
// 次（退避 SSE_RETRY_BASE_MS × 2^(n-1)：1.5s → 3s），重连成功（onStatus 'live'）
// 即重置计数；重连耗尽或收到服务端终态 event: error（带 data）后，再降级为
// 下方 streamDisconnected 驱动的 8s 轮询。替代旧 reconnect:false「一次毛刺即丢流」。
const SSE_RETRY_BASE_MS = 1500;
const MAX_SSE_AUTO_RETRIES = 2;

// UI-05: Tab key 与 URL ?tab= 双向记忆（ApplicationDetailPage 先例）——
// 刷新/分享链接回到原 Tab；非法值回退默认 Tab（日志）。
const TAB_KEY_DEFAULT = 'logs';
const TAB_KEYS = ['logs', 'report', 'retry', 'context'] as const;
type TabKey = (typeof TAB_KEYS)[number];

function normalizeTabKey(raw: string | null): TabKey {
  return (TAB_KEYS as readonly string[]).includes(raw || '') ? (raw as TabKey) : TAB_KEY_DEFAULT;
}

/** UI-09：执行信息 Descriptions 响应式列数（xs 单列 / sm 2 列 / md 3 列）。
 *  注意：antd 的 `Descriptions.Item.span` 只接受 number（见 antd/es/descriptions
 *  index.d.ts），传响应式对象无效。跨列项（失败分类/错误信息）改为放在下方
 *  独立的单列 Descriptions 中渲染——既保证整行宽度，又避免窄屏 xs 单列时
 *  旧写法 span={3} 超出列数（antd「Sum of column span not match column」警告
 *  + 内容按 3 列宽撑破卡片）。 */
export const UI09_DESCRIPTIONS_COLUMN = { xs: 1, sm: 2, md: 3 } as const;

export default function ExecutionDetailPage() {
  const { t } = useTranslation();
  // F-15（DEEP_REVIEW 0ef3bbe）：语义色/边框走 antd token，暗色主题自适应。
  const { token: antdToken } = theme.useToken();
  const statusMap = STATUS_MAP(t);
  const triggerLabels = TRIGGER_LABEL(t);
  const failureReasonMap = FAILURE_REASON_MAP(t);
  const { taskId, execId } = useParams<{ taskId: string; execId: string }>();
  const nav = useNavigate();
  const logRef = useRef<HTMLPreElement>(null);
  const [retrying, setRetrying] = useState(false);
  // P1-26：重新触发确认 Modal 可见性
  const [retriggerOpen, setRetriggerOpen] = useState(false);
  const [killing, setKilling] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [streamLines, setStreamLines] = useState<string[] | null>(null);
  // PERF-06（本轮体验审查）：SSE 日志追加改**批量累积 + 按帧刷新**。
  //
  // 原实现 `setStreamLines((prev) => [...prev, line])` 每来一行就：
  //   ① 复制整个数组（O(n)）；② 触发一次渲染，而渲染里第 388 行会
  //   `streamLines.join('\n')` 再走一遍 O(n)。
  // 一个持续输出的任务每秒可推几十行，于是**每行**都付 O(n)——累计 O(n²)。
  // 20k 行时单次 join 就是 20k 字符串拼接，页面随日志增长越来越卡，
  // 直到日志区滚动/打字都跟着掉帧（渲染在主线程，与 SSE 回调同线程）。
  //
  // 改为把到达的行推进 ref 缓冲，用 requestAnimationFrame 合并成一帧一次
  // 的 state 更新：无论一帧里来几行（0 行也行、50 行也行），每帧最多一次
  // 数组拷贝 + 一次渲染。join 的结果另用 useMemo 缓存（见 rawLogs），
  // 避免"父组件因别的原因重渲也重算 join"。
  const pendingStreamLinesRef = useRef<string[]>([]);
  const streamFlushRafRef = useRef<number | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [streamDisconnected, setStreamDisconnected] = useState(false);
  const [reconnectKey, setReconnectKey] = useState(0);
  // OBS-03: 级别过滤拉取的时序守卫——快速连续切换级别时只让最新一次
  // 请求的响应落地，过期响应（晚到的旧 seq）直接丢弃。
  const levelFetchSeq = useRef(0);
  // NETOPT-7②（2026-09-20）：完整日志拉取的时序守卫，与 levelFetchSeq 同型。
  // "加载完整日志"是最多 LOG_MAX_PAGES 页×顺序请求的长链路（可达数秒）；重试链
  // 的兄弟执行 Link（同路由 :execId 组件不重挂）切执行时 U2 effect 重置
  // fullLogs=null，旧执行的晚到响应若无守卫会 setFullLogs(旧日志) 把新执行的
  // 日志区（含复制/下载）打回旧内容。序号在切执行的重置 effect 里自增，
  // 使旧执行在途请求整体失效。
  const fullLogsFetchSeq = useRef(0);
  // O-5：SSE 断流轮询的当前退避延迟（起步 SSE_POLL_BASE_MS，每次成功轮询翻倍，封顶）。
  const ssePollDelayRef = useRef(SSE_POLL_BASE_MS);
  // U2: 截断日志兜底——"加载完整日志"成功后覆盖显示（null=未加载）
  const [fullLogs, setFullLogs] = useState<string | null>(null);
  const [loadingFullLogs, setLoadingFullLogs] = useState(false);
  /**
   * P1-25（UX-AUDIT-2026-09-21）：完整日志拉取是否被 2 万行上限截断。
   * 此前只弹一次 transient toast，用户滚动几屏后 toast 早已消失，界面上不留任何
   * "这份日志不完整"的持久痕迹——而缺的恰是尾部的堆栈。
   */
  const [fullLogsTruncated, setFullLogsTruncated] = useState(false);
  // OBS-03: 级别过滤（服务端过滤）——非 ALL 时经分页端点带 level 拉取过滤后
  // 行集，结果落在 filteredLogs（优先级高于 fullLogs/rawLogs）
  const [levelFilter, setLevelFilter] = useState<LogLevelFilter>(LOG_LEVEL_FILTER_ALL);
  const [filteredLogs, setFilteredLogs] = useState<string | null>(null);
  const [loadingFilteredLogs, setLoadingFilteredLogs] = useState(false);
  /**
   * P1-25（UX-AUDIT-2026-09-21）：过滤视图是否因 2 万行上限被截断。
   *
   * 独立 state 承载（而非沿用 fullLogs 的判据）：过滤视图有自己的分页拉取，
   * 它的截断与"完整日志"的截断是两回事，混用会漏报其中一种。
   */
  const [filteredTruncated, setFilteredTruncated] = useState(false);
  // UI-05: 关键词搜索——inputKeyword 即时回显（受控输入）、activeKeyword
  // 防抖后生效触发分段重算（大日志逐键重切分代价高）。
  const [inputKeyword, setInputKeyword] = useState('');
  const [activeKeyword, setActiveKeyword] = useState('');

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

  // python_task_multiversion：解释器留痕归一（防御式，见 interpreter-context.ts）。
  // 必须在下方 loading/error 早退**之前**调用（hook 数不随渲染分支变化）。
  // 任何异常形状都退化为 null，本页只是少展示一块信息，绝不因此抛错。
  const interpreterCtx = useMemo(
    () => extractInterpreterContext(data?.result),
    [data?.result],
  );
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

  // SSE log streaming when running
  // F-08（DEEP_REVIEW 0ef3bbe）：自建 EventSource 收敛到统一 createSseClient 工厂
  // （与 useMetricsStream / useExecutionsStream 同源）。
  // O-25：旧实现 reconnect:false——任何断线（含瞬时网络抖动）立刻标记断流并降级
  // 8s 轮询，一次毛刺就丢掉实时流。现改为：断线先短退避自动重连至多
  // MAX_SSE_AUTO_RETRIES 次（1.5s → 3s），onStatus('live') 即重置计数；重连耗尽或
  // 收到服务端终态 event: error（带 data，流已被 end）后再降级 8s 轮询兜底。
  // 工厂内置的无限退避重连在此显式关闭（reconnect:false），改由本 effect 控制预算。
  useEffect(() => {
    if (data?.status !== 'running' && data?.status !== 'pending') return;
    setStreaming(true);
    setStreamDisconnected(false);
    setStreamLines([]);
    // PERF-06：换执行/重连时清空增量缓冲，避免上一轮的残留行混进新日志。
    pendingStreamLinesRef.current = [];

    let client: { close: () => void } | null = null;
    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let gaveUp = false;
    let cleanedUp = false;

    const clearRetryTimer = () => {
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const startClient = () => {
      // 关掉上一轮 client（重连时旧 es 已被工厂 onerror 关闭，这里幂等收尾）
      client?.close();
      client = null;
      client = createSseClient({
        baseUrl: getSseBase(),
        path: `/tasks/${taskId}/executions/${execId}/logs/stream`,
        reconnect: false,
        onMessage: (e) => {
          try {
            const line = JSON.parse(e.data) as string;
            // PERF-06：只入缓冲，由 rAF 合并刷新（见 pendingStreamLinesRef 注释）。
            pendingStreamLinesRef.current.push(line);
            if (streamFlushRafRef.current === null) {
              streamFlushRafRef.current = requestAnimationFrame(() => {
                streamFlushRafRef.current = null;
                const batch = pendingStreamLinesRef.current;
                if (batch.length === 0) return;
                pendingStreamLinesRef.current = [];
                setStreamLines((prev) => (prev ? prev.concat(batch) : batch.slice()));
              });
            }
          } catch { /* ignore malformed */ }
        },
        onStatus: (status) => {
          if (status === 'live') {
            // 连接真正建立：重置重连预算（长连接中途再断可重新重试）
            retryCount = 0;
            return;
          }
          if (status !== 'reconnecting' || gaveUp || cleanedUp) return;
          // 建连/换票失败或传输层断连 → 短退避自动重连（reconnect:false 下工厂只
          // 回调 onStatus('reconnecting') 而不重建）。
          if (retryCount < MAX_SSE_AUTO_RETRIES) {
            retryCount += 1;
            const delay = SSE_RETRY_BASE_MS * 2 ** (retryCount - 1);
            clearRetryTimer();
            retryTimer = setTimeout(() => {
              retryTimer = null;
              if (!cleanedUp) startClient();
            }, delay);
          } else {
            gaveUp = true;
            clearRetryTimer();
            client?.close();
            client = null;
            setStreaming(false);
            // 执行仍未终态：标记断流，交由轮询兜底并提示用户
            if (data?.status === 'running' || data?.status === 'pending') {
              setStreamDisconnected(true);
            }
          }
        },
        events: {
          done: () => {
            client?.close();
            client = null;
            setStreaming(false);
            setStreamDisconnected(false);
            refresh(); // final status refresh
          },
          error: (e: MessageEvent) => {
            // 服务端显式 event: error（带 data，流已被服务端 end）= 终态错误，
            // 不做自动重连，直接降级轮询。纯传输层断连的 error 事件无 data，
            // 已由 onStatus('reconnecting') 走上面的短退避重连路径，这里忽略。
            if (!e.data) return;
            gaveUp = true;
            clearRetryTimer();
            client?.close();
            client = null;
            setStreaming(false);
            if (data?.status === 'running' || data?.status === 'pending') {
              setStreamDisconnected(true);
            }
          },
        },
      });
    };

    startClient();

    return () => {
      cleanedUp = true;
      clearRetryTimer();
      client?.close();
      client = null;
      // PERF-06：取消挂起的 rAF，否则卸载后回调仍会 setState（React 会警告
      // "state update on an unmounted component"，且会白做一次数组拷贝）。
      if (streamFlushRafRef.current !== null) {
        cancelAnimationFrame(streamFlushRafRef.current);
        streamFlushRafRef.current = null;
      }
      pendingStreamLinesRef.current = [];
      setStreaming(false);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.status, execId, taskId, reconnectKey]);

  // SSE 断流后的轮询兜底：仅对未终态执行刷新，到达终态后自动停止。
  // U3: 标签页不可见时跳过请求（回到前台后下一拍即恢复刷新）。
  // O-5：指数退避——起步 8s，每次轮询后翻倍至封顶 60s；新一次断流重新起步，
  // 避免长时间断流时固定每 8s 打一次请求。
  useEffect(() => {
    if (!streamDisconnected || !isLive) return;
    ssePollDelayRef.current = SSE_POLL_BASE_MS;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (document.visibilityState === 'visible') {
        refresh();
        ssePollDelayRef.current = Math.min(
          ssePollDelayRef.current * 2,
          SSE_POLL_MAX_MS,
        );
      }
      timer = setTimeout(tick, ssePollDelayRef.current);
    };
    timer = setTimeout(tick, ssePollDelayRef.current);
    return () => clearTimeout(timer);
  }, [streamDisconnected, isLive, refresh]);

  // U2: 切换执行记录时丢弃上一条已加载的完整日志与过滤结果
  useEffect(() => {
    // NETOPT-7②：自增序号使旧执行在途的完整日志请求整体失效（晚到不回写）；
    // loadingFullLogs 一并复位，避免旧请求的 finally 被 seq 拦截后转圈卡死。
    fullLogsFetchSeq.current += 1;
    setFullLogs(null);
    setLoadingFullLogs(false);
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
  //
  // PERF-06（本轮体验审查）：join 用 useMemo 缓存。原先它写在渲染函数体里
  // **无条件**执行——父组件因任何原因重渲（搜索框打字、级别下拉、重试链数据
  // 到达……）都会把整份日志重新拼一遍。日志越长这次白工越贵，而它与这些
  // state 毫无关系。依赖只有 streamLines 与 data?.logs 两个真正决定结果的量。
  const rawLogs = useMemo(
    () => (streamLines ? streamLines.join('\n') : (data?.logs ?? '')),
    [streamLines, data?.logs],
  );

  const displayLogs = filteredLogs ?? fullLogs ?? rawLogs;
  /**
   * P1-25（UX-AUDIT-2026-09-21）：截断告警必须描述**当前正在显示的那份日志**。
   *
   * 两个方向都要对：
   *  ① **不能漏报**——旧判据是 `filteredLogs === null && fullLogs === null &&
   *     MARKER.test(rawLogs)`，只在显示原始载荷时才提示，于是在**过滤视图被
   *     截断时恰恰被抑制**：用户按级别过滤后读到一份看起来完整、实则缺尾部的
   *     日志，而堆栈与致命错误行就在尾部。
   *  ② **不能误报**——一旦"加载完整日志"成功替换了内容（且那次拉取没有被截断），
   *     原始载荷里的截断标记已不代表眼前这份日志，此时再挂着"日志已截断"会
   *     误导用户以为自己看的仍是不全的版本。
   *
   * 故按**视图优先级**判定（与 displayLogs 同一套优先级）：
   *   过滤视图在用 → 看它自己的截断标志；
   *   否则完整日志在用 → 看它自己的截断标志；
   *   否则显示原始载荷 → 看载荷内的标记。
   */
  const logsTruncated = filteredLogs !== null
    ? filteredTruncated
    : fullLogs !== null
      ? fullLogsTruncated
      : LOG_TRUNCATION_MARKER.test(rawLogs);

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
  const fetchAllLogLines = async (
    level?: string,
    maxLines?: number,
  ): Promise<{ lines: string[]; truncated: boolean }> => {
    const all: string[] = [];
    let fromLine = 0;
    let truncated = false;
    for (let page = 0; page < LOG_MAX_PAGES; page++) {
      const resp = await tasksApi.executionLogs(
        taskId!, execId!,
        level ? { fromLine, limit: LOG_PAGE_LIMIT, level } : { fromLine, limit: LOG_PAGE_LIMIT },
      );
      const lines = Array.isArray(resp?.lines) ? resp.lines : [];
      if (lines.length === 0) break;
      all.push(...lines);
      fromLine += lines.length;
      // F-11: 行数上限保护——超过 maxLines 即停拉，避免全量 join 巨型字符串
      if (maxLines !== undefined && all.length >= maxLines) {
        truncated = true;
        all.length = maxLines;
        break;
      }
      if (!resp?.hasMore) break;
    }
    return { lines: all, truncated };
  };

  // U2: 回调日志被执行器截断时，从全量日志端点按行分页拉全（后端 limit 上限
  // 2000/页，hasMore 驱动翻页）。成功替换显示与复制/下载内容；失败 toast 保留现状。
  // F-11: 行数超过 FULL_LOGS_MAX_LINES 时停拉并提示"日志过大，建议下载查看"。
  // NETOPT-7②：所有 setState 落地前先比对 seq——切执行后旧请求的晚到响应
  // （成功/catch/finally 三条路径）一律静默丢弃，不打回新执行的状态。
  const handleLoadFullLogs = async () => {
    if (!taskId || !execId) return;
    const seq = ++fullLogsFetchSeq.current;
    setLoadingFullLogs(true);
    try {
      const { lines: all, truncated } = await fetchAllLogLines(
        undefined,
        FULL_LOGS_MAX_LINES,
      );
      if (fullLogsFetchSeq.current !== seq) return;
      if (all.length === 0) {
        throw new Error(t('execDetail.fullLogsNoRows'));
      }
      setFullLogs(all.join('\n'));
      // P1-25：持久记录截断状态（toast 是瞬时的，滚动几屏后就不见了）
      setFullLogsTruncated(truncated);
      if (truncated) {
        message.warning(t('execDetail.fullLogsTooLarge'));
      } else {
        message.success(t('execDetail.fullLogsLoaded'));
      }
    } catch (err: unknown) {
      if (fullLogsFetchSeq.current !== seq) return;
      message.error(getErrMsg(err, t('execDetail.fullLogsLoadFail')));
    } finally {
      if (fullLogsFetchSeq.current === seq) setLoadingFullLogs(false);
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
      setFilteredTruncated(false);
      return;
    }
    if (!taskId || !execId) return;
    setLoadingFilteredLogs(true);
    try {
      // P1-25（UX-AUDIT-2026-09-21）：**必须**接住 truncated。
      //
      // 此前只解构 lines、丢弃 truncated，而截断告警（logsTruncated）又被硬门控在
      // `filteredLogs === null && fullLogs === null`——**恰好在过滤视图被截断时
      // 它被抑制**。两条叠加：用户按级别过滤后读到一份看起来完整、实则缺尾部的
      // 日志，而堆栈与致命错误行**就在尾部**。这正是"任务失败找不到原因"的现场。
      const { lines: all, truncated } = await fetchAllLogLines(value, FULL_LOGS_MAX_LINES);
      if (levelFetchSeq.current !== seq) return;
      setFilteredLogs(all.join('\n'));
      setFilteredTruncated(truncated);
    } catch (err: unknown) {
      if (levelFetchSeq.current !== seq) return;
      setFilteredLogs(null);
      setFilteredTruncated(false);
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
  // UI-05: 建议动作（未知键回退 unknown 兜底）。P1-27：第三参传 status——
  // cancelled 由调度器自动覆盖产生、不落 failureReason，必须按 status 命中。
  const runbookAction = failureRunbookAction(data?.failureReason, t, data?.status);
  const runbookText = taskData?.runbook || null;
  // 「3.7 需离线预填」指引的可见性（判据见 interpreterNeedsOfflinePrefill）
  const interpreterOfflinePrefill = interpreterNeedsOfflinePrefill(interpreterCtx);

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
            {/* F-33（DEEP_REVIEW 0ef3bbe）：原 <a onClick> 无 href，改 <Link>（键盘可达 + 真实 href） */}
            <Link to={`/tasks/${taskId}`}>{data?.taskName}</Link>
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
            {data?.duration != null ? formatDuration(data.duration, t) : '-'}
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
        </Descriptions>
        {/* UI 打磨：失败分类/错误信息独占整行——Item.span 不支持响应式对象，
            单独用一个单列 Descriptions 渲染，长错误信息不再被挤在 1/3 列宽里 */}
        {(failureReason || data?.errorMessage) && (
          <Descriptions column={1} size="small" style={{ marginTop: 4 }}>
            {failureReason && (
              <Descriptions.Item label={t('execDetail.field.failureCategory')}>
                <Space wrap>
                  <Tag color={failureReason.color}>{failureReason.label}</Tag>
                  <Text type="secondary">{failureReason.hint}</Text>
                </Space>
              </Descriptions.Item>
            )}
            {data?.errorMessage && (
              <Descriptions.Item label={t('execDetail.field.errorMessage')}>
                <Text type="danger" style={{ wordBreak: 'break-word' }}>{data.errorMessage}</Text>
              </Descriptions.Item>
            )}
          </Descriptions>
        )}
        {/* python_task_multiversion（AC-12a）：结构化解释器留痕。
            后端 DTO 可能尚未回传 `result`——整块以 interpreterCtx !== null 为唯一
            门控，历史执行/非解释器类失败下此块**根本不渲染**（不留空壳），页面
            其余部分完全不受影响。 */}
        {interpreterCtx && (
          // 「3.7 需离线预填」专项指引：requested < 3.8 或 reason=not_downloadable
          // 时置顶（判据独立于 reason 文案，见 interpreterNeedsOfflinePrefill）。
          <div data-testid="execution-interpreter" style={{ marginTop: 8 }}>
            {interpreterOfflinePrefill && (
              <Alert
                type="warning"
                showIcon
                data-testid="interpreter-offline-prefill"
                title={t('execDetail.interpreter.offlinePrefillTitle')}
                description={
                  <span>
                    {t('execDetail.interpreter.offlinePrefillDesc')}{' '}
                    {/* E-2：补「前往执行器配置」跳转，运维无需自行翻文档找入口 */}
                    <Link to="/executors">{t('execDetail.interpreter.offlinePrefillGoExecutors')}</Link>
                  </span>
                }
                style={{ marginBottom: 12 }}
              />
            )}
            <Descriptions
              column={UI09_DESCRIPTIONS_COLUMN}
              size="small"
              title={t('execDetail.interpreter.title')}
            >
              <Descriptions.Item label={t('execDetail.interpreter.requested')}>
                {/* 逐项独立兜底：某个字段没留痕只影响它自己那一格，
                    不让一个 null 把整块快照变成空白。 */}
                {interpreterCtx.requested ?? (
                  <Text type="secondary">{t('execDetail.interpreter.missing')}</Text>
                )}
              </Descriptions.Item>
              <Descriptions.Item label={t('execDetail.interpreter.resolved')}>
                {interpreterCtx.resolved ? (
                  <Text code style={{ fontSize: 12, wordBreak: 'break-all' }}>
                    {interpreterCtx.resolved}
                  </Text>
                ) : (
                  <Text type="secondary">{t('execDetail.interpreter.missing')}</Text>
                )}
              </Descriptions.Item>
              <Descriptions.Item label={t('execDetail.interpreter.reason')}>
                {/* 未收录的 reason 原样展示 token——宁可露出 `some_new_reason`
                    也不要显示"未知原因"把可诊断信息抹掉（与 failureReason 同策）。 */}
                {interpreterCtx.reason ? (
                  <Space size={4}>
                    <Tag color="gold">{interpreterCtx.reason}</Tag>
                    <Text type="secondary">
                      {INTERPRETER_REASON_T_KEY[interpreterCtx.reason]
                        ? t(INTERPRETER_REASON_T_KEY[interpreterCtx.reason])
                        : interpreterCtx.reason}
                    </Text>
                  </Space>
                ) : (
                  <Text type="secondary">{t('execDetail.interpreter.missing')}</Text>
                )}
              </Descriptions.Item>
              <Descriptions.Item label={t('execDetail.interpreter.pool')} span={UI09_DESCRIPTIONS_COLUMN.md}>
                {interpreterCtx.pool ? (
                  <Space orientation="vertical" size={2} style={{ width: '100%' }}>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {t('execDetail.interpreter.poolDir')}：
                      {interpreterCtx.pool.installDir || '-'}
                    </Text>
                    {interpreterCtx.pool.versions.length > 0 ? (
                      <Space orientation="vertical" size={2} style={{ width: '100%' }}>
                        {/* poolVersions：缓存版本清单的小标题（此前是零渲染点的死键） */}
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {t('execDetail.interpreter.poolVersions')}：
                        </Text>
                        <Space size={4} wrap>
                          {interpreterCtx.pool.versions.map((v) => (
                            <Tag key={v} style={{ fontFamily: 'var(--font-mono)' }}>{v}</Tag>
                          ))}
                        </Space>
                      </Space>
                    ) : (
                      <Text type="secondary">{t('execDetail.interpreter.poolEmpty')}</Text>
                    )}
                  </Space>
                ) : (
                  <Text type="secondary">{t('execDetail.interpreter.missing')}</Text>
                )}
              </Descriptions.Item>
              {/* detail 常是部署指引原文（可能较长），独占整行并保留换行 */}
              {interpreterCtx.detail && (
                <Descriptions.Item
                  label={t('execDetail.interpreter.detail')}
                  span={UI09_DESCRIPTIONS_COLUMN.md}
                >
                  <Text style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {interpreterCtx.detail}
                  </Text>
                </Descriptions.Item>
              )}
            </Descriptions>
          </div>
        )}
        {/* python_task_multiversion（P2-1）：failureReason 已归类为
            interpreter_unavailable、却没有结构化快照（旧执行器 / 尚未实现
            result 通道的执行器版本）时，给一条明确说明而不是整块消失——否则
            运维在解释器类失败下既看不到快照卡也看不到任何解释。正常路径
            （非解释器类失败 / 有快照）不渲染，保持"不留空壳"的原决策。 */}
        {!interpreterCtx && data?.failureReason === 'interpreter_unavailable' && (
          <Alert
            type="warning"
            showIcon
            data-testid="execution-interpreter-no-snapshot"
            style={{ marginTop: 8 }}
            title={t('execDetail.interpreter.noSnapshot')}
          />
        )}
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
                                maxHeight: 240,
                                overflow: 'auto',
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
                        <Button size="small" danger icon={<RedoOutlined />} onClick={openRetrigger} loading={retrying}>
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
                          onClick={async () => {
                          // OBS-03 取舍：复制反映"当前视图"（所见即所得）——级别
                          // 过滤生效时复制过滤视图，"全部"时复制当前展示内容
                          // （可能含 SSE 流缓冲）。需要全量请切回"全部"后复制。
                          // F-18（DEEP_REVIEW 0ef3bbe）：补错误处理——失败不弹成功提示。
                          const ok = await copyText(displayLogs);
                          if (ok) message.success(t('execDetail.log.copied'));
                          else message.error(t('execDetail.log.copyFailed'));
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
                          borderBottom: `1px solid ${antdToken.colorBorderSecondary}`,
                          flexWrap: 'wrap',
                        }}
                      >
                        <Tag color={RETRY_STATUS_COLOR[link.status] || 'default'}>Attempt #{link.retryCount}</Tag>
                        {link.execId === data?.id ? (
                          <Text strong>{t('execDetail.retry.currentExec')}</Text>
                        ) : (
                          <Link to={`/tasks/${taskId}/executions/${link.execId}`}>
                            {link.execId.slice(0, 8)}…
                          </Link>
                        )}
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {link.triggerType ? triggerLabels[link.triggerType] ?? link.triggerType : '-'}
                          {link.executorAddress ? ` · ${link.executorAddress}` : ''}
                        </Text>
                        {link.failureReason && (
                          <Tag>{failureReasonMap[link.failureReason]?.label ?? link.failureReason}</Tag>
                        )}
                        {link.errorMessage && (
                          // flex 子项内 ellipsis 生效需 minWidth:0 + flex 收缩，
                          // 否则长错误按内容撑破重试链卡片
                          <Text type="danger" style={{ fontSize: 12, flex: '1 1 auto', minWidth: 0 }} ellipsis>
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
                message={t('execDetail.retriggerConfirm.differs')}
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

