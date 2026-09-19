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
  // NETOPT-7⑥（2026-09-20）：读取失败的页内呈现 + 终止无限轮询。原实现 fetchLog
  // 无 catch：任一次 readLog reject（日志文件被 TTL 清理/IPC 异常）→ setLoading(false)
  // 不执行 → 永久「加载日志...」，且 1.5s/5s 轮询持续重抛 unhandled rejection。
  // 同仓 AppsPage.tsx 的 AppLogViewer 对同一 IPC 形态有 try/catch + error 态，照此对齐。
  const [error, setError] = useState<string | null>(null);
  const linesRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchLog = useCallback(async () => {
    try {
      const res = await window.electronAPI.readLog(record.executionId, linesRef.current);
      setError(null);
      if (res.lines.length > 0) {
        linesRef.current = res.totalLines;
        setLines(prev => {
          const next = [...prev, ...res.lines];
          return next.length > 2000 ? next.slice(-1500) : next;
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // 终止轮询：文件已被 TTL 清理/通道异常时，1.5s/5s 重试只会反复失败。
      // 用户关闭日志视图重开即重新拉取（effect 重建 interval）。
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    } finally {
      setLoading(false);
    }
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
          <span className="log-overlay-id">{record.executionId}</span>
          {statusBadge(record.status)}
        </div>
        <div className="history-overlay-actions">
          <button className="btn btn-sm" onClick={() => {
            if (containerRef.current) {
              containerRef.current.scrollTop = containerRef.current.scrollHeight;
              autoScroll.current = true;
            }
          }}>↓ 底部</button>
          <button className="btn btn-sm" onClick={onClose}>✕ 关闭</button>
        </div>
      </div>
      <div className="log-viewer log-overlay-content" ref={containerRef} onScroll={handleScroll}>
        {error ? (
          <>
            {/* NETOPT-7⑥：失败必须可见（复用 log-empty 呈现通道 + alert 语义），
                已加载的行保留在下方——读取失败不应把已有内容一并抹掉。 */}
            <span className="log-empty" role="alert">
              ⚠ 日志读取失败：{error}（轮询已停止；关闭后重新打开可重试）
            </span>
            {lines.map((line, i) => (
              <div key={i} className={`log-line ${classifyLog(line)}`}>{line}</div>
            ))}
          </>
        ) : loading && lines.length === 0
          ? <span className="log-empty">加载日志...</span>
          : lines.length === 0
            ? <span className="log-empty">暂无日志（日志文件可能尚未生成）</span>
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
  // D 修正：原实现 catch 静默返回空列表——IPC 失败会显示成「暂无执行记录」，
  // 用户无法区分「真的没跑过任务」与「读取失败」。
  const [error, setError] = useState<string | null>(null);
  // D 修正：原用 window.confirm()。Electron 无边框窗口下原生 confirm 会阻塞
  // 渲染进程且样式不可控（部分平台直接不显示），改用页内确认态。
  const [confirmingClear, setConfirmingClear] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const api = (window as any).electronAPI;
      if (typeof api?.getHistory !== 'function') {
        setError('当前版本不支持读取历史记录');
        setLoading(false);
        return;
      }
      const data = await api.getHistory();
      setRecords(Array.isArray(data) ? data : []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
    try {
      await window.electronAPI.clearHistory();
      setRecords([]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConfirmingClear(false);
    }
  }

  // ── 过滤 / 搜索（新增能力）────────────────────────────────────────
  // 原页面只能全量罗列：任务跑多之后无法定位「某次失败」「某个任务」。
  // 过滤在渲染层做（meta 记录已全量在内存，无需新增 IPC）。
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'success' | 'failed' | 'running'>('all');

  const q = query.trim().toLowerCase();
  const filtered = records.filter((r) => {
    if (statusFilter !== 'all' && (r.status || '') !== statusFilter) return false;
    if (!q) return true;
    // 同时匹配任务名与 executionId（用户常拿着后者去对日志）
    return (
      (r.taskName || '').toLowerCase().includes(q) ||
      (r.executionId || '').toLowerCase().includes(q) ||
      (r.taskId || '').toLowerCase().includes(q)
    );
  });

  // 按 taskId 分组（基于过滤后的集合）
  const groups: Record<string, { label: string; runs: ExecRecord[] }> = {};
  for (const rec of filtered) {
    const key = rec.taskId || rec.taskName || rec.executionId;
    if (!groups[key]) groups[key] = { label: rec.taskName || key, runs: [] };
    groups[key].runs.push(rec);
  }
  const groupEntries = Object.entries(groups);

  // 汇总统计（基于全量，不随过滤变化——作为"总览"语义）
  const totalRuns = records.length;
  const totalSuccess = records.filter((r) => r.status === 'success').length;
  const totalFailed = records.filter((r) => r.status === 'failed').length;
  const totalRunning = records.filter((r) => r.status === 'running').length;

  if (viewingLog) {
    return <LogViewer record={viewingLog} onClose={() => setViewingLog(null)} />;
  }

  return (
    <div className="history-page">
      <div className="history-toolbar">
        <span className="history-title">历史执行记录</span>
        <div className="history-toolbar-actions">
          <button className="btn btn-sm" onClick={load}>↻ 刷新</button>
          {confirmingClear ? (
            <>
              <span className="history-confirm-text">确认清除全部记录？</span>
              <button className="btn btn-sm btn-danger" onClick={handleClear}>确认清除</button>
              <button className="btn btn-sm" onClick={() => setConfirmingClear(false)}>取消</button>
            </>
          ) : (
            <button
              className="btn btn-sm btn-danger-ghost"
              onClick={() => setConfirmingClear(true)}
              disabled={records.length === 0}
            >清除全部</button>
          )}
        </div>
      </div>

      {error && (
        <div className="history-error" role="alert">⚠ {error}</div>
      )}

      {records.length > 0 && (
        <>
          {/* 总览统计：全量口径，不随过滤变化 */}
          <div className="history-stats" role="group" aria-label="执行统计总览">
            <span className="history-stat-chip">共 {totalRuns} 次</span>
            <span className="history-stat-chip success">成功 {totalSuccess}</span>
            <span className="history-stat-chip failed">失败 {totalFailed}</span>
            {totalRunning > 0 && <span className="history-stat-chip running">运行中 {totalRunning}</span>}
          </div>

          <div className="history-filters">
            <div className="history-search">
              <span className="history-search-icon" aria-hidden="true">🔍</span>
              <input
                className="history-search-input"
                type="search"
                placeholder="搜索任务名 / 执行 ID…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="搜索执行记录"
              />
            </div>
            <div className="history-filter-chips" role="group" aria-label="按状态过滤">
              {([
                ['all', '全部'],
                ['success', '成功'],
                ['failed', '失败'],
                ['running', '运行中'],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`history-chip${statusFilter === value ? ' active' : ''}`}
                  onClick={() => setStatusFilter(value)}
                  aria-pressed={statusFilter === value}
                >{label}</button>
              ))}
            </div>
          </div>
        </>
      )}

      {loading && records.length === 0 ? (
        <div className="history-empty">加载中...</div>
      ) : groupEntries.length === 0 ? (
        <div className="history-empty">
          {error
            ? '读取失败，请稍后重试。'
            : records.length > 0
              // 有记录但过滤后为空——必须与"完全没记录"区分开
              ? '没有符合当前筛选条件的记录。'
              : '暂无执行记录。执行任务后将在此显示。'}
        </div>
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
                <button
                  type="button"
                  className={`history-group-header ${isOpen ? 'open' : ''}`}
                  onClick={() => setExpandedApp(isOpen ? null : key)}
                  aria-expanded={isOpen}
                  aria-controls={`history-runs-${key}`}
                >
                  <div className="history-group-left">
                    <span className={`history-group-arrow ${isOpen ? 'open' : ''}`}>▶</span>
                    <span className="history-group-name">{group.label}</span>
                    {hasRunning && <span className="badge badge-pending badge-compact">运行中</span>}
                  </div>
                  <div className="history-group-meta">
                    <span className="history-stat success">{successCount} 成功</span>
                    <span className="history-stat failed">{failCount} 失败</span>
                    <span className="history-stat total">{runCount} 次</span>
                    <span className="history-stat time">{formatTime(lastRun?.startTime)}</span>
                  </div>
                </button>

                {/* 执行记录列表 */}
                {isOpen && (
                  <div id={`history-runs-${key}`} className="history-runs">
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
