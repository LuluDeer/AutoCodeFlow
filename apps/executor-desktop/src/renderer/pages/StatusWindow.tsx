import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import UpdateBanner from '../components/UpdateBanner';
import Icon from '../components/Icon';
import LogViewer from '../components/LogViewer';
import LogLineList from '../components/LogLineList';
import ConfirmBar from '../components/ConfirmBar';
import { agentActivityLabel, agentOutcomeLabel, type AgentStatusSnapshot } from '../../main/agent-status-view';
import { requestTabSwitch } from '../tab-switch';
// V4 后续优化（6）i18n 二期：状态页文案入双语表（zh 值与原硬编码逐字一致）。
import { createCfgTexts, resolveRendererLocale } from '../i18n';

const t = createCfgTexts(resolveRendererLocale(() => navigator.language));

// B-02：今日概览条的数据源（history:get）。本页只读少量字段，
// 不需要 HistoryPage 的完整 ExecRecord 形状——保持最小依赖，避免跨页耦合。
// V4-3（I-01）：补充 taskName/executionId/errorMessage——「运行中任务」可见化
// 与右栏「最近失败」卡的数据面（均来自同一份 records，无新 IPC）。
interface TodaySummaryRecord {
  startTime?: number;
  status?: 'running' | 'success' | 'failed';
  taskName?: string;
  executionId?: string;
  errorMessage?: string;
}

declare const window: Window & {
  electronAPI: {
    getStatus: () => Promise<{ running: boolean; status: string; config: Record<string, unknown> }>;
    getAgentStatus?: () => Promise<AgentStatusSnapshot>;
    getHistory?: () => Promise<TodaySummaryRecord[]>;
    getTodayLogs: () => Promise<{ lines: string[]; date: string }>;
    startExecutor: () => Promise<{ ok: boolean }>;
    stopExecutor: () => Promise<{ ok: boolean }>;
    onLogLine: (cb: (line: string) => void) => () => void;
    onStatusChange: (cb: (status: string) => void) => () => void;
    listLogFiles: () => Promise<Array<{ label: string; path: string; date: string }>>;
    openLogFile: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
    writeClipboardText: (text: string) => Promise<{ ok: boolean }>;
  };
};

// D-01：托盘常驻一次性提示的「已读」标记。读写失败（隐私模式等）降级为
// 不显示/仅本会话隐藏——教育条缺位好过每次启动都打扰。
const TRAY_TIP_DISMISSED_KEY = 'acf-tray-tip-dismissed';

type Status = 'online' | 'offline' | 'pending' | 'stopped';

const STATUS_LABEL: Record<Status, string> = {
  online:  t('status.label.online'),
  offline: t('status.label.offline'),
  pending: t('status.label.pending'),
  stopped: t('status.label.stopped'),
};

const STATUS_BADGE: Record<Status, string> = {
  online: 'badge-success',
  offline: 'badge-error',
  pending: 'badge-pending',
  stopped: 'badge-stopped',
};

const STATUS_DESC: Record<Status, string> = {
  online:  t('status.desc.online'),
  offline: t('status.desc.offline'),
  pending: t('status.desc.pending'),
  stopped: t('status.desc.stopped'),
};

function CopyValue({ value, mono = true }: { value: string; mono?: boolean }) {
  // 复制走主进程 Electron clipboard（非安全上下文/权限受限时 navigator.clipboard
  // 会 reject 甚至为 undefined）；成功/失败都给用户明确反馈。
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 1500);
    return () => clearTimeout(timer);
  }, [state]);
  function copy() {
    if (!value || value === '—') return;
    window.electronAPI
      .writeClipboardText(value)
      .then((r) => setState(r?.ok === false ? 'error' : 'copied'))
      .catch(() => setState('error'));
  }
  return (
    <div className="copy-row">
      <span className={`copy-val${mono ? '' : ' copy-val-plain'}`}>{value || '—'}</span>
      {value && value !== '—' && (
        <button
          className={`copy-btn${state === 'copied' ? ' copied' : state === 'error' ? ' copy-failed' : ''}`}
          onClick={copy}
        >
          {state === 'copied' ? <>{t('status.copied')} <Icon name="check" className="icon-xs" /></> : state === 'error' ? t('status.copyFailed') : t('status.copy')}
        </button>
      )}
    </div>
  );
}

// ── 日志行规范化 ──────────────────────────────────────
// 日志区同时混有两种来源的行：
//   a) getTodayLogs() 读回的落盘文件行 —— electron-log 前置了本地时间戳与级别，
//      而 executor-node 的 winston 文本又内嵌一份 UTC ISO 时间戳与级别，
//      于是一行出现两个时间戳且相差 8 小时（用户报障：看着像两条日志）；
//   b) onLogLine 实时行 —— 只有 winston 的一重 UTC 时间戳。
// 此外 winston 行的 [traceId] 是 36 字符完整 UUID，心跳每 30s 一条，
// 整屏日志被时间戳与 traceId 淹没，有效信息反而看不清。
// 这里在写入 state 前统一规范化（纯展示层，不改落盘格式）：
//   [14:38:30.519] [INFO] [23fb6898] Sending heartbeat
// 时间一律显示本地（文件行取外层本地时间；实时行把内嵌 UTC 转本地），
// 级别统一大写并用于精确着色（不再靠 includes('err ') 猜）。
type LogLevel = 'error' | 'warn' | '';
type LogLine = { id: number; level: LogLevel; text: string };
type LogLevelFilter = 'all' | 'warn' | 'error';
const MAX_LOG_LINES = 2000;
const PREVIEW_LOG_LINES = 120;
let nextLogLineId = 0;

function makeLogLine(level: LogLevel, text: string): LogLine {
  return { id: ++nextLogLineId, level, text };
}

