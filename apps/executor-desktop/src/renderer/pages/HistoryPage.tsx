import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../components/Icon';

declare const window: Window & {
  electronAPI: {
    getHistory: () => Promise<ExecRecord[]>;
    clearHistory: () => Promise<{ ok: boolean }>;
    readLog: (executionId: string, fromLine?: number) => Promise<{ lines: string[]; totalLines: number }>;
    writeClipboardText: (text: string) => Promise<{ ok: boolean }>;
    revealExecLog: (executionId: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
    openTaskLogFolder: () => Promise<{ ok: boolean; path?: string; error?: string }>;
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

const GROUP_PAGE_SIZE = 20;
const INITIAL_RUNS_PER_GROUP = 4;
const RUN_PAGE_SIZE = 30;

/**
 * 列表里一次执行的开始时间缺省值。
 *
 * meta 记录理论上都带 startTime，但早期/异常中断写入的记录可能缺字段——
 * 排序与展示都要有确定行为，不能让 undefined 参与比较（NaN 排序会让整组
 * 记录顺序随机抖动，且刷新一次变一次）。
 */
function startOf(r: ExecRecord): number {
  return typeof r.startTime === 'number' && Number.isFinite(r.startTime) ? r.startTime : 0;
}

function formatDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function formatTime(ts?: number): string {
  if (!ts || !Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  return d.toLocaleString('zh-CN', { hour12: false,
    ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit' });
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

// 执行 ID（executionId）在列表里被 ellipsis 截断（.history-run-id max-width），
// 用户拿着完整 ID 去对日志是高频动作——此前既看不到全值也复制不了。
// 点击复制 + title 悬停显示完整 ID；复制成功短暂变色反馈（桌面端无 toast 体系）。
function CopyableExecId({ id }: { id: string }) {
  // idle/copied/error 三态：鼠标点击与键盘 Enter/Space 走同一个复制函数，
  // 反馈一致（此前键盘触发无任何反馈）；复制走主进程 clipboard 并兜失败。
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => setState('idle'), 1200);
    return () => clearTimeout(t);
  }, [state]);
  function doCopy(e: React.SyntheticEvent) {
    e.stopPropagation();
    window.electronAPI
      .writeClipboardText(id)
      .then((r) => setState(r?.ok === false ? 'error' : 'copied'))
      .catch(() => setState('error'));
  }
  return (
    <button
      type="button"
      className={`history-run-id copyable${state === 'copied' ? ' copied' : state === 'error' ? ' copy-failed' : ''}`}
      title={`${id}\n点击复制完整执行 ID`}
      aria-label={`复制执行 ID ${id}`}
      onClick={doCopy}
    >
      {state === 'copied' ? <>已复制 <Icon name="check" className="icon-xs" /></> : state === 'error' ? '复制失败' : id}
    </button>
  );
}

// ────────────────────────────────────────────────────────────
// 实时日志查看器
// ────────────────────────────────────────────────────────────
function LogViewer({ record, onClose }: { record: ExecRecord; onClose: () => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [logQuery, setLogQuery] = useState('');
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [following, setFollowing] = useState(true);
  const [visibleLogCount, setVisibleLogCount] = useState(350);
  // NETOPT-7⑥（2026-09-20）：读取失败的页内呈现 + 终止无限轮询。原实现 fetchLog
  // 无 catch：任一次 readLog reject（日志文件被 TTL 清理/IPC 异常）→ setLoading(false)
  // 不执行 → 永久「加载日志...」，且 1.5s/5s 轮询持续重抛 unhandled rejection。
  // 同仓 AppsPage.tsx 的 AppLogViewer 对同一 IPC 形态有 try/catch + error 态，照此对齐。
  const [error, setError] = useState<string | null>(null);
  const linesRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);
  const inFlight = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchLog = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await window.electronAPI.readLog(record.executionId, linesRef.current);
      setError(null);
      const previousTotal = linesRef.current;
      linesRef.current = res.totalLines;
      if (res.totalLines < previousTotal) {
        // 日志轮转或截断后，旧行不能继续混在新文件的内容里。
        setLines(res.lines.slice(-1500));
      } else if (res.lines.length > 0) {
        setLines(prev => {
          const next = [...prev, ...res.lines];
          return next.length > 1500 ? next.slice(-1500) : next;
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
      inFlight.current = false;
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
    if (logQuery.trim() || issuesOnly) {
      autoScroll.current = false;
      setFollowing(false);
      return;
    }
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    autoScroll.current = scrollHeight - scrollTop - clientHeight < 40;
    setFollowing(autoScroll.current);
  }

  function classifyLog(line: string): string {
    const l = line.toLowerCase();
    if (l.includes('error') || l.includes('failed') || l.includes('err ')) return 'error';
    if (l.includes('warn')) return 'warn';
    return '';
  }

  const needle = logQuery.trim().toLowerCase();
  const visibleLines = useMemo(() => lines
    .map((text, index) => ({ text, index }))
    .filter(({ text }) => (!issuesOnly || classifyLog(text) !== '') && (!needle || text.toLowerCase().includes(needle))),
  [lines, issuesOnly, needle]);
  const displayedLines = visibleLines.slice(-visibleLogCount);
  const hiddenLogCount = visibleLines.length - displayedLines.length;

  function goToBottom() {
    setIssuesOnly(false);
    setLogQuery('');
    setVisibleLogCount(350);
    autoScroll.current = true;
    setFollowing(true);
    requestAnimationFrame(() => {
      if (containerRef.current) containerRef.current.scrollTop = containerRef.current.scrollHeight;
    });
  }

  function renderLine(line: string) {
    if (!needle) return line;
    const at = line.toLowerCase().indexOf(needle);
    if (at < 0) return line;
    return <>{line.slice(0, at)}<mark className="history-log-match">{line.slice(at, at + needle.length)}</mark>{line.slice(at + needle.length)}</>;
  }

  return (
    <div className="log-overlay">
      <div className="log-overlay-header">
        <div className="history-log-heading">
          <span className="log-overlay-title" title={record.taskName}>{record.taskName}</span>
          <span className="log-overlay-id" title={record.executionId}>{record.executionId}</span>
          {statusBadge(record.status)}
        </div>
        <div className="history-overlay-actions">
          <button className="btn btn-sm" onClick={onClose}><Icon name="close" /> 关闭</button>
        </div>
      </div>
      <div className="history-log-tools">
        <input
          className="history-log-search"
          type="search"
          placeholder="搜索当前已加载日志"
          value={logQuery}
          onChange={(e) => { setLogQuery(e.target.value); setVisibleLogCount(350); autoScroll.current = false; setFollowing(false); }}
          aria-label="搜索当前日志"
        />
        <button
          type="button"
          className={`history-chip${issuesOnly ? ' active' : ''}`}
          aria-pressed={issuesOnly}
          onClick={() => { setIssuesOnly((prev) => !prev); setVisibleLogCount(350); autoScroll.current = false; setFollowing(false); }}
        >仅异常</button>
        <span className="history-log-count" role="status">
          {needle || issuesOnly ? `匹配 ${visibleLines.length} 行 · ` : ''}显示 {displayedLines.length} / 已载入 {lines.length} 行 · 文件共 {linesRef.current} 行
        </span>
        <button type="button" className="btn btn-sm" onClick={goToBottom}>
          <Icon name="arrow-down" /> {following ? '跟随中' : '跟随最新'}
        </button>
      </div>
      <div className="log-viewer log-overlay-content" ref={containerRef} onScroll={handleScroll}>
        {hiddenLogCount > 0 && (
          <button type="button" className="log-load-older" onClick={() => {
            autoScroll.current = false;
            setFollowing(false);
            setVisibleLogCount((count) => count + 350);
          }}>再显示更早的日志 · 剩余 {hiddenLogCount} 行</button>
        )}
        {error && <span className="log-empty" role="alert"><Icon name="warning" className="icon-xs" /> 日志读取失败：{error}（轮询已停止；关闭后重新打开可重试）</span>}
        {loading && lines.length === 0 && !error && <span className="log-empty">加载日志...</span>}
        {!loading && lines.length === 0 && !error && <span className="log-empty">暂无日志（日志文件可能尚未生成）</span>}
        {!loading && lines.length > 0 && visibleLines.length === 0 && <span className="log-empty">当前日志中没有匹配内容</span>}
        {displayedLines.map(({ text, index }) => (
          <div key={index} className={`log-line ${classifyLog(text)}`}>
            <span className="history-log-line-no">{Math.max(1, linesRef.current - lines.length + index + 1)}</span>
            <span>{renderLine(text)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// 主页面
// ────────────────────────────────────────────────────────────
export default function HistoryPage({ active }: { active: boolean }) {
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
  // 行内操作反馈（定位日志失败等）——静默失败会让用户以为按钮坏了。
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [visibleGroupCount, setVisibleGroupCount] = useState(GROUP_PAGE_SIZE);
  const [visibleRunCounts, setVisibleRunCounts] = useState<Record<string, number>>({});

  // 操作反馈 6s 后自动消失。
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  /** 在文件管理器中定位某次执行的日志文件。 */
  async function handleRevealLog(executionId: string) {
    try {
      const res = await window.electronAPI.revealExecLog(executionId);
      if (!res.ok) setNotice({ kind: 'err', text: res.error ?? '定位日志失败' });
    } catch (err) {
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    }
  }

  /** 打开任务日志所在目录（一次看当天所有执行）。 */
  async function handleOpenLogFolder() {
    try {
      const res = await window.electronAPI.openTaskLogFolder();
      if (!res.ok) setNotice({ kind: 'err', text: res.error ?? '打开日志目录失败' });
    } catch (err) {
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    }
  }

  const load = useCallback(async (background: boolean = false) => {
    // 后台轮询不切 loading：空列表下每 5s 闪烁「加载中...」会掩盖空态。
    if (!background) setLoading(true);
    try {
      const api = (window as any).electronAPI;
      if (typeof api?.getHistory !== 'function') {
        setError('当前版本不支持读取历史记录');
        if (!background) setLoading(false);
        return;
      }
      const data = await api.getHistory();
      const nextRecords: ExecRecord[] = Array.isArray(data) ? data : [];
      setRecords(nextRecords);
      setViewingLog((current) => {
        if (!current) return null;
        const latest = nextRecords.find((record) => record.executionId === current.executionId);
        return latest && (latest.status !== current.status || latest.endTime !== current.endTime || latest.errorMessage !== current.errorMessage)
          ? latest : current;
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!background) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void load(false);
    const t = setInterval(() => { if (!document.hidden) void load(true); }, 10000);
    return () => clearInterval(t);
  }, [active, load]);

  async function handleClear() {
    try {
      const result = await window.electronAPI.clearHistory();
      if (!result.ok) throw new Error('清除历史记录失败');
      setRecords([]);
      setError(null);
      setNotice({ kind: 'ok', text: '历史记录已清除' });
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
  const filtered = useMemo(() => records.filter((r) => {
    if (statusFilter !== 'all' && (r.status || '') !== statusFilter) return false;
    if (!q) return true;
    // 任务、执行 ID、失败描述都可作为排障线索。
    return (
      (r.taskName || '').toLowerCase().includes(q) ||
      (r.executionId || '').toLowerCase().includes(q) ||
      (r.taskId || '').toLowerCase().includes(q) ||
      (r.errorMessage || '').toLowerCase().includes(q)
    );
  }), [records, statusFilter, q]);

  // 按任务分组，组与组内都按最近执行排序。过滤后的最新记录决定组位置。
  const groupEntries = useMemo(() => {
    const groups: Record<string, { label: string; runs: ExecRecord[] }> = {};
    for (const rec of filtered) {
      const key = rec.taskId || rec.taskName || rec.executionId;
      if (!groups[key]) groups[key] = { label: rec.taskName || key, runs: [] };
      groups[key].runs.push(rec);
    }
    for (const g of Object.values(groups)) {
      g.runs.sort((a, b) => startOf(b) - startOf(a));
    }
    return Object.entries(groups).sort((a, b) =>
      startOf(b[1].runs[0]) - startOf(a[1].runs[0]) || a[1].label.localeCompare(b[1].label));
  }, [filtered]);

  const visibleGroups = groupEntries.slice(0, visibleGroupCount);

  // 首次加载后自动展开最近有记录的那一组。
  //
  // 用户报障（历史执行记录体验不好）：此前 expandedApp 初始为 null，**所有组
  // 都是折叠的**——页面打开后只有一排任务名，用户得先点一下才知道里面有没有
  // 记录、跑成什么样。对"来看最近一次执行结果"这个主场景，等于每次都要多点
  // 一步，且折叠态与"没有任何记录"在视觉上无从区分。
  //
  // 只在用户**尚未手动操作过**时自动展开一次（userToggled 一旦置位就不再
  // 干预）——否则用户手动折叠某组后，下一次 5s 轮询刷新会把面板又弹开。
  const userToggled = useRef(false);
  const autoExpanded = useRef(false);
  useEffect(() => {
    if (autoExpanded.current || userToggled.current) return;
    if (expandedApp !== null || groupEntries.length === 0) return;
    autoExpanded.current = true;
    setExpandedApp(groupEntries[0][0]);
  }, [groupEntries, expandedApp]);

  const toggleGroup = (key: string) => {
    userToggled.current = true;
    setExpandedApp((prev) => (prev === key ? null : key));
  };

  function resetVisibleResults() {
    setVisibleGroupCount(GROUP_PAGE_SIZE);
    setVisibleRunCounts({});
    setExpandedApp(null);
    userToggled.current = false;
    autoExpanded.current = false;
  }

  // 汇总统计（基于全量，不随过滤变化——作为"总览"语义）
  const totalRuns = records.length;
  const statusTotals = useMemo(() => records.reduce((counts, record) => {
    if (record.status === 'success' || record.status === 'failed' || record.status === 'running') {
      counts[record.status] += 1;
    }
    return counts;
  }, { success: 0, failed: 0, running: 0 }), [records]);

  if (viewingLog) {
    return <LogViewer record={viewingLog} onClose={() => setViewingLog(null)} />;
  }

  return (
    <div className="history-page">
      <div className="history-toolbar">
        <div className="history-heading">
          <span className="history-title">历史执行记录</span>
          <span className="history-subtitle">
            {q || statusFilter !== 'all' ? `显示 ${filtered.length} / ${totalRuns} 次执行 · ${groupEntries.length} 个任务` : `${totalRuns} 次执行 · ${groupEntries.length} 个任务`}
          </span>
        </div>
        <div className="history-toolbar-actions">
          <button className="btn btn-sm" onClick={() => void load(false)} disabled={loading}><Icon name="refresh" /> 刷新</button>
          {/* 用户报障：历史记录只能看，日志拿不到手。直接给一个「打开日志目录」
              入口（当天分片），配合每行的「定位日志文件」。 */}
          <button
            className="btn btn-sm"
            onClick={() => void handleOpenLogFolder()}
            title="在文件管理器中打开任务日志目录"
          ><Icon name="folder" /> 日志目录</button>
          <button
            className="btn btn-sm btn-danger-ghost"
            onClick={() => setConfirmingClear(true)}
            disabled={records.length === 0 || confirmingClear}
          >清除全部</button>
        </div>
      </div>

      {confirmingClear && (
        <div className="history-clear-confirm" role="alertdialog" aria-labelledby="history-clear-title">
          <div>
            <strong id="history-clear-title">清除全部 {records.length} 条历史记录？</strong>
            <span>执行日志文件会保留在日志目录中。</span>
          </div>
          <div className="history-clear-actions">
            <button className="btn btn-sm btn-danger" onClick={handleClear}>确认清除</button>
            <button className="btn btn-sm" onClick={() => setConfirmingClear(false)}>取消</button>
          </div>
        </div>
      )}

      {error && (
        <div className="history-error" role="alert"><Icon name="warning" className="icon-xs" /> {error}</div>
      )}

      {notice && (
        <div
          className={notice.kind === 'ok' ? 'apps-notice' : 'apps-notice apps-notice-err'}
          role="status"
          aria-live="polite"
        >
          {notice.kind === 'ok' ? <Icon name="check" className="icon-xs" /> : <Icon name="warning" className="icon-xs" />}
          {notice.text}
        </div>
      )}

      {records.length > 0 && (
        <>
          <div className="history-filters">
            <div className="history-search">
              <span className="history-search-icon" aria-hidden="true"><Icon name="search" /></span>
              <input
                className="history-search-input"
                type="search"
                placeholder="搜索任务、执行 ID 或错误信息…"
                value={query}
                onChange={(e) => { setQuery(e.target.value); resetVisibleResults(); }}
                aria-label="搜索执行记录"
              />
            </div>
            <div className="history-filter-chips" role="group" aria-label="按状态过滤">
              {([
                ['all', `全部 ${totalRuns}`],
                ['success', `成功 ${statusTotals.success}`],
                ['failed', `失败 ${statusTotals.failed}`],
                ['running', `运行中 ${statusTotals.running}`],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`history-chip${statusFilter === value ? ' active' : ''}`}
                  onClick={() => { setStatusFilter(value); resetVisibleResults(); }}
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
          <span className="empty-state-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3 2" />
            </svg>
          </span>
          <strong>{error ? '记录暂时无法显示' : records.length > 0 ? '没有匹配的执行记录' : '还没有执行记录'}</strong>
          <span>{error
            ? '读取失败，请稍后重试。'
            : records.length > 0
              // 有记录但过滤后为空——必须与"完全没记录"区分开
              ? '没有符合当前筛选条件的记录。'
              : '暂无执行记录。执行任务后将在此显示。'}</span>
          {records.length > 0 && <button className="btn btn-sm" onClick={() => { setQuery(''); setStatusFilter('all'); resetVisibleResults(); }}>清除筛选</button>}
        </div>
      ) : (
        <div className="history-groups">
          {visibleGroups.map(([key, group]) => {
            const isOpen = expandedApp === key;
            const runCount = group.runs.length;
            const lastRun = group.runs[0];
            const successCount = group.runs.filter(r => r.status === 'success').length;
            const failCount = group.runs.filter(r => r.status === 'failed').length;
            const shownRuns = visibleRunCounts[key] ?? INITIAL_RUNS_PER_GROUP;

            return (
              <div key={key} className={`history-group${isOpen ? ' expanded' : ''}`}>
                {/* 应用头 */}
                <button
                  type="button"
                  className={`history-group-header ${isOpen ? 'open' : ''}`}
                  onClick={() => toggleGroup(key)}
                  aria-expanded={isOpen}
                  aria-controls={`history-runs-${key}`}
                >
                  <div className="history-group-left">
                    <span className={`history-group-arrow ${isOpen ? 'open' : ''}`}><Icon name="chevron-right" className="icon-xs" /></span>
                    <span className="history-group-name" title={group.label}>{group.label}</span>
                  </div>
                  <div className="history-group-meta">
                    <span className="history-group-latest">最近 {statusBadge(lastRun.status)}</span>
                    <span className="history-stat success">{successCount} 成功</span>
                    <span className="history-stat failed">{failCount} 失败</span>
                    <span className="history-stat total">{runCount} 次</span>
                    <span className="history-stat time" title={lastRun?.startTime ? new Date(lastRun.startTime).toLocaleString('zh-CN', { hour12: false }) : undefined}>{formatTime(lastRun?.startTime)}</span>
                  </div>
                </button>

                {/* 执行记录列表 */}
                {isOpen && (
                  <div id={`history-runs-${key}`} className="history-runs">
                    {group.runs.slice(0, shownRuns).map((run) => (
                      <div key={run.executionId} className="history-run-row">
                        <div className="history-run-left">
                          {statusBadge(run.status)}
                          <span className="history-run-time" title={run.startTime ? new Date(run.startTime).toLocaleString('zh-CN', { hour12: false }) : undefined}>{formatTime(run.startTime)}</span>
                          <CopyableExecId id={run.executionId} />
                        </div>
                        <div className="history-run-right">
                          <span className="history-run-dur">
                            {run.endTime !== undefined ? formatDuration(run.endTime - run.startTime) : '—'}
                          </span>
                          <button
                            className="btn btn-sm history-view-log"
                            onClick={() => setViewingLog(run)}
                          >查看日志</button>
                          <button
                            className="btn btn-sm"
                            onClick={() => void handleRevealLog(run.executionId)}
                            title="在文件管理器中定位该次执行的日志文件"
                          ><Icon name="external" /> 定位</button>
                        </div>
                        {run.errorMessage && <div className="history-run-err" title={run.errorMessage}><Icon name="warning" className="icon-xs" /><span>{run.errorMessage.replace(/\s+/g, ' ').trim()}</span></div>}
                        {!run.errorMessage && run.status === 'failed' && run.exitCode !== undefined && <div className="history-run-err">退出码 {run.exitCode}</div>}
                      </div>
                    ))}
                    {runCount > shownRuns && (
                      <button
                        type="button"
                        className="history-more"
                        onClick={() => setVisibleRunCounts((prev) => ({ ...prev, [key]: shownRuns + RUN_PAGE_SIZE }))}
                      >再显示 {Math.min(RUN_PAGE_SIZE, runCount - shownRuns)} 条 · 剩余 {runCount - shownRuns} 条</button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {groupEntries.length > visibleGroupCount && (
            <button type="button" className="history-more history-more-groups" onClick={() => setVisibleGroupCount((count) => count + GROUP_PAGE_SIZE)}>
              再显示 {Math.min(GROUP_PAGE_SIZE, groupEntries.length - visibleGroupCount)} 个任务 · 剩余 {groupEntries.length - visibleGroupCount} 个
            </button>
          )}
        </div>
      )}
    </div>
  );
}
