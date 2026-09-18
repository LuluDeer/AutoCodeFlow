import React, { useCallback, useEffect, useRef, useState } from 'react';
import UpdateBanner from '../components/UpdateBanner';

declare const window: Window & {
  electronAPI: {
    getStatus: () => Promise<{ running: boolean; status: string; config: Record<string, unknown> }>;
    getTodayLogs: () => Promise<{ lines: string[]; date: string }>;
    startExecutor: () => Promise<{ ok: boolean }>;
    stopExecutor: () => Promise<{ ok: boolean }>;
    onLogLine: (cb: (line: string) => void) => () => void;
    onStatusChange: (cb: (status: string) => void) => () => void;
    listLogFiles: () => Promise<Array<{ label: string; path: string; date: string }>>;
    openLogFile: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
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
  const [copied, setCopied] = useState(false);
  function copy() {
    if (!value || value === '—') return;
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <div className="copy-row">
      <span className={`copy-val${mono ? '' : ' copy-val-plain'}`}>{value || '—'}</span>
      {value && value !== '—' && (
        <button className={`copy-btn${copied ? ' copied' : ''}`} onClick={copy}>
          {copied ? '已复制 ✓' : '复制'}
        </button>
      )}
    </div>
  );
}

function classifyLog(line: string): string {
  const l = line.toLowerCase();
  if (l.includes('error') || l.includes('failed') || l.includes('err ')) return 'error';
  if (l.includes('warn')) return 'warn';
  return '';
}

// ── 全屏日志查看器 ──────────────────────────────────────
function LogViewer({
  logs,
  onClose,
}: {
  logs: string[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [matchIdx, setMatchIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [logFiles, setLogFiles] = useState<Array<{ label: string; path: string; date: string }>>([]);
  const [showFiles, setShowFiles] = useState(false);

  // 计算匹配行索引
  const q = query.trim().toLowerCase();
  const matchedIndices: number[] = [];
  const filtered = logs.map((line, i) => {
    const hit = q ? line.toLowerCase().includes(q) : true;
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
        <div className="log-viewer log-fs-content" ref={containerRef}>
          {filtered.map(({ line, i, hit }) => {
            if (!hit) return null;
            const cls = classifyLog(line);
            const isCurrent = q && matchedIndices[safeMatchIdx] === i;
            return (
              <div
                key={i}
                data-logidx={i}
                className={`log-line ${cls}${isCurrent ? ' log-highlight' : ''}`}
              >
                {q ? <HighlightText text={line} query={q} /> : line}
              </div>
            );
          })}
          {logs.length === 0 && (
            <span className="log-empty">等待日志输出...</span>
          )}
        </div>

        {/* 日志文件侧栏 */}
        {showFiles && (
          <div className="log-fs-files">
            <div className="log-fs-files-title">历史日志文件</div>
            {logFiles.length === 0
              ? <div className="log-files-empty">暂无日志文件</div>
              : logFiles.map((f) => (
                  <button
                    key={f.path}
                    className="log-file-item"
                    title={f.path}
                    onClick={() => window.electronAPI.openLogFile(f.path)}
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

// 高亮搜索关键词
function HighlightText({ text, query }: { text: string; query: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let idx = lower.indexOf(q, last);
  while (idx !== -1) {
    if (idx > last) parts.push(text.slice(last, idx));
    parts.push(<mark key={idx} className="log-mark">{text.slice(idx, idx + q.length)}</mark>);
    last = idx + q.length;
    idx = lower.indexOf(q, last);
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

// ── 主状态页 ──────────────────────────────────────────
export default function StatusWindow() {
  const [status, setStatus] = useState<Status>('stopped');
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [logs, setLogs] = useState<string[]>([]);
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
        // 过滤掉空行
        const validLines = result.lines.filter((l: string) => l.trim().length > 0);
        setLogs(validLines.slice(-500));
      }
    }).catch(() => {});

    const offLog = window.electronAPI.onLogLine((line) => {
      setLogs((prev) => {
        const next = [...prev, line];
        return next.length > 2000 ? next.slice(-1600) : next;
      });
    });
    const offStatus = window.electronAPI.onStatusChange((s) => {
      setStatus(s as Status);
    });
    return () => { offLog(); offStatus(); };
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
                  <div key={i} className={`log-line ${classifyLog(line)}`}>{line}</div>
                ))
            }
          </div>
        </div>
      </div>
    </>
  );
}