function retainRecentLogs(lines: LogLine[]): LogLine[] {
  return lines.length > MAX_LOG_LINES ? lines.slice(-MAX_LOG_LINES) : lines;
}

// 首次读取文件期间可能已有实时行到达：用最长重叠前后缀合并，避免覆盖新行或重复显示。
function mergeHistoryWithLive(history: LogLine[], live: LogLine[]): LogLine[] {
  const maxOverlap = Math.min(history.length, live.length);
  let overlap = 0;
  for (let count = maxOverlap; count > 0; count--) {
    let same = true;
    for (let i = 0; i < count; i++) {
      const a = history[history.length - count + i];
      const b = live[i];
      if (a.level !== b.level || a.text !== b.text) { same = false; break; }
    }
    if (same) { overlap = count; break; }
  }
  return retainRecentLogs([...history, ...live.slice(overlap)]);
}

// electron-log 文件行：[2026-09-23 14:38:30.519] [info] [executor|executor:err] <rest>
// （桌面端自身日志没有 [executor] 段，如 "Status window opened"）
// 捕获组：1=日期 2=时间 3=级别 4=executor/executor:err 5=rest（内层为非捕获组，
// 避免索引数错——曾把 rest 取成第 5 组 ":err" 内捕获，得到 undefined 炸掉渲染）。
const OUTER_LOG_RE =
  /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3})\] \[(info|warn|error|debug)\] (?:\[(executor(?::err)?)\] )?(.*)$/;
