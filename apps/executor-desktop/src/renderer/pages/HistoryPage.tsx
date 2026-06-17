import React, { useCallback, useEffect, useRef, useState } from 'react';

declare const window: Window & {
  electronAPI: {
    getHistory: () => Promise<ExecRecord[]>;
    clearHistory: () => Promise<{ ok: boolean }>;
    readLog: (executionId: string, fromLine?: number) => Promise<{ lines: string[]; totalLines: number }>;
  };
};

interface ExecRecord {
  executionId: string;
  taskId: string;
  taskName: string;
  startTime: number;
  endTime?: number;
  status?: 'running' | 'success' | 'failed';
  exitCode?: number;
  errorMessage?: string;
}

function formatDuration(ms?: number): string {
  if (!ms || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function formatTime(ts?: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString('zh-CN', { hour12: false,
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function statusBadge(status?: string) {
  const map: Record<string, string> = {
    success: 'badge-success', failed: 'badge-error', running: 'badge-pending',
  };
  const labels: Record<string, string> = {
    success: '成功', failed: '失败', running: '运行中',
  };
  const cls = map[status || ''] || 'badge-offline';
  return <span className={`badge ${cls}`}>{labels[status || ''] || '未知'}</span>;
}

// ────────────────────────────────────────────────────────────
// 实时日志查看器
// ────────────────────────────────────────────────────────────
function LogViewer({ record, onClose }: { record: ExecRecord; onClose: () => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const linesRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchLog = useCallback(async () => {
    const res = await window.electronAPI.readLog(record.executionId, linesRef.current);
    if (res.lines.length > 0) {
      linesRef.current = res.totalLines;
      setLines(prev => {
        const next = [...prev, ...res.lines];
        return next.length > 2000 ? next.slice(-1500) : next;
      });
    }
    setLoading(false);
  }, [record.executionId]);

  useEffect(() => {
    linesRef.current = 0;
    setLines([]);
    setLoading(true);
    fetchLog();
    // poll every 1.5s while running, every 5s otherwise
    const interval = record.status === 'running' ? 1500 : 5000;
    timerRef.current = setInterval(fetchLog, interval);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [record.executionId, record.status, fetchLog]);

  useEffect(() => {
    if (autoScroll.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lines]);

  function handleScroll() {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    autoScroll.current = scrollHeight - scrollTop - clientHeight < 40;
  }

  function classifyLog(line: string): string {
    const l = line.toLowerCase();
    if (l.includes('error') || l.includes('failed') || l.includes('err ')) return 'error';
    if (l.includes('warn')) return 'warn';
    return '';
  }

  return (
    <div className="log-overlay">
      <div className="log-overlay-header">
        <div>
          <span className="log-overlay-title">{record.taskName}</span>
          <span style={{ marginLeft: 8, color: 'var(--text-3)', fontSize: 11 }}>{record.executionId}</span>
          {statusBadge(record.status)}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn btn-sm" onClick={() => {
            if (containerRef.current) {
              containerRef.current.scrollTop = containerRef.current.scrollHeight;
              autoScroll.current = true;
            }
          }}>↓ 底部</button>
          <button className="btn btn-sm" onClick={onClose}>✕ 关闭</button>
        </div>
      </div>
      <div className="log-viewer" ref={containerRef} onScroll={handleScroll}
        style={{ flex: 1, borderRadius: '0 0 var(--radius-lg) var(--radius-lg)' }}>
        {loading && lines.length === 0
          ? <span style={{ color: '#666', fontStyle: 'italic' }}>加载日志...</span>
          : lines.length === 0
            ? <span style={{ color: '#666', fontStyle: 'italic' }}>暂无日志（日志文件可能尚未生成）</span>
            : lines.map((line, i) => (
                <div key={i} className={`log-line ${classifyLog(line)}`}>{line}</div>
              ))
        }
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// 主页面
// ────────────────────────────────────────────────────────────
export default function HistoryPage() {
  const [records, setRecords] = useState<ExecRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedApp, setExpandedApp] = useState<string | null>(null);
  const [viewingLog, setViewingLog] = useState<ExecRecord | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const api = (window as any).electronAPI;
      if (typeof api?.getHistory !== 'function') {
        setLoading(false);
        return;
      }
      const data = await api.getHistory();
      setRecords(Array.isArray(data) ? data : []);
    } catch {
      // IPC error — treat as empty
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  async function handleClear() {
    if (!confirm('确认清除全部历史记录？')) return;
    await window.electronAPI.clearHistory();
    setRecords([]);
  }

  // 按 taskId 分组
  const groups: Record<string, { label: string; runs: ExecRecord[] }> = {};
  for (const rec of records) {
    const key = rec.taskId || rec.taskName || rec.executionId;
    if (!groups[key]) groups[key] = { label: rec.taskName || key, runs: [] };
    groups[key].runs.push(rec);
  }
  const groupEntries = Object.entries(groups);

  if (viewingLog) {
    return <LogViewer record={viewingLog} onClose={() => setViewingLog(null)} />;
  }

  return (
    <div className="history-page">
      <div className="history-toolbar">
        <span className="history-title">历史执行记录</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn btn-sm" onClick={load}>↻ 刷新</button>
          <button className="btn btn-sm btn-danger-ghost" onClick={handleClear}>清除全部</button>
        </div>
      </div>

      {loading && records.length === 0 ? (
        <div className="history-empty">加载中...</div>
      ) : groupEntries.length === 0 ? (
        <div className="history-empty">暂无执行记录。执行任务后将在此显示。</div>
      ) : (
        <div className="history-groups">
          {groupEntries.map(([key, group]) => {
            const isOpen = expandedApp === key;
            const runCount = group.runs.length;
            const lastRun = group.runs[0];
            const hasRunning = group.runs.some(r => r.status === 'running');
            const successCount = group.runs.filter(r => r.status === 'success').length;
            const failCount = group.runs.filter(r => r.status === 'failed').length;

            return (
              <div key={key} className="history-group">
                {/* 应用头 */}
                <div
                  className={`history-group-header ${isOpen ? 'open' : ''}`}
                  onClick={() => setExpandedApp(isOpen ? null : key)}
                >
                  <div className="history-group-left">
                    <span className={`history-group-arrow ${isOpen ? 'open' : ''}`}>▶</span>
                    <span className="history-group-name">{group.label}</span>
                    {hasRunning && <span className="badge badge-pending" style={{ fontSize: 10 }}>运行中</span>}
                  </div>
                  <div className="history-group-meta">
                    <span className="history-stat success">{successCount} 成功</span>
                    <span className="history-stat failed">{failCount} 失败</span>
                    <span className="history-stat total">{runCount} 次</span>
                    <span className="history-stat time">{formatTime(lastRun?.startTime)}</span>
                  </div>
                </div>

                {/* 执行记录列表 */}
                {isOpen && (
                  <div className="history-runs">
                    {group.runs.map((run, idx) => (
                      <div key={run.executionId} className="history-run-row">
                        <div className="history-run-left">
                          <span className="history-run-index">#{runCount - idx}</span>
                          {statusBadge(run.status)}
                          <span className="history-run-id">{run.executionId}</span>
                        </div>
                        <div className="history-run-right">
                          <span className="history-run-time">{formatTime(run.startTime)}</span>
                          <span className="history-run-dur">
                            {run.endTime ? formatDuration(run.endTime - run.startTime) : '—'}
                          </span>
                          {run.errorMessage && (
                            <span className="history-run-err" title={run.errorMessage}>⚠ 错误</span>
                          )}
                          <button
                            className="btn btn-sm"
                            onClick={() => setViewingLog(run)}
                          >查看日志</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
