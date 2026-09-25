import React, { useCallback, useEffect, useRef, useState } from 'react';
import UpdateBanner from '../components/UpdateBanner';
import HighlightText from '../components/HighlightText';
import { agentActivityLabel, agentOutcomeLabel, type AgentStatusSnapshot } from '../../main/agent-status-view';

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
          {state === 'copied' ? '已复制 ✓' : state === 'error' ? '复制失败' : '复制'}
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
type LogLine = { level: LogLevel; text: string };

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
  if (!clock && !level) return { level: lvl, text: raw };
  return { level: lvl, text: `[${clock}]${level ? ` [${level}]` : ''} ${rest}` };
}

// ── 全屏日志查看器 ──────────────────────────────────────
function LogViewer({
  logs,
  onClose,
}: {
  logs: LogLine[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [matchIdx, setMatchIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [logFiles, setLogFiles] = useState<Array<{ label: string; path: string; date: string }>>([]);
  const [showFiles, setShowFiles] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  // 实时日志跟随：用户停在底部时新行自动滚底，向上翻看后不打断（与主日志区一致）
  const followRef = useRef(true);

  // 计算匹配行索引
  const q = query.trim().toLowerCase();
  const matchedIndices: number[] = [];
  const filtered = logs.map((line, i) => {
    const hit = q ? line.text.toLowerCase().includes(q) : true;
    if (hit && q) matchedIndices.push(i);
    return { line, i, hit };
  });

  // 跳转到当前匹配项
  useEffect(() => {
    if (!matchedIndices.length || !containerRef.current) return;
    const safeIdx = Math.min(matchIdx, matchedIndices.length - 1);
    const el = containerRef.current.querySelector(`[data-logidx="${matchedIndices[safeIdx]}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'center' });
  }, [matchIdx, query]);

  // 非搜索态下实时日志跟随底部（搜索态由上方跳转 effect 接管）
  useEffect(() => {
    if (q || !followRef.current || !containerRef.current) return;
    containerRef.current.scrollTop = containerRef.current.scrollHeight;
  }, [logs, q]);

  function handleViewerScroll() {
    const el = containerRef.current;
    if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
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

  return (
    <div className="log-fullscreen">
      {/* 顶栏 */}
      <div className="log-fs-bar">
        <span className="log-fs-title">运行日志</span>

        <div className="log-fs-search">
          <span className="log-fs-search-icon">🔍</span>
          <input
            ref={inputRef}
            className="log-fs-input"
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
              <button className="log-fs-nav" onClick={() => setMatchIdx((p) => Math.max(0, p - 1))}>↑</button>
              <button className="log-fs-nav" onClick={() => setMatchIdx((p) => Math.min(totalMatches - 1, p + 1))}>↓</button>
            </>
          )}
        </div>

        <div className="log-fs-actions">
          <button className="btn btn-sm" onClick={() => setShowFiles((v) => !v)}>
            📂 日志文件
          </button>
          <button className="btn btn-sm" onClick={onClose}>✕ 关闭</button>
        </div>
      </div>

      {/* 主体：日志 + 可选文件面板 */}
      <div className="log-fs-body">
        {/* 日志内容 */}
        <div className="log-viewer log-fs-content" ref={containerRef} onScroll={handleViewerScroll}>
          {filtered.map(({ line, i, hit }) => {
            if (!hit) return null;
            const isCurrent = q && matchedIndices[safeMatchIdx] === i;
            return (
              <div
                key={i}
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
          {q && totalMatches === 0 && logs.length > 0 && (
            <span className="log-empty">无匹配结果</span>
          )}
        </div>

        {/* 日志文件侧栏 */}
        {showFiles && (
          <div className="log-fs-files">
            <div className="log-fs-files-title">历史日志文件</div>
            {fileError && <div className="log-files-error" role="alert">{fileError}</div>}
            {logFiles.length === 0
              ? <div className="log-files-empty">暂无日志文件</div>
              : logFiles.map((f) => (
                  <button
                    key={f.path}
                    className="log-file-item"
                    title={f.path}
                    onClick={() => openFile(f.path)}
                  >
                    <span className="log-file-label">{f.label}</span>
                    <span className="log-file-open">↗ 打开</span>
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
export default function StatusWindow() {
  const [status, setStatus] = useState<Status>('stopped');
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [agentStatus, setAgentStatus] = useState<AgentStatusSnapshot | null>(null);
  const [agentStatusError, setAgentStatusError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [acting, setActing] = useState(false);
  // F-22（DEEP_REVIEW 0ef3bbe）：IPC reject 时页内展示错误，避免按钮永久 disabled 且用户无感知
  const [actionError, setActionError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);

  useEffect(() => {
    // EXP-04（本轮体验审查）：此前无 .catch —— `executor:status` handler 要读
    // configStore.getAllMasked()，配置文件损坏/schema 校验抛错/token 解密异常时
    // 该 IPC reject，于是 statusLoaded 永远为 false：状态徽章永久停在「加载中...」
    // 大按钮永久灰色不可点，且页内没有任何错误提示（actionError 只由
    // handleStart/handleStop 设置）。用户既无法从界面启动执行器也不知道原因，
    // 只能重启应用且大概率复现——「按钮永久 disabled + 错误被吞」。
    //
    // 同文件 getTodayLogs() 本就有 .catch，属遗漏而非设计。修法与它对齐：
    // 失败时也置 statusLoaded=true（status 保持 stopped，让按钮可点），并把
    // 原因写进既有的 actionError 错误条。
    window.electronAPI
      .getStatus()
      .then((s) => {
        setStatus(s.status as Status);
        setConfig(s.config);
      })
      .catch((err: unknown) => {
        setActionError(
          `无法读取执行器状态：${err instanceof Error ? err.message : String(err)}。可尝试重启应用；若持续出现请检查配置文件是否损坏。`,
        );
      })
      .finally(() => {
        setStatusLoaded(true);
      });

    // 启动时先加载当天的历史日志（经 preload 暴露的方法；禁止用
    // window.electronAPI.invoke —— preload 不暴露 invoke，会同步抛异常
    // → React 卸载整棵树 → 主窗口只有背景色黑屏，见 preload/index.ts 注释）
    window.electronAPI.getTodayLogs().then((result: any) => {
      if (result?.lines && result.lines.length > 0) {
        // 过滤掉空行；落盘行是 electron-log+winston 双时间戳形态，
        // 统一经 normalizeLogLine 收敛为单时间戳展示（见上方注释）。
        const validLines = (result.lines as string[]).filter((l) => l.trim().length > 0);
        setLogs(validLines.slice(-500).map(normalizeLogLine));
      }
    }).catch(() => {});

    const offLog = window.electronAPI.onLogLine((line) => {
      setLogs((prev) => {
        const next = [...prev, normalizeLogLine(line)];
        return next.length > 2000 ? next.slice(-1600) : next;
      });
    });
    const offStatus = window.electronAPI.onStatusChange((s) => {
      setStatus(s as Status);
    });
    return () => { offLog(); offStatus(); };
  }, []);

  useEffect(() => {
    // 状态窗常驻时也要反映分钟级 Agent 指派的开始/完成。沿用设置页的
    // 只读 IPC；旧版 preload 缺通道时只影响这两张信息卡。
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
  }, []);

  useEffect(() => {
    if (autoScroll.current && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  // F-22（DEEP_REVIEW 0ef3bbe）：启动/停止 IPC 包 try/finally，reject 时按钮 disabled
  // 状态必须恢复，否则只能重启应用；失败原因落到页内错误条。
  async function handleStart() {
    setActing(true);
    setActionError(null);
    try {
      await window.electronAPI.startExecutor();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(false);
    }
  }
  async function handleStop() {
    setActing(true);
    setActionError(null);
    try {
      await window.electronAPI.stopExecutor();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(false);
    }
  }
  function handleScroll() {
    if (!logRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logRef.current;
    autoScroll.current = scrollHeight - scrollTop - clientHeight < 40;
  }

  const handleClose = useCallback(() => setFullscreen(false), []);

  const isActive = status === 'online' || status === 'pending';
  const port = String(config.executorPort || 8002);
  const addr = String(config.executorAddressPublic || '');
  const name = String(config.executorName || 'Executor');
  const apiUrl = String(config.adminApiUrl || '—');

  const ORB_EMOJI: Record<Status, string> = {
    online: '✦', offline: '✦', pending: '↻', stopped: '○',
  };

  return (
    <>
      {fullscreen && <LogViewer logs={logs} onClose={handleClose} />}

      <div className="status-page">
        {/* DSK-05：自动更新出口。idle 态自身返回 null，不占版面 */}
        <UpdateBanner />

        {/* 大状态卡 */}
        <div className="hero-card">
          <div className={`hero-orb ${status}`}>
            <span className="hero-orb-symbol">{ORB_EMOJI[status]}</span>
          </div>
          <div className="hero-info">
            <div className="hero-name">{name}</div>
            <div className="hero-status-text">{STATUS_DESC[status]}</div>
            <div className="hero-controls">
              {!statusLoaded ? (
                <button className="btn btn-success" disabled>▶ 启动执行器</button>
              ) : isActive ? (
                <button className="btn btn-danger" onClick={handleStop} disabled={acting || status === 'pending'}>
                  ⏹ 停止执行器
                </button>
              ) : (
                <button className="btn btn-success" onClick={handleStart} disabled={acting}>
                  ▶ 启动执行器
                </button>
              )}
              <span className={`badge ${statusLoaded ? status : 'stopped'}`}>
                {statusLoaded ? STATUS_LABEL[status] : '加载中...'}
              </span>
            </div>
            {actionError && (
              // F-22（DEEP_REVIEW 0ef3bbe）：启动/停止失败的页内错误条（桌面端无 toast 体系）
              <div className="hero-error" role="alert">{actionError}</div>
            )}
          </div>
        </div>

        {/* 信息网格 */}
        <div className="info-grid">
          <div className="info-card">
            <div className="info-card-label">Admin API</div>
            <div className="info-card-value info-card-value-mono">{apiUrl}</div>
          </div>
          <div className="info-card">
            <div className="info-card-label">对外地址</div>
            <CopyValue value={addr || `（自动）:${port}`} />
          </div>
          <div className="info-card">
            <div className="info-card-label">执行器名称</div>
            <div className="info-card-value">{name}</div>
          </div>
          <div className="info-card">
            <div className="info-card-label">监听端口</div>
            <CopyValue value={port} />
          </div>
          <div className="info-card">
            <div className="info-card-label">Agent 托管</div>
            <div className="info-card-value" role="status" aria-live="polite">
              {agentStatusError ?? (agentStatus ? agentActivityLabel(agentStatus) : '正在读取...')}
            </div>
            {agentStatus && <div className="info-card-detail">已处理 {agentStatus.processed} 个指派</div>}
          </div>
          <div className="info-card">
            <div className="info-card-label">Agent 最近结果</div>
            <div className="info-card-value">
              {agentStatus ? agentOutcomeLabel(agentStatus.lastOutcome) : '—'}
            </div>
            {agentStatus?.lastEffectiveProfile && (
              <div className="info-card-detail">上次生效档位：{agentStatus.lastEffectiveProfile}</div>
            )}
          </div>
        </div>

        {/* 日志区 */}
        <div className="log-section">
          <div className="log-header">
            <span className="log-title">运行日志</span>
            <div className="log-actions">
              <button className="btn btn-sm" onClick={() => setFullscreen(true)}>⛶ 全屏</button>
              <button
                className="btn btn-sm"
                onClick={() => { if (logRef.current) { logRef.current.scrollTop = logRef.current.scrollHeight; autoScroll.current = true; } }}
              >↓ 底部</button>
              <button className="btn btn-sm" onClick={() => setLogs([])}>清空</button>
            </div>
          </div>
          <div className="log-viewer" ref={logRef} onScroll={handleScroll}>
            {logs.length === 0
              ? <span className="log-empty">等待日志输出...</span>
              : logs.map((line, i) => (
                  <div key={i} className={`log-line ${line.level}`}>{line.text}</div>
                ))
            }
          </div>
        </div>
      </div>
    </>
  );
}
