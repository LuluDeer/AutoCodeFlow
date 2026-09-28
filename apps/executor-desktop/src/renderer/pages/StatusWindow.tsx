import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import UpdateBanner from '../components/UpdateBanner';
import HighlightText from '../components/HighlightText';
import Icon from '../components/Icon';
import { agentActivityLabel, agentOutcomeLabel, type AgentStatusSnapshot } from '../../main/agent-status-view';
import { requestTabSwitch } from '../tab-switch';

declare const window: Window & {
  electronAPI: {
    getStatus: () => Promise<{ running: boolean; status: string; config: Record<string, unknown> }>;
    getAgentStatus?: () => Promise<AgentStatusSnapshot>;
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

type Status = 'online' | 'offline' | 'pending' | 'stopped';

const STATUS_LABEL: Record<Status, string> = {
  online:  '在线运行中',
  offline: '连接已断开',
  pending: '正在启动...',
  stopped: '已停止',
};

const STATUS_DESC: Record<Status, string> = {
  online:  '执行器已连接到平台，正在接收任务',
  offline: '与平台的心跳连接中断',
  pending: '正在初始化并注册到平台',
  stopped: '执行器进程未运行',
};

function CopyValue({ value, mono = true }: { value: string; mono?: boolean }) {
  // 复制走主进程 Electron clipboard（非安全上下文/权限受限时 navigator.clipboard
  // 会 reject 甚至为 undefined）；成功/失败都给用户明确反馈。
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => setState('idle'), 1500);
    return () => clearTimeout(t);
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
          {state === 'copied' ? <>已复制 <Icon name="check" className="icon-xs" /></> : state === 'error' ? '复制失败' : '复制'}
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
const LOG_VIEWER_PAGE = 350;
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
    rest = outer[5];
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

// ── 全屏日志查看器 ──────────────────────────────────────
function LogViewer({
  logs,
  initialFilter,
  onClose,
}: {
  logs: LogLine[];
  initialFilter: LogLevelFilter;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [levelFilter, setLevelFilter] = useState<LogLevelFilter>(initialFilter);
  const [matchIdx, setMatchIdx] = useState(0);
  const [visibleCount, setVisibleCount] = useState(LOG_VIEWER_PAGE);
  const [following, setFollowing] = useState(true);
  const [wrapLines, setWrapLines] = useState(false);
  const [fileQuery, setFileQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [logFiles, setLogFiles] = useState<Array<{ label: string; path: string; date: string }>>([]);
  const [showFiles, setShowFiles] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  // 实时日志跟随：用户停在底部时新行自动滚底，向上翻看后不打断（与主日志区一致）
  const followRef = useRef(true);

  const q = query.trim().toLowerCase();
  const counts = useMemo(() => ({
    error: logs.filter((line) => line.level === 'error').length,
    warn: logs.filter((line) => line.level === 'warn').length,
  }), [logs]);
  const filtered = useMemo(() => logs
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => levelFilter === 'all' || line.level === levelFilter)
    .filter(({ line }) => !q || line.text.toLowerCase().includes(q)), [logs, levelFilter, q]);
  const matchedIndices = q ? filtered.map(({ i }) => i) : [];
  // 检索匹配可以很多，但只挂载当前结果附近的行；上下跳转仍覆盖全部匹配。
  const searchStart = q && filtered.length > LOG_VIEWER_PAGE
    ? Math.max(0, Math.min(matchIdx - 100, filtered.length - LOG_VIEWER_PAGE))
    : 0;
  const displayed = q
    ? filtered.slice(searchStart, searchStart + LOG_VIEWER_PAGE)
    : filtered.slice(-visibleCount);
  const hiddenCount = filtered.length - displayed.length;
  const visibleLogFiles = logFiles.filter((file) => `${file.label} ${file.path}`.toLowerCase().includes(fileQuery.trim().toLowerCase()));

  // 跳转到当前匹配项
  useEffect(() => {
    if (!matchedIndices.length || !containerRef.current) return;
    const safeIdx = Math.min(matchIdx, matchedIndices.length - 1);
    const el = containerRef.current.querySelector(`[data-logidx="${matchedIndices[safeIdx]}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'center' });
  }, [matchIdx, query, levelFilter]);

  // 非搜索态下实时日志跟随底部（搜索态由上方跳转 effect 接管）
  useEffect(() => {
    if (q || !followRef.current || !containerRef.current) return;
    containerRef.current.scrollTop = containerRef.current.scrollHeight;
  }, [logs, q, levelFilter, visibleCount]);

  function handleViewerScroll() {
    const el = containerRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) {
      followRef.current = true;
      setFollowing(true);
    }
  }

  // 打开日志文件失败（关联程序缺失/路径被拒）时给出反馈，而不是点击无反应
  function openFile(p: string) {
    setFileError(null);
    window.electronAPI
      .openLogFile(p)
      .then((r) => { if (!r?.ok) setFileError(r?.error || '打开失败'); })
      .catch(() => setFileError('打开失败'));
  }

  // 加载日志文件列表
  useEffect(() => {
    if (!showFiles) return;
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
  }, [showFiles]);

  // Esc 关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Ctrl+F 聚焦搜索
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const totalMatches = matchedIndices.length;
  const safeMatchIdx = totalMatches ? Math.min(matchIdx, totalMatches - 1) : 0;
  function jumpToLatest() {
    setQuery('');
    setVisibleCount(LOG_VIEWER_PAGE);
    followRef.current = true;
    setFollowing(true);
    requestAnimationFrame(() => {
      if (containerRef.current) containerRef.current.scrollTop = containerRef.current.scrollHeight;
    });
  }

  return (
    <div className="log-fullscreen">
      {/* 顶栏 */}
      <div className="log-fs-bar">
        <span className="log-fs-title">运行日志 <small>{logs.length} 行</small></span>

        <div className="log-fs-search">
          <span className="log-fs-search-icon"><Icon name="search" /></span>
          <input
            ref={inputRef}
            className="log-fs-input"
            type="search"
            aria-label="搜索运行日志"
            placeholder="搜索日志… (Ctrl+F)"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setMatchIdx(0); }}
          />
          {q && (
            <span className="log-fs-count">
              {totalMatches ? `${safeMatchIdx + 1} / ${totalMatches}` : '无结果'}
            </span>
          )}
          {q && totalMatches > 0 && (
            <>
              <button className="log-fs-nav" aria-label="上一条匹配日志" onClick={() => setMatchIdx((p) => Math.max(0, p - 1))}><Icon name="arrow-up" /></button>
              <button className="log-fs-nav" aria-label="下一条匹配日志" onClick={() => setMatchIdx((p) => Math.min(totalMatches - 1, p + 1))}><Icon name="arrow-down" /></button>
            </>
          )}
        </div>

        <div className="log-fs-actions">
          <button className="btn btn-sm" onClick={() => setShowFiles((v) => !v)}>
            <Icon name="folder" /> 日志文件
          </button>
          <button className="btn btn-sm" onClick={onClose}><Icon name="close" /> 关闭</button>
        </div>
      </div>
      <div className="log-fs-tools">
        <div className="log-level-filters" role="group" aria-label="筛选日志级别">
          {([['all', '全部', logs.length], ['warn', '警告', counts.warn], ['error', '错误', counts.error]] as const).map(([value, label, count]) => (
            <button
              key={value}
              className={`log-level-chip${levelFilter === value ? ' active' : ''}`}
              aria-pressed={levelFilter === value}
              onClick={() => { setLevelFilter(value); setMatchIdx(0); setVisibleCount(LOG_VIEWER_PAGE); }}
            >{label} {count}</button>
          ))}
        </div>
        <span className="log-fs-summary">
          {q
            ? `匹配 ${filtered.length} 行${filtered.length > displayed.length ? ` · 显示 ${searchStart + 1}–${searchStart + displayed.length}` : ''}`
            : `显示 ${displayed.length} / ${filtered.length} 行`}
          {logs.length === MAX_LOG_LINES ? ' · 更早记录请打开日志文件' : ''}
        </span>
        <button className="btn btn-sm" aria-pressed={wrapLines} onClick={() => setWrapLines((value) => !value)}>{wrapLines ? '取消折行' : '折行'}</button>
        <button className="btn btn-sm" onClick={jumpToLatest}>{following && !q ? '已跟随最新' : '查看最新'}</button>
      </div>

      {/* 主体：日志 + 可选文件面板 */}
      <div className="log-fs-body">
        {/* 日志内容 */}
        <div
          className={`log-viewer log-fs-content${wrapLines ? ' wrap' : ''}`}
          ref={containerRef}
          tabIndex={0}
          onScroll={handleViewerScroll}
          onWheel={(event) => { if (event.deltaY < 0) { followRef.current = false; setFollowing(false); } }}
          onPointerDown={(event) => {
            if (event.clientX > event.currentTarget.getBoundingClientRect().right - 18) {
              followRef.current = false;
              setFollowing(false);
            }
          }}
          onKeyDown={(event) => {
            if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) { followRef.current = false; setFollowing(false); }
          }}
        >
          {hiddenCount > 0 && !q && (
            <button className="log-load-older" onClick={() => { followRef.current = false; setFollowing(false); setVisibleCount((n) => n + LOG_VIEWER_PAGE); }}>
              加载更早的日志（还有 {hiddenCount} 行）
            </button>
          )}
          {displayed.map(({ line, i }) => {
            const isCurrent = q && matchedIndices[safeMatchIdx] === i;
            return (
              <div
                key={line.id}
                data-logidx={i}
                className={`log-line ${line.level}${isCurrent ? ' log-highlight' : ''}`}
              >
                {q ? <HighlightText text={line.text} query={q} /> : line.text}
              </div>
            );
          })}
          {logs.length === 0 && (
            <span className="log-empty">等待日志输出...</span>
          )}
          {filtered.length === 0 && logs.length > 0 && (
            <span className="log-empty">{q ? '无匹配结果' : '此级别暂无日志'}</span>
          )}
        </div>

        {/* 日志文件侧栏 */}
        {showFiles && (
          <div className="log-fs-files">
            <div className="log-fs-files-title">历史日志文件 · {logFiles.length}</div>
            <input className="log-file-search" type="search" aria-label="搜索日志文件" placeholder="按日期或文件名查找" value={fileQuery} onChange={(event) => setFileQuery(event.target.value)} />
            {fileError && <div className="log-files-error" role="alert">{fileError}</div>}
            {visibleLogFiles.length === 0
              ? <div className="log-files-empty">{fileQuery ? '没有匹配的日志文件' : '暂无日志文件'}</div>
              : visibleLogFiles.map((f) => (
                  <button
                    key={f.path}
                    className="log-file-item"
                    title={f.path}
                    onClick={() => openFile(f.path)}
                  >
                    <span className="log-file-label">{f.label}</span>
                    <span className="log-file-open"><Icon name="external" className="icon-xs" /> 打开</span>
                  </button>
                ))
            }
          </div>
        )}
      </div>
    </div>
  );
}

// 高亮组件见 components/HighlightText.tsx（与 AppsPage 共用）

// ── 主状态页 ──────────────────────────────────────────
export default function StatusWindow({ active }: { active: boolean }) {
  const [status, setStatus] = useState<Status>('stopped');
  const [running, setRunning] = useState(false);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [agentStatus, setAgentStatus] = useState<AgentStatusSnapshot | null>(null);
  const [agentStatusError, setAgentStatusError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [acting, setActing] = useState(false);
  const [pendingAction, setPendingAction] = useState<'start' | 'stop' | null>(null);
  // F-22（DEEP_REVIEW 0ef3bbe）：IPC reject 时页内展示错误，避免按钮永久 disabled 且用户无感知
  const [actionError, setActionError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [logViewerFilter, setLogViewerFilter] = useState<LogLevelFilter>('all');
  const [unreadLogs, setUnreadLogs] = useState(0);
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
          `无法读取执行器状态：${err instanceof Error ? err.message : String(err)}。可尝试重启应用；若持续出现请检查配置文件是否损坏。`,
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
      setAgentStatusError('当前版本不支持读取 Agent 状态');
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
          setAgentStatusError('Agent 状态暂不可用');
        })
        .finally(() => { inFlight = false; });
    };
    refresh();
    const timer = setInterval(refresh, 2_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [active]);

  useEffect(() => {
    if (autoScroll.current && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs, active]);

  // F-22（DEEP_REVIEW 0ef3bbe）：启动/停止 IPC 包 try/finally，reject 时按钮 disabled
  // 状态必须恢复，否则只能重启应用；失败原因落到页内错误条。
  async function handleStart() {
    setActing(true);
    setPendingAction('start');
    setActionError(null);
    try {
      const result = await window.electronAPI.startExecutor();
      if (!result?.ok) throw new Error('执行器启动失败，请查看运行日志');
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
      if (!result?.ok) throw new Error('执行器停止失败，请查看运行日志');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(false);
      setPendingAction(null);
    }
  }
  function handleScroll() {
    if (!logRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logRef.current;
    if (scrollHeight - scrollTop - clientHeight < 40) {
      autoScroll.current = true;
      setUnreadLogs(0);
    }
  }

  const handleClose = useCallback(() => setFullscreen(false), []);
  const previewLogs = useMemo(() => active ? logs.slice(-PREVIEW_LOG_LINES) : [], [active, logs]);
  const severityCounts = useMemo(() => ({
    error: logs.filter((line) => line.level === 'error').length,
    warn: logs.filter((line) => line.level === 'warn').length,
  }), [logs]);
  function openLogViewer(filter: LogLevelFilter = 'all') {
    setLogViewerFilter(filter);
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

  const port = String(config.executorPort || 8002);
  const addr = String(config.executorAddressPublic || '');
  const name = String(config.executorName || 'Executor');
  const apiUrl = String(config.adminApiUrl || '—');
  const statusLabel = !statusLoaded ? '正在读取状态' : status === 'pending' && pendingAction === 'stop'
    ? '正在停止'
    : STATUS_LABEL[status];
  const statusDescription = status === 'offline' && running
    ? '本地进程仍在运行，但与平台的心跳连接中断。请检查网络或连接设置。'
    : status === 'pending' && pendingAction === 'stop'
      ? '正在安全停止执行器进程'
      : STATUS_DESC[status];

  return (
    <>
      {fullscreen && <LogViewer logs={logs} initialFilter={logViewerFilter} onClose={handleClose} />}

      <div className="status-page">
        {/* DSK-05：自动更新出口。idle 态自身返回 null，不占版面 */}
        <UpdateBanner />

        <section className={`hero-card hero-${status}`} aria-label="执行器状态">
          <div className="hero-indicator" aria-hidden="true" />
          <div className="hero-info">
            <div className="hero-eyebrow">执行器状态 <span aria-hidden="true">/</span> {name}</div>
            <h1 className="hero-name" aria-live="polite">{statusLabel}</h1>
            <p className="hero-status-text">{statusDescription}</p>
            {actionError && <div className="hero-error" role="alert">{actionError}</div>}
          </div>
          <div className="hero-controls">
            {status === 'offline' && running && (
              <button className="btn btn-primary" onClick={() => requestTabSwitch('config')}>
                检查连接设置
              </button>
            )}
            {!statusLoaded || status === 'pending' ? (
              <button className="btn btn-success" disabled>
                {pendingAction === 'stop' ? '正在停止...' : '正在启动...'}
              </button>
            ) : running ? (
              <button className="btn btn-outline-danger" onClick={handleStop} disabled={acting}>
                停止执行器
              </button>
            ) : (
              <button className="btn btn-success" onClick={handleStart} disabled={acting}>
                启动执行器
              </button>
            )}
          </div>
        </section>

        <div className="overview-grid">
          <section className="overview-card" aria-label="连接信息">
            <div className="overview-heading">连接信息</div>
            <div className="overview-row">
              <span className="overview-label">平台地址</span>
              <span className="overview-value overview-value-mono" title={apiUrl}>{apiUrl}</span>
            </div>
            <div className="overview-row">
              <span className="overview-label">对外地址</span>
              <CopyValue value={addr || `（自动）:${port}`} />
            </div>
            <div className="overview-row">
              <span className="overview-label">监听端口</span>
              <CopyValue value={port} />
            </div>
          </section>
          <section className="overview-card" aria-label="Agent 托管">
            <div className="overview-heading">Agent 托管</div>
            <div className="overview-agent-status" role="status" aria-live="polite">
              {agentStatusError ?? (agentStatus ? agentActivityLabel(agentStatus) : '正在读取...')}
            </div>
            <div className="overview-agent-meta">
              <span>已处理 {agentStatus?.processed ?? 0} 个指派</span>
              <span>最近结果：{agentStatus ? agentOutcomeLabel(agentStatus.lastOutcome) : '—'}</span>
              {agentStatus?.lastEffectiveProfile && <span>上次生效档位：{agentStatus.lastEffectiveProfile}</span>}
            </div>
          </section>
        </div>

        {/* 日志区 */}
        <div className="log-section">
          <div className="log-header">
            <div className="log-heading">
              <span className="log-title">运行日志</span>
              <span className="log-count">{logs.length} 行{logs.length > PREVIEW_LOG_LINES ? ` · 预览最近 ${PREVIEW_LOG_LINES} 行` : ''}</span>
              {severityCounts.warn > 0 && <button className="log-severity warn" onClick={() => openLogViewer('warn')}>警告 {severityCounts.warn}</button>}
              {severityCounts.error > 0 && <button className="log-severity error" onClick={() => openLogViewer('error')}>错误 {severityCounts.error}</button>}
            </div>
            <div className="log-actions">
              <button className="btn btn-sm" onClick={() => openLogViewer()}><Icon name="expand" /> 查看日志</button>
              <button className="btn btn-sm" onClick={jumpPreviewToBottom}><Icon name="arrow-down" /> {unreadLogs > 0 ? `${unreadLogs} 条新日志` : '底部'}</button>
              <button className="btn btn-sm" onClick={clearDisplayedLogs} title="仅清空当前窗口显示，不删除日志文件">清空显示</button>
            </div>
          </div>
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
              ? <span className="log-empty">等待日志输出...</span>
              : previewLogs.map((line) => (
                  <div key={line.id} className={`log-line ${line.level}`}>{line.text}</div>
                ))
            }
          </div>
        </div>
      </div>
    </>
  );
}
