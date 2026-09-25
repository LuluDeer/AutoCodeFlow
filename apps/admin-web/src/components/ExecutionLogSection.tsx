/**
 * REFACTOR-EXEC-03：执行日志子系统（原 ExecutionDetailPage「执行日志」Tab 整体迁出）。
 *
 * 职责边界：
 * - SSE 实时流（断线短退避重连 → 预算耗尽降级轮询兜底）；
 * - 级别过滤 / 完整日志拉取（分页 + 截断守卫）/ 关键词高亮；
 * - 日志渲染（≤500 行 <pre> 折行形态 / >500 行 LogWindow 窗口化）；
 * - 失败定位卡片（failed/timeout 置顶，含运行手册与重新触发入口）。
 *
 * 与父页的接缝：
 * - `refresh`：SSE done / 断流轮询兜底共用的执行详情 query refetch；
 * - `onStreamStatusChange`：SSE 生命周期上报——父页页头「实时更新」徽标与
 *   断流告警条消费（徽标/alert 的 DOM 位置在页头，无法随日志子系统迁移）；
 * - `reconnectKey`：父页「重新连接」按钮递增此键，强制重建 SSE 连接
 *   （effect 依赖含此键，重建时内部自行复位断流标记）。
 */
import { Badge, Card, Typography, Button, Space, Alert, Select, Input } from 'antd';
import { CopyOutlined, DownloadOutlined, SearchOutlined, BookOutlined, ExperimentOutlined, RedoOutlined, LinkOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { message } from '../utils/toast';
import { tasksApi } from '../api/tasks';
import type { TaskExecution } from '../api/tasks';
import { getApiBaseUrl } from '../api/client';
import { createSseClient } from '../api/sse-client';
import { getErrMsg } from '../utils/error';
import { copyText } from '../utils/clipboard';
import { LOG_LEVEL_VALUES, logLineHighlightClass } from '../utils/logLevel';
// UI-05: 搜索高亮分段（纯函数）+ 防抖常量
import { buildLogSearchSegments, LOG_SEARCH_DEBOUNCE_MS } from '../utils/log-search';
// UI-05: 失败定位映射（语义镜像 mcp FAILURE_RUNBOOK，BUG-10 分类 + 解释器不可用）
import { failureRunbookAction, FAILURE_CARD_STATUSES } from '../pages/failure-runbook';
// LOG-WIN-01：大日志窗口化渲染组件（零依赖虚拟滚动，见组件头注释）
import LogWindow from './LogWindow';

const { Text } = Typography;

/** 失败分类标签（label-only；完整 map 与解释见 ExecutionInfoCard）。
 *  未知 token 回退原始值——宁可露出 `some_new_reason` 也不丢可检索信息。 */
const FAILURE_REASON_LABELS = (t: (k: string) => string): Record<string, string> => ({
  package_fetch_failed: t('execDetail.failure.packageFetchFailed'),
  git_fetch_failed: t('execDetail.failure.gitFetchFailed'),
  dependency_install_failed: t('execDetail.failure.dependencyInstallFailed'),
  runtime_missing: t('execDetail.failure.runtimeMissing'),
  sandbox_unavailable: t('execDetail.failure.sandboxUnavailable'),
  interpreter_unavailable: t('execDetail.failure.interpreterUnavailable'),
  script_error: t('execDetail.failure.scriptError'),
  timeout: t('execDetail.failure.timeout'),
  executor_offline: t('execDetail.failure.executorOffline'),
  executor_restart: t('execDetail.failure.executorRestart'),
  stale_recovered: t('execDetail.failure.staleRecovered'),
  killed: t('execDetail.failure.killed'),
  application_missing: t('execDetail.failure.applicationMissing'),
  never_dispatched: t('execDetail.failure.neverDispatched'),
  unknown: t('execDetail.failure.unknown'),
});

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
// （下载走 blob，不受渲染层约束）。
// LOG-WIN-01：渲染层断崖已由 LogWindow 窗口化消除，但 join + SSE 流缓冲的
// 内存峰值约束仍在，拉取上限维持 2 万行不变。
const FULL_LOGS_MAX_LINES = 20_000;
// LOG-WIN-01：日志渲染形态切换阈值——≤500 行沿用原 <pre>（折行/分段高亮
// 完整形态，单测锚定行为不变），>500 行切换 LogWindow 窗口化渲染。
const LOG_VIRTUAL_THRESHOLD = 500;
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

export interface ExecutionLogSectionProps {
  taskId: string;
  execId: string;
  /** 执行详情实体（SSE 启停按 status 判定；失败卡片读 failureReason 等） */
  data: TaskExecution | undefined;
  /** 执行详情 query refetch——SSE done / 断流轮询兜底共用 */
  refresh: () => void;
  isLive: boolean;
  /** SSE 生命周期上报（父页页头徽标 + 断流告警条消费） */
  onStreamStatusChange: (s: { streaming: boolean; disconnected: boolean }) => void;
  /** 父页「重新连接」按钮递增此键 → 重建 SSE */
  reconnectKey: number;
  /** 任务运行手册（失败卡片内联展示；无则不渲染该块） */
  runbookText: string | null;
  /** 当前状态的本地化标签（页头 Tag 同源，供失败卡片标题拼接） */
  statusLabel: string;
  onRetrigger: () => void;
  retriggering: boolean;
  /** 失败卡片「查看 AI 分析与时间线」→ 父页切到 report Tab */
  onJumpToReport: () => void;
}

export default function ExecutionLogSection({
  taskId,
  execId,
  data,
  refresh,
  isLive,
  onStreamStatusChange,
  reconnectKey,
  runbookText,
  statusLabel,
  onRetrigger,
  retriggering,
  onJumpToReport,
}: ExecutionLogSectionProps) {
  const { t } = useTranslation();
  const logRef = useRef<HTMLPreElement>(null);
  const [streamLines, setStreamLines] = useState<string[] | null>(null);
  // PERF-06（本轮体验审查）：SSE 日志追加改**批量累积 + 按帧刷新**。
  //
  // 原实现 `setStreamLines((prev) => [...prev, line])` 每来一行就：
  //   ① 复制整个数组（O(n)）；② 触发一次渲染，而渲染里会
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

  /** SSE 生命周期 → 父页（页头徽标/断流告警）。合并去重避免无谓的父渲染。 */
  const reportStream = (s: { streaming: boolean; disconnected: boolean }) => {
    onStreamStatusChange(s);
  };

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
    reportStream({ streaming: true, disconnected: false });
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
              reportStream({ streaming: false, disconnected: true });
            }
          }
        },
        events: {
          done: () => {
            client?.close();
            client = null;
            setStreaming(false);
            setStreamDisconnected(false);
            reportStream({ streaming: false, disconnected: false });
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
              reportStream({ streaming: false, disconnected: true });
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
      reportStream({ streaming: false, disconnected: false });
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
    const timer = setTimeout(() => setActiveKeyword(inputKeyword.trim()), LOG_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
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

  // LOG-WIN-01：行数超过阈值即切换 LogWindow 窗口化渲染（见组件头注释）。
  // 行数从 displayLogs 派生——SSE 流式追加时随 text 变化自动在两态间切换。
  const logLineCount = displayLogs ? displayLogs.split('\n').length : 0;
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
        taskId, execId,
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

  // UI-05: 失败定位卡片可见性（failed/timeout；killed 无排障价值不渲染）
  const showFailureCard = FAILURE_CARD_STATUSES.includes(data?.status || '');
  // UI-05: 建议动作（未知键回退 unknown 兜底）。P1-27：第三参传 status——
  // cancelled 由调度器自动覆盖产生、不落 failureReason，必须按 status 命中。
  const runbookAction = failureRunbookAction(data?.failureReason, t, data?.status);
  const failureReasonLabel = data?.failureReason
    ? FAILURE_REASON_LABELS(t)[data.failureReason] ?? data.failureReason
    : undefined;

  return (
    <>
      {/* UI-05: 失败定位卡片——failed/timeout 时置顶日志 Tab */}
      {showFailureCard && (
        <Alert
          type={data?.status === 'timeout' ? 'warning' : 'error'}
          showIcon
          icon={<ExperimentOutlined />}
          data-testid="failure-triage-card"
          title={failureReasonLabel ? `${statusLabel}：${failureReasonLabel}` : statusLabel}
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
                onClick={onJumpToReport}
              >
                {t('execDetail.viewAiTimeline')}
              </Button>
            </div>
          }
          style={{ marginBottom: 16 }}
          action={
            data?.status === 'failed' ? (
              <Button size="small" danger icon={<RedoOutlined />} onClick={onRetrigger} loading={retriggering}>
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
        {/* LOG-WIN-01：>500 行切换窗口化渲染（只画可视窗口行，流式追加
            不再整段重排），≤500 行保持原 <pre> 形态（pre-wrap 折行 +
            分段高亮完整保留，行为与单测锚定不变）。两态共用同一份
            displayLogs 字符串：复制/下载/截断告警全部不受影响。 */}
        {logLineCount > LOG_VIRTUAL_THRESHOLD ? (
          <LogWindow
            text={displayLogs}
            keyword={activeKeyword}
            height={500}
            testId="log-window"
          />
        ) : (
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
        )}
      </Card>
    </>
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