// winston 文本行：2026-09-23T06:38:30.519Z [INFO] <rest>（UTC，Z 结尾）
const INNER_LOG_RE =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2}\.\d{3})Z \[(INFO|WARN|ERROR|DEBUG)\] (.*)$/;
// winston traceId 前缀：[23fb6898-e228-4ca2-8ed4-956758b5d2f0] <rest>
const TRACE_ID_RE = /^\[([0-9a-f]{8})(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\] (.*)$/i;

function utcToLocalClock(datePart: string, timePart: string): string {
  const d = new Date(`${datePart}T${timePart}Z`);
  if (Number.isNaN(d.getTime())) return timePart;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function normalizeLogLine(raw: string): LogLine {
  let clock = '';   // 展示用本地时间 HH:mm:ss.SSS
  let level = '';   // 大写级别 INFO/WARN/ERROR/DEBUG
  let rest = raw;
  let childErr = false;

  const outer = OUTER_LOG_RE.exec(raw);
  if (outer) {
    clock = outer[2]; // 外层时间戳已是本地时间，直接取时分秒
    level = outer[3].toUpperCase();
    childErr = outer[4] === 'executor:err';
    rest = outer[5].replace(/^\s+/, '');
    // electron-log v5 落盘时 level 与 scope 之间是「两个空格」（scope 前补一位
    // 对齐），外层正则的可选 [executor] 段因此整体失配——tag、内嵌 winston 头
    // 与完整 UUID trace 全部滞留正文（2026-10-04 写实夹具截图发现，此前所有
    // 「看着已修好」的路径都只覆盖了单空格假设）。对 rest 起始再剥一次 tag；
    // childErr 以先到者为准（executor:err 通道行级别恒按 error 处理）。
    const tag = /^\[(executor(?::err)?)\]\s+(.*)$/.exec(rest);
    if (tag) {
      if (!childErr) childErr = tag[1] === 'executor:err';
      rest = tag[2];
    }
  }

  // 内嵌的 winston 头（文件行的 rest、或实时行的整行）。
  // 级别内层优先：executor:err 通道的行外层 electron-log 恒为 warn，
  // 而 winston 自己的级别（ERROR/WARN）才反映真实严重度。
  const inner = INNER_LOG_RE.exec(rest);
  if (inner) {
    if (!clock) clock = utcToLocalClock(inner[1], inner[2]); // 实时行：UTC → 本地
    level = inner[3];
    rest = inner[4];
  }

  // traceId 截短为前 8 位（足够对日志，完整值仍在落盘文件里）
  const trace = TRACE_ID_RE.exec(rest);
  if (trace) rest = `[${trace[1]}] ${trace[2]}`;

  // 级别：结构化信息优先；自由文本（任务输出等）回退为旧的关键词猜测。
  let lvl: LogLevel = '';
  if (childErr || level === 'ERROR') lvl = 'error';
  else if (level === 'WARN') lvl = 'warn';
  else {
    const l = rest.toLowerCase();
    if (l.includes('error') || l.includes('failed') || l.includes('err ')) lvl = 'error';
    else if (l.includes('warn')) lvl = 'warn';
  }

  // 两种来源都没解析出任何结构（纯文本输出）——原样展示，不强行加壳。
  if (!clock && !level) return makeLogLine(lvl, raw);
  return makeLogLine(lvl, `[${clock}]${level ? ` [${level}]` : ''} ${rest}`);
}

// 规范化后的行形如 `[HH:mm:ss.SSS] [LEVEL] 正文`。渲染时拆成时间 / 级别 /
// 正文三段并分别着色：时间戳与级别不再和正文抢视觉权重，扫读时一眼定位级别。
// FormattedLogText 已收口为共享组件（components/FormattedLogText.tsx）。

// ── 全屏查看器的「日志文件」侧栏（状态页数据源）──────────────
// 共享 LogViewer 只负责「日志文件」开关钮与侧栏显隐；面板本体与数据拉取
// 收在这里。面板节点仅在展开时挂载（查看器 {showFiles && filesPanel}），
// 因此拉取时机与原内联实现的按需加载一致。
function LogFilesPanel() {
  const [fileQuery, setFileQuery] = useState('');
  const [logFiles, setLogFiles] = useState<Array<{ label: string; path: string; date: string }>>([]);
  const [fileError, setFileError] = useState<string | null>(null);

  // 加载日志文件列表
  useEffect(() => {
    // EXP-09（本轮体验审查）：此前是 `listLogFiles().then(setLogFiles)`——
    // 既无 .catch 也无 `typeof === 'function'` 守卫。旧版 preload 未暴露该方法
    // 时这里会**同步抛 TypeError** → React 卸载整棵树 → 窗口只剩背景色（正是
    // preload/index.ts:40-42 记录过的那次事故形态）。同仓 ConfigPage.tsx:93 已
    // 为同类情形写了 typeof 守卫，此处对齐。
    if (typeof window.electronAPI.listLogFiles !== 'function') return;
    let cancelled = false;
    window.electronAPI
      .listLogFiles()
      .then((files) => {
        if (!cancelled) setLogFiles(files);
      })
      .catch(() => {
        // 读取失败时保持空列表（面板显示「暂无日志文件」），不炸整棵渲染树。
        if (!cancelled) setLogFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 打开日志文件失败（关联程序缺失/路径被拒）时给出反馈，而不是点击无反应
  function openFile(p: string) {
    setFileError(null);
    window.electronAPI
      .openLogFile(p)
      .then((r) => { if (!r?.ok) setFileError(r?.error || t('status.openFail')); })
      .catch(() => setFileError(t('status.openFail')));
  }

  const visibleLogFiles = logFiles.filter((file) => `${file.label} ${file.path}`.toLowerCase().includes(fileQuery.trim().toLowerCase()));

  return (
    <div className="log-fs-files">
      <div className="log-fs-files-title">{t('status.filesHistoryHeading', logFiles.length)}</div>
      <input className="log-file-search" type="search" aria-label={t('status.filesSearchAria')} placeholder={t('status.filesSearchPlaceholder')} value={fileQuery} onChange={(event) => setFileQuery(event.target.value)} />
      {fileError && <div className="log-files-error" role="alert">{fileError}</div>}
      {visibleLogFiles.length === 0
        ? <div className="log-files-empty">{fileQuery ? t('status.filesNoMatch') : t('status.filesEmpty')}</div>
        : visibleLogFiles.map((f) => (
            <button
              key={f.path}
              className="log-file-item"
              title={f.path}
              onClick={() => openFile(f.path)}
            >
              <span className="log-file-label">{f.label}</span>
              <span className="log-file-open"><Icon name="external" className="icon-xs" /> {t('ui.open')}</span>
            </button>
          ))
      }
    </div>
  );
}

// 高亮组件见 components/HighlightText.tsx（与 AppsPage 共用）；全屏查看器已
// 抽取为共享组件 components/LogViewer.tsx（历史/应用页随后接入）。

// ── 今日概览条（B-02，§2.4 信息架构重组）──────────────────
// 状态页原先只有进程状态与低频信息卡，高频的「今天跑了多少次 / 败了几次」无处可看。
// 计算口径（与历史页同一数据源，无新 IPC）：
//   · 计入 startTime 落在今天 0 点（本地时区）之后、且 status ∈ success/failed/running
//     的记录（早期/异常记录可能缺 startTime 或 status，均不计入）；
//   · 「最近失败」取今天最近一条 failed 记录的 startTime，拼成本地 HH:mm；
//   · 读取失败 → 返回 null（整条概览不渲染，不谎报「今日暂无」——那是成功读到
//     但 0 条记录时的空态文案）。
interface TodaySummary {
  total: number;
  success: number;
  failed: number;
  running: number;
  lastFailedClock: string | null;
  /** V4-3（I-01）：运行中任务明细（全量不限今日——running 可能来自昨天）。
      startTime 缺失时只显任务名不带时长。 */
  runningTasks: Array<{ id: string; name: string; since: number | null }>;
}

/** 运行中时长（分钟级，随 60s 轮询刷新；<1h 显示 Nm，跨小时 h m）。 */
function formatRunningMs(ms: number): string {
  const totalMin = Math.max(1, Math.floor(ms / 60_000));
  if (totalMin < 60) return `${totalMin}m`;
  return `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`;
}

function summarizeToday(records: TodaySummaryRecord[]): TodaySummary | null {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const sinceTs = since.getTime();
  const summary: TodaySummary = {
    total: 0, success: 0, failed: 0, running: 0, lastFailedClock: null, runningTasks: [],
  };
  let lastFailedAt = 0;
  for (const record of records) {
    const started = typeof record?.startTime === 'number' && Number.isFinite(record.startTime);
    if (record?.status === 'running') {
      // running 明细按全量收集（不限今天）；缺 id 的异常记录用下标兜底键。
      summary.runningTasks.push({
        id: record.executionId || `idx-${summary.runningTasks.length}`,
        name: record.taskName || '未命名任务',
        since: started ? record.startTime : null,
      });
    }
    if (!started) continue;
    if (record.startTime < sinceTs) continue;
    if (record.status !== 'success' && record.status !== 'failed' && record.status !== 'running') continue;
    summary.total += 1;
    summary[record.status] += 1;
    if (record.status === 'failed' && record.startTime >= lastFailedAt) lastFailedAt = record.startTime;
  }
  if (lastFailedAt > 0) {
    const d = new Date(lastFailedAt);
    const p = (n: number) => String(n).padStart(2, '0');
    summary.lastFailedClock = `${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  return summary;
}

// ── 主状态页 ──────────────────────────────────────────
export default function StatusWindow({ active }: { active: boolean }) {
  const [status, setStatus] = useState<Status>('stopped');
  const [running, setRunning] = useState(false);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [agentStatus, setAgentStatus] = useState<AgentStatusSnapshot | null>(null);
  const [agentStatusError, setAgentStatusError] = useState<string | null>(null);
  // 右栏「日志文件」快捷区（与全屏查看器共用 listLogFiles IPC）
  const [logFiles, setLogFiles] = useState<Array<{ label: string; path: string; date: string }>>([]);
  const [railFileError, setRailFileError] = useState<string | null>(null);
  // B-02：今日概览条（hero 与日志工作区之间）的原始历史记录（R4 state 化）。
  // null = 尚未读到 / 读取失败（概览整条不渲染）。概览从它派生（useMemo），
  // C-01 停止确认的「运行中」计数也取自同一份——不为确认条二次发 getHistory。
  const [allRecords, setAllRecords] = useState<TodaySummaryRecord[] | null>(null);
  const todaySummary = useMemo(
    () => (allRecords === null ? null : summarizeToday(allRecords)),
    [allRecords],
  );
  // C-01：运行中任务计数（全量 records，不限今天——running 记录可能来自昨天）。
  // records 未知（null）时按 0 处理：不加摩擦直接停，与现状一致。
  const runningCount = useMemo(
    () => (allRecords ?? []).filter((r) => r?.status === 'running').length,
    [allRecords],
  );
  // V4-3（I-05 右栏）：最近失败 Top3（全量 records，按开始时间倒序）。
  // records 未知（null）时整卡不渲染——不谎报「没有失败」。
  const recentFailures = useMemo(
    () => (allRecords ?? [])
      .filter((r) => r?.status === 'failed')
      .sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0))
      .slice(0, 3),
    [allRecords],
  );
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [acting, setActing] = useState(false);
  const [pendingAction, setPendingAction] = useState<'start' | 'stop' | null>(null);
  // F-22（DEEP_REVIEW 0ef3bbe）：IPC reject 时页内展示错误，避免按钮永久 disabled 且用户无感知
  const [actionError, setActionError] = useState<string | null>(null);
  // C-01：停止执行器页内确认的显隐。仅当 getHistory 读到记录且其中有 running
  // 时才加摩擦；records 未知（读取失败/旧版 preload 缺通道）或运行中为 0 时
  // 直接停——高频用户零任务时的停止路径保持单击即停。
  const [confirmingStop, setConfirmingStop] = useState(false);
  // D-01：托盘常驻一次性提示（C-04 的主窗侧教育）。初始态同步读 localStorage。
  const [showTrayTip, setShowTrayTip] = useState(() => {
    try {
      return window.localStorage.getItem(TRAY_TIP_DISMISSED_KEY) === null;
    } catch {
      return false; // localStorage 不可用：不显示，降级为不打扰
    }
  });
  const [fullscreen, setFullscreen] = useState(false);
  const [logViewerFilter, setLogViewerFilter] = useState<LogLevelFilter>('all');
  const [logViewerShowFiles, setLogViewerShowFiles] = useState(false);
  const [unreadLogs, setUnreadLogs] = useState(0);
  // C-06：预览向上滚动到顶且上方还有未显示行时，浮出「查看更早日志」胶囊入口
  const [previewAtTop, setPreviewAtTop] = useState(false);
  const clearedRef = useRef(false);
  const logRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);

  // 页面常驻挂载；切回状态页时重取配置与进程状态，避免设置保存后仍显示旧值。
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    window.electronAPI
      .getStatus()
      .then((snapshot) => {
        if (cancelled) return;
        setStatus(snapshot.status as Status);
        setRunning(snapshot.running);
        setConfig(snapshot.config);
        setActionError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setActionError(
          t('status.statusApiError', err instanceof Error ? err.message : String(err)),
        );
      })
      .finally(() => { if (!cancelled) setStatusLoaded(true); });
    return () => { cancelled = true; };
  }, [active]);

  useEffect(() => {
    // 启动时先加载当天的历史日志（经 preload 暴露的方法；禁止用
    // window.electronAPI.invoke —— preload 不暴露 invoke，会同步抛异常
    // → React 卸载整棵树 → 主窗口只有背景色黑屏，见 preload/index.ts 注释）
    window.electronAPI.getTodayLogs().then((result: any) => {
      if (result?.lines && result.lines.length > 0) {
        // 过滤掉空行；落盘行是 electron-log+winston 双时间戳形态，
        // 统一经 normalizeLogLine 收敛为单时间戳展示（见上方注释）。
        const validLines = (result.lines as string[]).filter((l) => l.trim().length > 0);
        if (!clearedRef.current) {
          const historical = validLines.slice(-500).map(normalizeLogLine);
          setLogs((live) => mergeHistoryWithLive(historical, live));
        }
      }
    }).catch(() => {});

    const offLog = window.electronAPI.onLogLine((line) => {
      setLogs((prev) => retainRecentLogs([...prev, normalizeLogLine(line)]));
      if (!autoScroll.current) setUnreadLogs((count) => count + 1);
    });
    const offStatus = window.electronAPI.onStatusChange((s) => {
      setStatus(s as Status);
      setRunning(s !== 'stopped');
    });
    return () => { offLog(); offStatus(); };
  }, []);

  useEffect(() => {
    // 状态窗常驻时也要反映分钟级 Agent 指派的开始/完成。沿用设置页的
    // 只读 IPC；旧版 preload 缺通道时只影响这两张信息卡。
    if (!active) return;
    const getAgentStatus = window.electronAPI.getAgentStatus;
    if (typeof getAgentStatus !== 'function') {
      setAgentStatusError(t('status.agentUnsupported'));
      return;
    }
    let cancelled = false;
    let inFlight = false;
    const refresh = () => {
      if (inFlight) return;
      inFlight = true;
      void getAgentStatus()
        .then((snapshot) => {
          if (cancelled) return;
          setAgentStatus(snapshot);
          setAgentStatusError(null);
        })
        .catch(() => {
          if (cancelled) return;
          setAgentStatus(null);
          setAgentStatusError(t('status.agentUnavailable'));
        })
        .finally(() => { inFlight = false; });
    };
    refresh();
    const timer = setInterval(refresh, 2_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [active]);

  // 右栏日志文件列表：旧版 preload 缺通道时直接跳过（分区显示空态，不影响其余面板）；
  // 读取失败静默为空列表，与全屏查看器同一口径，不炸渲染树。
  useEffect(() => {
    if (!active) return;
    const listLogFiles = window.electronAPI.listLogFiles;
    if (typeof listLogFiles !== 'function') return;
    let cancelled = false;
    listLogFiles()
      .then((files) => { if (!cancelled) setLogFiles(files); })
      .catch(() => { if (!cancelled) setLogFiles([]); });
    return () => { cancelled = true; };
  }, [active]);

  useEffect(() => {
    if (autoScroll.current && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs, active]);

  // B-02：今日概览数据。active 变 true 时拉一次（含从配置页保存后切回的刷新）。
  // V4 后续优化（7）：轮询口径与历史页统一为 10s——同一份 getHistory 两个页面
  // 各自消费，频率一致才能避免「活动条 9 次 / 历史页 10 次」的短暂数字漂移；
  // 单次 IPC 是读内存 meta 列表，10s 频率无压力。
  // 旧版 preload 缺 getHistory 通道时整条不渲染（typeof 守卫对齐 EXP-09 口径）；
  // IPC reject 静默置 null，不谎报「今日暂无执行记录」。
  // R4（C-01）：records 存入 allRecords 供停止确认复用，概览改由它派生——
  // 同一 effect、同一份数据，不额外增加 IPC。
  useEffect(() => {
    if (!active) return;
    const getHistory = window.electronAPI.getHistory;
    if (typeof getHistory !== 'function') return;
    let cancelled = false;
    const refresh = () => {
      getHistory()
        .then((records) => { if (!cancelled) setAllRecords(records); })
        .catch(() => { if (!cancelled) setAllRecords(null); });
    };
    refresh();
    const timer = setInterval(refresh, 10_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [active]);

  // F-22（DEEP_REVIEW 0ef3bbe）：启动/停止 IPC 包 try/finally，reject 时按钮 disabled
  // 状态必须恢复，否则只能重启应用；失败原因落到页内错误条。
  async function handleStart() {
    setActing(true);
    setPendingAction('start');
    setActionError(null);
    try {
      const result = await window.electronAPI.startExecutor();
      if (!result?.ok) throw new Error(t('status.startFail'));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(false);
      setPendingAction(null);
    }
  }
  async function handleStop() {
    setActing(true);
    setPendingAction('stop');
    setActionError(null);
    try {
      const result = await window.electronAPI.stopExecutor();
      if (!result?.ok) throw new Error(t('status.stopFail'));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(false);
      setPendingAction(null);
    }
  }
  // C-01：停止入口。存在运行中任务时先弹页内确认条，否则维持单击即停（现状）。
  // 确认条只包在外层——handleStop 原函数体（F-22 的 try/finally/页内错误条）
  // 未改写，确认停止后的错误/复位语义与直接停止完全一致。
  function requestStop() {
    if (runningCount > 0) {
      setConfirmingStop(true);
      return;
    }
    void handleStop();
  }
  // 确认后走原 handleStop；无论成功（动作完成）或失败（错误条已落到 hero）
  // 都关闭确认条，不留悬空的红条。
  async function confirmStop() {
    try {
      await handleStop();
    } finally {
      setConfirmingStop(false);
    }
  }
  // D-01：「知道了」——落 localStorage 标记并隐藏本条。写失败不回滚隐藏：
  // 本会话不再打扰即可，下次启动重提示一次无害。
  function dismissTrayTip() {
    setShowTrayTip(false);
    try {
      window.localStorage.setItem(TRAY_TIP_DISMISSED_KEY, '1');
    } catch {
      /* localStorage 写失败：静默 */
    }
  }
  function handleScroll() {
    if (!logRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logRef.current;
    if (scrollHeight - scrollTop - clientHeight < 40) {
      autoScroll.current = true;
      setUnreadLogs(0);
    }
    setPreviewAtTop(scrollTop <= 2);
  }

  // 右栏快捷打开日志文件：失败（关联程序缺失/路径被拒）给行内反馈而非无响应
  function handleRailOpenFile(p: string) {
    setRailFileError(null);
    window.electronAPI
      .openLogFile(p)
      .then((r) => { if (!r?.ok) setRailFileError(r?.error || t('status.openFail')); })
      .catch(() => setRailFileError(t('status.openFail')));
  }

  const handleClose = useCallback(() => setFullscreen(false), []);
  // V4-2：预览窗口切片带全局下标（trace 合并/到达动效由共享 LogLineList 承接，
  // 与全屏查看器同一条渲染管线——V-05/M-01 终结）
  const previewEntries = useMemo(
    () => {
      if (!active) return [];
      const start = Math.max(0, logs.length - PREVIEW_LOG_LINES);
      return logs.slice(start).map((line, k) => ({ line, i: start + k }));
    },
    [active, logs],
  );
  // C-06：缓冲里还有预览之外的行 → 顶部渐隐遮罩常显（实现从简），到顶时给胶囊入口
  const hasHiddenPreview = logs.length > PREVIEW_LOG_LINES;
  const severityCounts = useMemo(() => ({
    error: logs.filter((line) => line.level === 'error').length,
    warn: logs.filter((line) => line.level === 'warn').length,
  }), [logs]);
  function openLogViewer(filter: LogLevelFilter = 'all', showFiles = false) {
    setLogViewerFilter(filter);
    setLogViewerShowFiles(showFiles);
    setFullscreen(true);
  }
  function jumpPreviewToBottom() {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    autoScroll.current = true;
    setUnreadLogs(0);
  }
  function clearDisplayedLogs() {
    clearedRef.current = true;
    setLogs([]);
    setUnreadLogs(0);
  }
  // V4-2（X-03 一半）：行内「打开日志文件」的打开逻辑——状态页打开今日本地
  // 日志（listLogFiles 首个条目即当日分片；列表为空时无动作，右栏/查看器
  // 侧栏已有「暂无日志文件」的口径）。
  function openTodayLogFile() {
    const file = logFiles[0];
    if (file) handleRailOpenFile(file.path);
  }

  const port = String(config.executorPort || 8002);
  const addr = String(config.executorAddressPublic || '');
  const name = String(config.executorName || 'Executor');
  const apiUrl = String(config.adminApiUrl || '—');
  // status 经 IPC 以裸字符串到达（snapshot.status as Status 只是断言）：主进程
  // 未来新增状态（或异常值）时不得让状态大字渲染成空白——已知值查表、未知值
  // 原样透出（与 HistoryPage.statusBadge 的「未知」回退、agentOutcomeLabel 的
  // 表外透传同口径）。
  const statusLabel = !statusLoaded ? t('status.reading') : status === 'pending' && pendingAction === 'stop'
    ? t('status.stopping')
    : (STATUS_LABEL[status] ?? status);
  const statusDescription = status === 'offline' && running
    ? t('status.desc.offlineRunning')
    : status === 'pending' && pendingAction === 'stop'
      ? t('status.desc.stopping')
      : STATUS_DESC[status];

  return (
    <>
      {fullscreen && (
        <LogViewer
          title={<>{t('status.logTitle')} <small>{t('status.logRows', logs.length)}</small></>}
          lines={logs}
          onClose={handleClose}
          initialLevelFilter={logViewerFilter}
          initialShowFiles={logViewerShowFiles}
          filesPanel={<LogFilesPanel />}
          bufferNote={logs.length === MAX_LOG_LINES ? t('status.bufferNote') : undefined}
          arriveAnimation
          onOpenFile={openTodayLogFile}
          extraTools={(
            /* X-06：「清空显示」从页面工具行迁入查看器（本就是查看器级能力，
                页面级三钮竞争消失；点击即清但作用域只限当前窗口显示） */
            <button className="btn btn-sm" onClick={clearDisplayedLogs} title={t('status.clearDisplayTitle')}>
              <Icon name="trash" /> {t('status.clearDisplay')}
            </button>
          )}
        />
      )}

      <div className="status-page">
        {/* DSK-05：自动更新出口。idle 态自身返回 null，不占版面 */}
        <UpdateBanner />

        {/* D-01：托盘常驻一次性提示（C-04 的主窗侧首启教育）。页面最顶、
            UpdateBanner 之下；点「知道了」落 localStorage 标记后不再出现。 */}
        {showTrayTip && (
          <div className="tray-tip" role="status">
            <Icon name="bulb" className="tray-tip-icon" />
            <span className="tray-tip-text">{t('status.trayTip')}</span>
            <button type="button" className="btn btn-sm tray-tip-dismiss" onClick={dismissTrayTip}>{t('ui.knowGotIt')}</button>
          </div>
        )}

        <section className={`hero-card hero-${status}`} aria-label="执行器状态">
          <div className="hero-glyph" aria-hidden="true">
            <Icon name={status === 'online' ? 'activity' : status === 'offline' ? 'warning' : 'server'} />
            <span className={`hero-indicator-dot${status === 'pending' ? ' is-pending' : ''}`} />
          </div>
          <div className="hero-info">
            <div className="hero-eyebrow">{t('status.eyebrow')} <span aria-hidden="true">/</span> {name}</div>
            <div className="hero-status-row">
              {/* M-03：状态翻转 crossfade——key 触发重挂 + 120ms fadeIn，
                  大字/描述不再硬替换（颜色过渡由 hero 边框/图块既有 transition 承担） */}
              <h1 className="hero-name" aria-live="polite" key={statusLabel}>{statusLabel}</h1>
              {running && <span className={`badge ${STATUS_BADGE[status] ?? 'badge-stopped'}`}>{statusLabel}</span>}
            </div>
            <p className="hero-status-text" key={statusDescription}>{statusDescription}</p>
            {actionError && <div className="hero-error" role="alert">{actionError}</div>}
          </div>
          <div className="hero-controls">
            {status === 'offline' && running && (
              <button className="btn btn-primary" onClick={() => requestTabSwitch('config')}>
                {t('status.checkConnection')}
              </button>
            )}
            {!statusLoaded || status === 'pending' ? (
              <button className="btn btn-success" disabled>
                <Icon name="refresh" className="icon-spin" />
                {pendingAction === 'stop' ? t('status.stoppingShort') : t('status.startingShort')}
              </button>
            ) : running ? (
              /* C-01：点击改为进 requestStop——存在运行中任务时先出页内确认条，
                  否则维持单击即停。按钮文案不变（红线：确认前文案不动）。 */
              <button className="btn btn-outline-danger" onClick={requestStop} disabled={acting}>
                <Icon name="stop" /> {t('status.stop')}
              </button>
            ) : (
              <button className="btn btn-success" onClick={handleStart} disabled={acting}>
                <Icon name="play" /> {t('status.start')}
              </button>
            )}
          </div>
        </section>

        {/* C-01：停止执行器页内确认（仅存在运行中任务时出现）。
            V4-4（X-01）：换装共享 ConfirmBar——主钮统一 autoFocus、Esc=取消、
            焦点归还触发钮（此前 Esc 不绑定、五处确认条规范各异）。 */}
        {confirmingStop && (
          <ConfirmBar
            titleId="status-stop-title"
            title={t('status.stopConfirmTitle')}
            description={t('status.stopConfirmDesc', runningCount)}
            confirmLabel={t('status.stopConfirmOk')}
            variant="danger"
            confirmDisabled={acting}
            cancelDisabled={acting}
            onConfirm={() => void confirmStop()}
            onCancel={() => setConfirmingStop(false)}
          />
        )}

        {/* B-02：今日概览条——「今日 N 次执行 · 成功 a · 失败 b · 运行中 c · 最近失败 HH:mm」。
            V4-3（I-01）：右侧新增「运行中任务」明细段（最多 2 个 + 溢出计数）——
            监控工具的核心对象第一次在状态页可见；数据源与计数同源（无新 IPC）。
            语义用 <button>（整条可点进历史页），数字 tabular-nums 并按语义着色。
            读取失败（todaySummary === null）时整条不渲染，不谎报；成功读到但 0 条
            才显示「今日暂无执行记录」空态。 */}
        {todaySummary && (
          <button
            type="button"
            className="today-summary"
            onClick={() => requestTabSwitch('history')}
            title="查看历史执行记录"
          >
            {todaySummary.total === 0 ? (
              <span>{t('status.todayNone')}</span>
            ) : (
              <>
                <span>{t('status.todayPrefix')} <b className="today-summary-num">{todaySummary.total}</b> {t('status.todayExecSuffix')}</span>
                <span className="today-summary-sep" aria-hidden="true">·</span>
                <span>{t('status.todayOk')} <b className="today-summary-num is-ok">{todaySummary.success}</b></span>
                <span className="today-summary-sep" aria-hidden="true">·</span>
                <span>{t('status.todayFail')} <b className="today-summary-num is-fail">{todaySummary.failed}</b></span>
                <span className="today-summary-sep" aria-hidden="true">·</span>
                <span>{t('status.todayRunning')} <b className="today-summary-num is-run">{todaySummary.running}</b></span>
                {todaySummary.lastFailedClock && (
                  <>
                    <span className="today-summary-sep" aria-hidden="true">·</span>
                    <span>{t('status.todayLastFail', todaySummary.lastFailedClock)}</span>
                  </>
                )}
                {todaySummary.runningTasks.length > 0 && (
                  <span className="today-summary-running">
                    <Icon name="play" className="today-summary-runicon" />
                    {todaySummary.runningTasks.slice(0, 2).map((task) => (
                      <span key={task.id} className="today-summary-task" title={task.name}>
                        {task.name}
                        {task.since !== null && (
                          <b className="today-summary-task-dur">{t('status.runningFor', formatRunningMs(Date.now() - task.since))}</b>
                        )}
                      </span>
                    ))}
                    {todaySummary.runningTasks.length > 2 && (
                      <span className="today-summary-task">+{todaySummary.runningTasks.length - 2}</span>
                    )}
                  </span>
                )}
              </>
            )}
            <Icon name="chevron-right" className="today-summary-arrow icon-xs" />
          </button>
        )}

        {/* 主体双栏：左日志工作区（吃满剩余高度），右连接/Agent 信息栏 */}
        <div className="status-body">
          <div className="log-section">
            <div className="log-header">
              <div className="log-heading">
                <span className="log-title"><Icon name="terminal" className="log-title-icon" />{t('status.logTitle')}</span>
                <span className="log-count">{t('status.logCount', logs.length, logs.length > PREVIEW_LOG_LINES ? PREVIEW_LOG_LINES : 0)}</span>
                {severityCounts.warn > 0 && <button className="log-severity warn" onClick={() => openLogViewer('warn')}>{t('logviewer.levelWarn')} {severityCounts.warn}</button>}
                {severityCounts.error > 0 && <button className="log-severity error" onClick={() => openLogViewer('error')}>{t('logviewer.levelError')} {severityCounts.error}</button>}
              </div>
              <div className="log-actions">
                <button className="btn btn-sm" onClick={() => openLogViewer()}><Icon name="expand" /> {t('status.viewLogs')}</button>
                <button className="btn btn-sm" onClick={jumpPreviewToBottom}><Icon name="arrow-down" /> {unreadLogs > 0 ? t('status.newLogs', unreadLogs) : t('status.bottom')}</button>
              </div>
            </div>
            {/* 包裹层承载 C-06 的顶部渐隐遮罩与「查看更早」胶囊（定位锚点） */}
            <div className="log-preview-wrap">
              <div
                className="log-viewer"
                ref={logRef}
                tabIndex={0}
                onScroll={handleScroll}
                onWheel={(event) => { if (event.deltaY < 0) autoScroll.current = false; }}
                onPointerDown={(event) => {
                  if (event.clientX > event.currentTarget.getBoundingClientRect().right - 18) autoScroll.current = false;
                }}
                onKeyDown={(event) => {
                  if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) autoScroll.current = false;
                }}
              >
                {logs.length === 0
                  ? <span className="log-empty"><Icon name="terminal" className="icon-xs" />{t('logviewer.waiting')}</span>
                  : <LogLineList
                      lines={logs}
                      displayed={previewEntries}
                      lineNumbers="hidden"
                      arriveAnimation
                      onOpenFile={openTodayLogFile}
                    />
                }
              </div>
              {hasHiddenPreview && <div className="log-preview-fade" aria-hidden="true" />}
              {hasHiddenPreview && previewAtTop && (
                <button className="log-new-pill" onClick={() => openLogViewer()}>
                  查看更早日志（共 {logs.length} 行）
                </button>
              )}
            </div>
          </div>

          <aside className="status-side">
            <section className="overview-card" aria-label={t('status.connHeading')}>
              <div className="overview-heading">{t('status.connHeading')}</div>
              {/* V4-3（I-03）：连接三项与配置页全量重复——降级为两行摘要
                  （平台地址 + 对外地址；端口已含在对外地址里），省出的卡位
                  让给「最近失败」高频信息 */}
              <div className="overview-row">
                <span className="overview-label"><Icon name="server" className="overview-label-icon" />{t('status.platformLabel')}</span>
                <CopyValue value={apiUrl} />
              </div>
              <div className="overview-row">
                <span className="overview-label"><Icon name="link" className="overview-label-icon" />{t('status.publicLabel')}</span>
                <CopyValue value={addr || `（自动）:${port}`} />
              </div>
            </section>
            {agentStatus && !agentStatus.enabled ? (
              /* B-02（§2.4）：未启用时常驻的「死卡」降级为极简入口卡——
                 标题 + 灰点 + 一行说明（原 hint 文案）+ 轻量「去开启」钮。
                 活动标签走 agentActivityLabel（disabled→「未启用」，关开关后
                 仍在处理当前指派时也不会谎报）。enabled 时维持下方工作信息卡。 */
              <section className="overview-card" aria-label={t('status.agentHeading')}>
                <div className="overview-heading">{t('status.agentHeading')}</div>
                <div className="overview-agent-entry">
                  <span className="overview-agent-entry-text">
                    <span className="agent-status-dot" aria-hidden="true" />
                    <span>{t('status.agentEntryHint', agentActivityLabel(agentStatus))}</span>
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => requestTabSwitch('config')}
                    title={t('status.agentEntryTitle')}
                  >
                    {t('status.agentOpen')}
                  </button>
                </div>
              </section>
            ) : (
              <section className="overview-card" aria-label={t('status.agentHeading')}>
                <div className="overview-heading">{t('status.agentHeading')}</div>
                <div className="overview-agent-head">
                  <span className={`agent-status-dot${agentStatus?.working ? ' is-working' : agentStatus?.enabled ? ' is-ok' : ''}`} aria-hidden="true" />
                  <div className="overview-agent-status" role="status" aria-live="polite">
                    {agentStatusError ?? (agentStatus ? agentActivityLabel(agentStatus) : t('status.readingAgent'))}
                  </div>
                </div>
                <div className="overview-agent-meta">
                  {/* 状态读取失败（agentStatus 为 null）时不得谎报「已处理 0 个」——
                      未知就显示 —，与下方「最近结果：—」同一空态口径。 */}
                <span>{t('status.agentProcessed', agentStatus?.processed ?? '—')}</span>
                <span>{t('status.agentLastResult', agentStatus ? agentOutcomeLabel(agentStatus.lastOutcome) : '—')}</span>
                {agentStatus?.lastEffectiveProfile && <span>{t('status.agentLastProfile', agentStatus.lastEffectiveProfile)}</span>}
                {/* 未启用不是错误态而是入口态：给出开启路径（2026-10 指引升级） */}
                {agentStatus && !agentStatus.enabled && (
                  <span className="overview-agent-hint">{t('status.agentEnableHint')}</span>
                )}
                </div>
              </section>
            )}
            {/* V4-3（I-01/I-03）：最近失败 Top3——排障高频信息进右栏，
                点击进历史页（数据与活动条同源，无新 IPC）。records 未知时
                整卡不渲染，不谎报「没有失败」。 */}
            {allRecords !== null && (
              <section className="overview-card" aria-label={t('status.failuresHeading')}>
                <div className="overview-heading">{t('status.failuresHeading')}</div>
                {recentFailures.length === 0 ? (
                  <div className="log-files-empty">{t('status.noFailures')}</div>
                ) : (
                  <div className="rail-failures">
                    {recentFailures.map((record) => (
                      <button
                        key={record.executionId || record.startTime}
                        type="button"
                        className="rail-failure-item"
                        title={record.errorMessage || t('status.viewHistory')}
                        onClick={() => requestTabSwitch('history', 'failed')}
                      >
                        <span className="rail-failure-time">
                          {record.startTime ? new Date(record.startTime).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '—'}
                        </span>
                        <span className="rail-failure-name">{record.taskName || t('status.unnamedTask')}</span>
                      </button>
                    ))}
                  </div>
                )}
              </section>
            )}
            <section className="overview-card" aria-label={t('status.filesHeading')}>
              <div className="overview-heading">{t('status.filesHeading')}</div>
              {railFileError && <div className="log-files-error" role="alert">{railFileError}</div>}
              {logFiles.length === 0
                ? <div className="log-files-empty">{t('status.filesEmpty')}</div>
                : (
                  <div className="rail-files">
                    {/* 封顶 6 条：右栏是快捷入口不是完整列表，更多走全屏查看器 */}
                    {logFiles.slice(0, 6).map((f) => (
                      <button
                        key={f.path}
                        className="log-file-item"
                        title={f.path}
                        onClick={() => handleRailOpenFile(f.path)}
                      >
                        <span className="log-file-label">{f.label}</span>
                        <span className="log-file-open"><Icon name="external" className="icon-xs" /> {t('ui.open')}</span>
                      </button>
                    ))}
                    {logFiles.length > 6 && (
                      <button
                        type="button"
                        className="rail-files-more"
                        onClick={() => openLogViewer('all', true)}
                        title={t('status.allFilesTitle')}
                      >
                        {t('status.allFiles', logFiles.length)} <Icon name="chevron-right" className="icon-xs" />
                      </button>
                    )}
                  </div>
                )}
            </section>
          </aside>
        </div>
      </div>
    </>
  );
}
