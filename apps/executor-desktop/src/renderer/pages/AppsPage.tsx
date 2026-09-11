import React, { useCallback, useEffect, useRef, useState } from 'react';

declare const window: Window & {
  electronAPI: {
    listApps: () => Promise<Array<{
      appId: string;
      deploymentId: string;
      hasLog: boolean;
      logPath: string;
      deployDir: string;
    }>>;
    readAppLog: (logPath: string, fromLine?: number) => Promise<{ lines: string[]; totalLines: number }>;
  };
};

type AppEntry = {
  appId: string;
  deploymentId: string;
  hasLog: boolean;
  logPath: string;
  deployDir: string;
};

function classifyLog(line: string): string {
  const l = line.toLowerCase();
  if (l.includes('error') || l.includes('failed') || l.includes('err ')) return 'error';
  if (l.includes('warn')) return 'warn';
  return '';
}

// ── Log viewer for a single deployment ──────────────────────────────────────
function AppLogViewer({ entry, onClose }: { entry: AppEntry; onClose: () => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const totalLinesRef = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchLogs = useCallback(async (fromLine = 0) => {
    if (!entry.hasLog) return;
    try {
      const result = await window.electronAPI.readAppLog(entry.logPath, fromLine);
      if (result.lines.length > 0) {
        setLines(prev => {
          const next = fromLine === 0 ? result.lines : [...prev, ...result.lines];
          return next.length > 3000 ? next.slice(-2400) : next;
        });
      }
      totalLinesRef.current = result.totalLines;
    } catch { /* ignore */ }
  }, [entry]);

  // Initial load
  useEffect(() => {
    setLines([]);
    totalLinesRef.current = 0;
    setLoading(true);
    fetchLogs(0).finally(() => setLoading(false));
  }, [fetchLogs]);

  // Auto-refresh: poll for new lines every 2s
  useEffect(() => {
    if (!autoRefresh) {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }
    timerRef.current = setInterval(() => {
      fetchLogs(totalLinesRef.current);
    }, 2000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [autoRefresh, fetchLogs]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScrollRef.current && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [lines]);

  function handleScroll() {
    if (!logRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logRef.current;
    autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 40;
  }

  const q = query.trim().toLowerCase();
  const filtered = lines.filter(l => !q || l.toLowerCase().includes(q));

  // Esc to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="log-fullscreen">
      <div className="log-fs-bar">
        <span className="log-fs-title">
          {entry.appId} / <span className="log-fs-deployment-id">{entry.deploymentId.slice(0, 8)}</span>
        </span>
        <div className="log-fs-search">
          <span className="log-fs-search-icon">🔍</span>
          <input
            className="log-fs-input"
            placeholder="搜索日志…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </div>
        <div className="log-fs-actions">
          <button
            className={`btn btn-sm${autoRefresh ? ' btn-success' : ''}`}
            onClick={() => setAutoRefresh(v => !v)}
            title={autoRefresh ? '关闭自动刷新' : '开启自动刷新（2s）'}
          >
            {autoRefresh ? '⟳ 实时' : '⟳ 已暂停'}
          </button>
          <button className="btn btn-sm" onClick={() => fetchLogs(0)}>↺ 全部重载</button>
          <button className="btn btn-sm" onClick={onClose}>✕ 关闭</button>
        </div>
      </div>
      <div className="log-fs-body">
        <div className="log-viewer log-fs-content" ref={logRef} onScroll={handleScroll}>
          {loading && lines.length === 0 && (
            <span className="log-empty">加载中...</span>
          )}
          {!loading && !entry.hasLog && (
            <span className="log-empty">暂无日志文件（app.log 不存在）</span>
          )}
          {filtered.length === 0 && !loading && entry.hasLog && (
            <span className="log-empty">{q ? '无匹配结果' : '日志为空'}</span>
          )}
          {filtered.map((line, i) => (
            <div key={i} className={`log-line ${classifyLog(line)}`}>{line}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Main apps page ────────────────────────────────────────────────────────────
export default function AppsPage() {
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [viewing, setViewing] = useState<AppEntry | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await window.electronAPI.listApps();
      setApps(list);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Group by appId
  const grouped = apps.reduce<Record<string, AppEntry[]>>((acc, a) => {
    (acc[a.appId] = acc[a.appId] || []).push(a);
    return acc;
  }, {});

  if (viewing) {
    return <AppLogViewer entry={viewing} onClose={() => setViewing(null)} />;
  }

  return (
    <div className="status-page">
      <div className="apps-toolbar">
        <span className="apps-title">本地已部署应用</span>
        <button className="btn btn-sm" onClick={refresh} disabled={loading}>
          {loading ? '加载中...' : '↺ 刷新'}
        </button>
      </div>

      {apps.length === 0 && !loading && (
        <div className="apps-empty">
          暂未发现本地部署的应用<br />
          <span>需要先在管理后台创建并部署应用到本执行器</span>
        </div>
      )}

      {Object.entries(grouped).map(([appId, entries]) => (
        <div key={appId} className="app-group">
          <div className="app-group-card">
            {/* App header */}
            <div className="app-group-header">
              <span className="app-group-icon">📦</span>
              <span className="app-group-name">{appId}</span>
              <span className="app-group-count">
                {entries.length} 个部署
              </span>
            </div>

            {/* Deployment rows */}
            {entries.map(entry => (
              <div key={entry.deploymentId} className="app-deployment-row">
                <span className="app-deployment-id">
                  {entry.deploymentId}
                </span>
                <div className="app-deployment-actions">
                  {entry.hasLog ? (
                    <button
                      className="btn btn-sm btn-success"
                      onClick={() => setViewing(entry)}
                    >
                      📄 查看日志
                    </button>
                  ) : (
                    <span className="app-no-log">无日志</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
