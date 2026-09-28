import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import HighlightText from '../components/HighlightText';
import { requestTabSwitch } from '../tab-switch';

declare const window: Window & {
  electronAPI: {
    listApps: () => Promise<AppEntry[]>;
    readAppLog: (logPath: string, fromLine?: number) => Promise<{ lines: string[]; totalLines: number }>;
    openAppFolder: (appId: string) => Promise<{ ok: boolean; error?: string }>;
    openReleaseFolder: (appId: string, releaseKey: string) => Promise<{ ok: boolean; error?: string }>;
    uninstallApp: (appId: string) => Promise<{
      ok: boolean;
      mode: 'executor' | 'local';
      stopped?: string[];
      error?: string;
    }>;
    deleteAppRelease: (
      appId: string,
      releaseKey: string,
      deploymentId: string,
    ) => Promise<{ ok: boolean; error?: string }>;
    /**
     * 本机正在运行的常驻应用：deploymentId → {pid, running}。
     * 数据来自 executor 的 /api/app-status（进程登记只在执行器进程内）。
     */
    getRunningApps: () => Promise<Record<string, { pid?: number; running?: boolean }>>;
  };
};

type AppEntry = {
  appId: string;
  /**
   * app.json 记录的真实应用名。
   *
   * **null = 本机没记录过名字**（旧部署早于 app.json 落地，且日志回溯也没命中）。
   * 绝不回落成 appId：把 UUID 当名字渲染正是用户报障的
   * 「显示的应用也是ID形式 我都看不出是什么应用」——而且回落之后，
   * 「有名字」与「没名字」在 UI 上就再也分不出来，无法给出可操作提示。
   */
  appName: string | null;
  deploymentId: string;
  /** releaseKey 里的版本号；无法解析时为 null（UI 如实显示「版本未知」）。 */
  version: string | null;
  releaseKey: string;
  /** current 软链指向的即时版本。 */
  isCurrent: boolean;
  /** release 目录 mtime（部署时间）；读取失败为 null。 */
  deployedAt: number | null;
  hasLog: boolean;
  logPath: string;
  deployDir: string;
  /** 应用根目录（跨 release 稳定）——「打开文件夹」的目标。 */
  appRoot: string;
  /** 部署时的 runMode；旧部署无此字段时为 null。用于解释「为什么没有日志」。 */
  runMode: string | null;
};

/** 部署时间行内显示；跨年时保留年份，避免旧版本看起来像今年部署。 */
function formatDeployTime(ms: number | null): string {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  const year = d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}-`;
  return `${year}${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

type AppGroup = {
  appId: string;
  name: string | null;
  entries: AppEntry[];
  newestAt: number;
  current: AppEntry | null;
  runningCount: number;
  nameMatches: boolean;
  matchedEntries: AppEntry[];
};

const INITIAL_APP_COUNT = 30;
const INITIAL_RELEASE_COUNT = 3;
const MORE_RELEASE_COUNT = 20;

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
  // D 修正：原实现 `catch { /* ignore */ }` 把 IPC 失败静默吞掉——用户看到
  // 「暂无日志文件」而真实原因是读取失败（权限/文件被删/通道异常），无法区分。
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [matchIdx, setMatchIdx] = useState(0);
  const [visibleLogCount, setVisibleLogCount] = useState(350);
  const [following, setFollowing] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const totalLinesRef = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const inFlight = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchLogs = useCallback(async (fromLine = 0) => {
    if (!entry.hasLog || inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await window.electronAPI.readAppLog(entry.logPath, fromLine);
      if (result.totalLines < fromLine) {
        setLines(result.lines.slice(-2400));
      } else if (result.lines.length > 0) {
        setLines(prev => {
          const next = fromLine === 0 ? result.lines : [...prev, ...result.lines];
          return next.length > 2400 ? next.slice(-2400) : next;
        });
      }
      totalLinesRef.current = result.totalLines;
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // 停止轮询（对齐 HistoryPage 查看器）：持续失败时不再每 2s 重抛刷屏；
      // 按钮随之显示「已暂停」，用户排除问题后可手动点「实时」重试。
      setAutoRefresh(false);
    } finally {
      inFlight.current = false;
    }
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

  // Auto-scroll to bottom（搜索态由跳转 effect 接管，新日志到达不打断定位）
  useEffect(() => {
    if (query.trim() || !autoScrollRef.current || !logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines, query]);

  function handleScroll() {
    if (!logRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logRef.current;
    if (scrollHeight - scrollTop - clientHeight < 40) {
      autoScrollRef.current = true;
      setFollowing(true);
    }
  }

  const q = query.trim().toLowerCase();
  // 保留原始行索引（data-logidx 用于跳转定位），与 StatusWindow 查看器一致
  const matchedIndices: number[] = [];
  const filtered = lines.map((line, i) => {
    const hit = !q || line.toLowerCase().includes(q);
    if (hit && q) matchedIndices.push(i);
    return { line, i, hit };
  });
  const totalMatches = matchedIndices.length;
  const safeMatchIdx = totalMatches ? Math.min(matchIdx, totalMatches - 1) : 0;
  const hits = filtered.filter(({ hit }) => hit);
  const searchStart = q && hits.length > 350 ? Math.max(0, Math.min(matchIdx - 100, hits.length - 350)) : 0;
  const displayed = q ? hits.slice(searchStart, searchStart + 350) : hits.slice(-visibleLogCount);
  const hiddenLogCount = hits.length - displayed.length;

  function jumpToLatest() {
    setQuery('');
    setVisibleLogCount(350);
    autoScrollRef.current = true;
    setFollowing(true);
    requestAnimationFrame(() => {
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    });
  }

  // 跳转到当前匹配项
  useEffect(() => {
    if (!totalMatches || !logRef.current) return;
    const el = logRef.current.querySelector(
      `[data-logidx="${matchedIndices[safeMatchIdx]}"]`,
    ) as HTMLElement | null;
    el?.scrollIntoView({ block: 'center' });
    // matchedIndices/safeMatchIdx 每次渲染派生，仅在导航或查询变化时跳转
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchIdx, query]);

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
          {entry.appName ?? '未知应用名'}
          {entry.version ? ` v${entry.version}` : ''}
          {entry.isCurrent ? '（当前版本）' : ''} /{' '}
          <span className="log-fs-deployment-id">{entry.deploymentId.slice(0, 8)}</span>
        </span>
        <div className="log-fs-search">
          <span className="log-fs-search-icon">🔍</span>
          <input
            className="log-fs-input"
            type="search"
            aria-label="搜索应用日志"
            placeholder="搜索日志…"
            value={query}
            onChange={e => { setQuery(e.target.value); setMatchIdx(0); setVisibleLogCount(350); autoScrollRef.current = false; setFollowing(false); }}
          />
          {q && (
            <span className="log-fs-count">
              {totalMatches ? `${safeMatchIdx + 1} / ${totalMatches}` : '无结果'}
            </span>
          )}
          {q && totalMatches > 0 && (
            <>
              <button className="log-fs-nav" aria-label="上一条匹配应用日志" onClick={() => setMatchIdx(p => Math.max(0, p - 1))}>↑</button>
              <button className="log-fs-nav" aria-label="下一条匹配应用日志" onClick={() => setMatchIdx(p => Math.min(totalMatches - 1, p + 1))}>↓</button>
            </>
          )}
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
          <button className="btn btn-sm" onClick={jumpToLatest}>{following && !q ? '↓ 跟随最新' : '↓ 查看最新'}</button>
          <button className="btn btn-sm" onClick={onClose}>✕ 关闭</button>
        </div>
      </div>
      <div className="log-fs-body">
        <div
          className="log-viewer log-fs-content"
          ref={logRef}
          tabIndex={0}
          onScroll={handleScroll}
          onWheel={event => { if (event.deltaY < 0) { autoScrollRef.current = false; setFollowing(false); } }}
          onPointerDown={event => {
            if (event.clientX > event.currentTarget.getBoundingClientRect().right - 18) {
              autoScrollRef.current = false;
              setFollowing(false);
            }
          }}
          onKeyDown={event => {
            if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) { autoScrollRef.current = false; setFollowing(false); }
          }}
        >
          {q && hiddenLogCount > 0 && (
            <div className="log-window-summary">匹配 {hits.length} 行 · 当前显示第 {searchStart + 1}–{searchStart + displayed.length} 行，使用 ↑ ↓ 跳转</div>
          )}
          {!q && hiddenLogCount > 0 && (
            <button type="button" className="log-load-older" onClick={() => {
              autoScrollRef.current = false;
              setFollowing(false);
              setVisibleLogCount(count => count + 350);
            }}>
              再显示更早的日志 · 剩余 {hiddenLogCount} 行
            </button>
          )}
          {loading && lines.length === 0 && (
            <span className="log-empty">加载中...</span>
          )}
          {/* D 修正：读取失败必须显性化，不能与「无日志」混为一谈 */}
          {error && !loading && (
            <div className="log-error" role="alert">
              ⚠ 读取日志失败：{error}（自动刷新已停止，可点「实时」重试）
            </div>
          )}
          {!loading && !error && !entry.hasLog && (
            <div className="log-empty-block">
              <span className="log-empty">该部署没有应用日志（app.log 不存在）</span>
              {/* 用户报障：「明明有日志，但是应用tab却显示没日志」。真实原因是
                  两类日志不是一回事——应用日志（app.log）只有常驻 daemon/once
                  模式才写（deploy.ts 只对这两者调 startApp），而用户看到的日志
                  是**任务执行日志**，在「历史」页。必须把区别讲清楚 + 给出可点
                  的通路，否则用户会以为日志丢了。 */}
              <span className="log-empty-hint">
                {entry.runMode === 'scheduled'
                  ? '该应用以「定时/触发」模式部署（scheduled），执行器只负责落盘、不常驻运行，因此没有 app.log。'
                  : '应用日志由常驻进程写入；该应用未以常驻方式（daemon/once）启动过，因此没有 app.log。'}
                <br />
                每次被调度执行产生的**执行日志**在「历史」页，按执行 ID 逐次可查。
              </span>
              <button
                className="btn btn-sm"
                onClick={() => {
                  // 关掉查看器再切页：否则用户切回来后仍停在"无日志"的空视图上。
                  onClose();
                  requestTabSwitch('history');
                }}
              >📋 去「历史」查看执行日志</button>
            </div>
          )}
          {!loading && !error && entry.hasLog && lines.length === 0 && (
            <span className="log-empty">日志为空</span>
          )}
          {!loading && !error && entry.hasLog && q && totalMatches === 0 && (
            <span className="log-empty">无匹配结果</span>
          )}
          {displayed.map(({ line, i }) => {
            const isCurrent = q && matchedIndices[safeMatchIdx] === i;
            return (
              <div
                key={i}
                data-logidx={i}
                className={`log-line ${classifyLog(line)}${isCurrent ? ' log-highlight' : ''}`}
              >
                {q ? <HighlightText text={line} query={q} /> : line}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Main apps page ────────────────────────────────────────────────────────────
export default function AppsPage() {
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'running' | 'unnamed'>('all');
  const [sortOrder, setSortOrder] = useState<'recent' | 'name'>('recent');
  const [expandedApps, setExpandedApps] = useState<Record<string, boolean>>({});
  const [releaseLimits, setReleaseLimits] = useState<Record<string, number>>({});
  const [visibleAppCount, setVisibleAppCount] = useState(INITIAL_APP_COUNT);
  // D 修正：列表加载失败同样不能静默——失败会让页面显示「暂无已部署应用」，
  // 用户会误以为需要去后台部署，而真实原因是本地 IPC/目录读取异常。
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<AppEntry | null>(null);
  // 行内操作的结果反馈（打开目录失败 / 删除被拒等）——必须显性化：
  // 静默失败会让用户以为按钮坏了（原实现连按钮都没有）。
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  // 正在执行破坏性操作的 appId——期间禁用按钮，避免重复点击。
  const [busy, setBusy] = useState<string | null>(null);
  const hasLoadedRef = useRef(false);

  // 正在运行的常驻应用（deploymentId → pid）。删除版本时主进程会自行再查一次
  // （权威判据），这里拉取纯粹为了**显示**：让用户一眼看到哪个版本真的在跑，
  // 而不是只看到「当前版本」（current 指向 ≠ 进程活着——daemon 启动失败时
  // current 已经切过去但进程没起来）。
  const [running, setRunning] = useState<Record<string, { pid?: number; running?: boolean }>>({});

  const refresh = useCallback(async (background: boolean = false) => {
    // 后台轮询不切 loading，避免按钮文案/空态反复闪烁
    if (!background) setLoading(true);
    try {
      const list = await window.electronAPI.listApps();
      setApps(list);
      hasLoadedRef.current = true;
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!background) setLoading(false);
    }
    // 运行态单独取：它依赖执行器进程在线，拿不到就保持空（UI 不显示"运行中"，
    // 而不是谎报）。**绝不因它失败而把整个列表标记为错误**——列表本身是好的。
    try {
      const runningMap = await window.electronAPI.getRunningApps();
      setRunning(runningMap ?? {});
    } catch {
      setRunning({});
    }
  }, []);

  useEffect(() => {
    // 页面常驻 DOM；仅在应用 Tab 可见时扫描本地部署目录。大量 release
    // 的 readdir/stat 在主进程同步执行，后台每 5 秒扫描会拖慢其他页面。
    const panel = document.getElementById('apps-panel');
    const active = () => !document.hidden && !panel?.hidden;
    const refreshActive = () => { if (active()) void refresh(hasLoadedRef.current); };
    refreshActive();
    const timer = setInterval(() => { if (active()) void refresh(true); }, 10000);
    const onVisible = () => refreshActive();
    const observer = panel && new MutationObserver(refreshActive);
    observer?.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      observer?.disconnect();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  // 操作反馈 6s 后自动消失（成功/失败都提示，不长期占位）。
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  /** 打开应用根目录（用户报障：客户端本地无法查看部署的应用文件夹）。 */
  async function handleOpenFolder(entry: AppEntry, releaseOnly: boolean) {
    const res = releaseOnly
      ? await window.electronAPI.openReleaseFolder(entry.appId, entry.releaseKey)
      : await window.electronAPI.openAppFolder(entry.appId);
    if (!res.ok) setNotice({ kind: 'err', text: `打开文件夹失败：${res.error ?? '未知原因'}` });
  }

  /** 删除单个历史版本（用户报障：无法撤销部署）。 */
  async function handleDeleteRelease(entry: AppEntry) {
    const label = entry.version ? `v${entry.version}` : entry.releaseKey;
    if (
      !window.confirm(
        `确定删除本地版本 ${label}（${entry.deploymentId.slice(0, 8)}）吗？\n\n` +
          `· 只删除本机上这一份部署文件，不影响中台的部署记录；\n` +
          `· 该操作不可撤销。`,
      )
    ) {
      return;
    }
    setBusy(entry.appId + entry.releaseKey);
    try {
      const res = await window.electronAPI.deleteAppRelease(
        entry.appId,
        entry.releaseKey,
        entry.deploymentId,
      );
      if (res.ok) {
        setNotice({ kind: 'ok', text: `已删除本地版本 ${label}` });
        await refresh(true);
      } else {
        setNotice({ kind: 'err', text: res.error ?? '删除失败' });
      }
    } catch (err) {
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  /** 卸载整个应用（本机目录 + 停止常驻进程）。 */
  async function handleUninstall(appId: string, displayName: string, count: number) {
    if (
      !window.confirm(
        `确定从本机卸载「${displayName}」吗？\n\n` +
          `· 将停止该应用在本机运行的进程，并删除全部 ${count} 份部署文件；\n` +
          `· 中台的部署记录不会被删除——中台仍会显示该应用已部署到此执行器；\n` +
          `· 该操作不可撤销。`,
      )
    ) {
      return;
    }
    setBusy(appId);
    try {
      const res = await window.electronAPI.uninstallApp(appId);
      if (res.ok) {
        setNotice({
          kind: 'ok',
          text:
            res.mode === 'executor'
              ? `已卸载「${displayName}」${res.stopped?.length ? `（已停止 ${res.stopped.length} 个进程）` : ''}`
              : `已卸载「${displayName}」（执行器未运行，直接清理了本地文件）`,
        });
        await refresh(true);
      } else {
        // 部分成功也要说清楚：进程可能已停但目录没删掉（executor 的 rm 失败
        // 是藏在 HTTP 200 应答体里的，主进程已如实回报）。
        const stoppedNote = res.stopped?.length
          ? `（已停止 ${res.stopped.length} 个进程，但文件未删净）`
          : '';
        setNotice({ kind: 'err', text: `${res.error ?? '卸载失败'}${stoppedNote}` });
        // 失败也可能已改变了本机状态（进程被停）——刷新一次让列表与现实一致。
        await refresh(true);
      }
    } catch (err) {
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  const query = search.trim().toLocaleLowerCase();
  const tokens = useMemo(() => query.split(/\s+/).filter(Boolean), [query]);
  const grouped = useMemo(() => {
    const byId = new Map<string, AppEntry[]>();
    for (const entry of apps) {
      const entries = byId.get(entry.appId) ?? [];
      entries.push(entry);
      byId.set(entry.appId, entries);
    }
    return Array.from(byId, ([appId, unsorted]): AppGroup => {
      // 生效、运行中的版本优先；其余按部署时间。旧 current 也不会埋在长列表底部。
      const entries = [...unsorted].sort((a, b) =>
        Number(b.isCurrent) - Number(a.isCurrent)
        || Number(Boolean(running[b.deploymentId]?.running)) - Number(Boolean(running[a.deploymentId]?.running))
        || (b.deployedAt ?? 0) - (a.deployedAt ?? 0),
      );
      const name = entries.find(entry => entry.appName)?.appName ?? null;
      const common = `${name ?? ''} ${appId} ${entries[0]?.appRoot ?? ''}`.toLocaleLowerCase();
      const nameMatches = tokens.every(token => common.includes(token));
      const matchedEntries = tokens.length && !nameMatches
        ? entries.filter(entry => {
          const searchable = `${common} ${entry.version ?? ''} ${entry.releaseKey} ${entry.deploymentId}`.toLocaleLowerCase();
          return tokens.every(token => searchable.includes(token));
        })
        : entries;
      return {
        appId,
        name,
        entries,
        newestAt: entries.reduce((latest, entry) => Math.max(latest, entry.deployedAt ?? 0), 0),
        current: entries.find(entry => entry.isCurrent) ?? null,
        runningCount: entries.filter(entry => running[entry.deploymentId]?.running).length,
        nameMatches,
        matchedEntries,
      };
    });
  }, [apps, running, tokens]);

  const filteredGroups = useMemo(() => grouped
    .filter(group =>
      (!tokens.length || group.matchedEntries.length > 0)
      && (filter !== 'running' || group.runningCount > 0)
      && (filter !== 'unnamed' || !group.name),
    )
    .sort((a, b) => sortOrder === 'name'
      ? (a.name ?? a.appId).localeCompare(b.name ?? b.appId, 'zh-CN')
      : b.newestAt - a.newestAt || (a.name ?? a.appId).localeCompare(b.name ?? b.appId, 'zh-CN')),
  [grouped, tokens, filter, sortOrder]);

  useEffect(() => {
    setVisibleAppCount(INITIAL_APP_COUNT);
    setReleaseLimits({});
    setExpandedApps({});
  }, [query, filter, sortOrder]);

  const visibleGroups = filteredGroups.slice(0, visibleAppCount);
  const releaseCount = apps.filter(entry => Boolean(entry.releaseKey)).length;
  const runningCount = apps.filter(entry => Boolean(running[entry.deploymentId]?.running)).length;

  if (viewing) {
    return <AppLogViewer entry={viewing} onClose={() => setViewing(null)} />;
  }

  return (
    <div className="status-page apps-page">
      <div className="apps-toolbar">
        <div className="apps-heading">
          <h1 className="apps-title">本地应用</h1>
          <span className="apps-total">{grouped.length} 个应用 · {releaseCount} 个版本{runningCount > 0 && ` · ${runningCount} 个运行中`}</span>
        </div>
        <button className="btn btn-sm" onClick={() => void refresh(false)} disabled={loading}>
          {loading ? '加载中...' : '↺ 刷新'}
        </button>
      </div>

      <div className="apps-controls">
        <div className="apps-search">
          <span className="apps-search-icon" aria-hidden="true">⌕</span>
          <input
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="搜索应用名、版本或部署 ID"
            aria-label="搜索应用名、版本或部署 ID"
          />
          {search && <button type="button" onClick={() => setSearch('')} aria-label="清除搜索">×</button>}
        </div>
        <div className="apps-filters" aria-label="应用筛选">
          <button type="button" className={filter === 'all' ? 'active' : ''} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>全部</button>
          <button type="button" className={filter === 'running' ? 'active' : ''} aria-pressed={filter === 'running'} onClick={() => setFilter('running')}>运行中</button>
          <button type="button" className={filter === 'unnamed' ? 'active' : ''} aria-pressed={filter === 'unnamed'} onClick={() => setFilter('unnamed')}>名称未知</button>
        </div>
        <select
          className="apps-sort"
          value={sortOrder}
          onChange={event => setSortOrder(event.target.value as 'recent' | 'name')}
          aria-label="应用排序"
        >
          <option value="recent">最近部署</option>
          <option value="name">按名称</option>
        </select>
      </div>

      {error && (
        <div className="apps-error" role="alert">
          ⚠ 加载应用列表失败：{error}
        </div>
      )}

      {notice && (
        <div
          className={notice.kind === 'ok' ? 'apps-notice' : 'apps-notice apps-notice-err'}
          role="status"
          aria-live="polite"
        >
          {notice.kind === 'ok' ? '✓ ' : '⚠ '}
          {notice.text}
        </div>
      )}

      {loading && apps.length === 0 && !error && <div className="apps-loading">正在读取本地应用…</div>}

      {apps.length === 0 && !loading && !error && (
        <div className="apps-empty">
          <span className="empty-state-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <rect x="4" y="4" width="6" height="6" rx="1.2" /><rect x="14" y="4" width="6" height="6" rx="1.2" />
              <rect x="4" y="14" width="6" height="6" rx="1.2" /><rect x="14" y="14" width="6" height="6" rx="1.2" />
            </svg>
          </span>
          <strong>还没有部署应用</strong>
          <span>在管理后台部署应用后，这里会显示本机版本和运行日志。</span>
        </div>
      )}

      {apps.length > 0 && filteredGroups.length === 0 && (
        <div className="apps-empty">
          <strong>没有找到符合条件的应用</strong>
          <span>{filter === 'running' && !query
            ? '当前没有检测到运行中的应用；执行器未连接时，运行状态也可能暂时不可用。'
            : '可以试试应用名、版本号或部署 ID 的一部分。'}</span>
          <button type="button" className="btn btn-sm" onClick={() => { setSearch(''); setFilter('all'); }}>清除筛选</button>
        </div>
      )}

      {filteredGroups.length > 0 && (
        <div className="apps-results-summary">
          {query || filter !== 'all' ? `找到 ${filteredGroups.length} 个应用` : `按${sortOrder === 'recent' ? '最近部署' : '名称'}排序`}
          {filteredGroups.length > visibleAppCount && ` · 当前显示前 ${visibleAppCount} 个`}
        </div>
      )}

      <div className="apps-list">
        {visibleGroups.map(group => {
          const { appId, name, entries, current } = group;
          const expanded = expandedApps[appId] ?? Boolean(query);
          const groupBusy = Boolean(busy);
          const releases = group.matchedEntries;
          const initialLimit = query && !group.nameMatches ? MORE_RELEASE_COUNT : INITIAL_RELEASE_COUNT;
          const limit = releaseLimits[appId] ?? initialLimit;
          const hiddenCount = Math.max(0, releases.length - limit);
          return (
            <section key={appId} className={`app-group-card${expanded ? ' expanded' : ''}`}>
              <button
                className="app-group-toggle"
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpandedApps(previous => ({ ...previous, [appId]: !expanded }))}
              >
                <span className="app-group-main">
                  <span className={`app-group-name${name ? '' : ' app-group-name-unknown'}`} title={`${name ?? '未知应用名'} · 应用 ID：${appId}`}>
                    {name ?? '未知应用名'}
                    {!name && <span className="app-group-id-hint">{appId.slice(0, 8)}</span>}
                  </span>
                  <span className="app-group-summary">
                    {current ? `当前 ${current.version ? `v${current.version}` : '版本未知'}` : '无当前版本'}
                    {group.newestAt > 0 && ` · 最近部署 ${formatDeployTime(group.newestAt)}`}
                  </span>
                </span>
                <span className="app-group-header-meta">
                  {group.runningCount > 0 && <span className="app-badge app-badge-running">● {group.runningCount} 运行中</span>}
                  <span className="app-group-count">{entries.filter(entry => entry.releaseKey).length || 0} 个版本</span>
                  <span className={`app-group-chevron${expanded ? ' expanded' : ''}`} aria-hidden="true">⌄</span>
                </span>
              </button>

              {expanded && (
                <div id={`app-releases-${appId}`} className="app-group-details">
                  <div className="app-group-tools">
                    <span className="app-group-path" title={entries[0]?.appRoot ?? ''}>{entries[0]?.appRoot}</span>
                    <div className="app-group-actions">
                      <button type="button" className="btn btn-sm" onClick={() => void handleOpenFolder(entries[0], false)} title="在文件资源管理器中打开该应用的部署目录">打开应用目录</button>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={() => void handleUninstall(appId, name ?? appId.slice(0, 8), entries.length)}
                        disabled={groupBusy}
                        title="停止本机进程并删除该应用的全部本地部署文件"
                      >
                        {busy === appId ? '处理中…' : '卸载应用'}
                      </button>
                    </div>
                  </div>
                  <div className="app-releases-heading">本地版本 {query && !group.nameMatches ? `· 匹配 ${releases.length} 个` : ''}</div>
                  {releases.slice(0, limit).map(entry => {
                    const isRunning = Boolean(running[entry.deploymentId]?.running);
                    const blocked = entry.isCurrent || isRunning;
                    const label = entry.version ? `v${entry.version}` : entry.releaseKey ? '版本未知' : '尚无成功部署';
                    return (
                      <div key={entry.releaseKey || entry.deploymentId} className="app-deployment-row">
                        <div className="app-deployment-info" title={entry.releaseKey
                          ? `部署目录：${entry.releaseKey}\n部署 ID：${entry.deploymentId}\n部署时间：${entry.deployedAt ? new Date(entry.deployedAt).toLocaleString('zh-CN', { hour12: false }) : '未知'}`
                          : '部署目录已创建，尚无成功发布的版本'}>
                          <div className="app-deployment-top">
                            <span className="app-deployment-version">{label}</span>
                            {entry.isCurrent && <span className="app-badge app-badge-current" title="current 指向的生效版本">当前版本</span>}
                            {isRunning && <span className="app-badge app-badge-running" title={`进程运行中${running[entry.deploymentId]?.pid ? `（PID ${running[entry.deploymentId]?.pid}）` : ''}`}>● 运行中</span>}
                          </div>
                          <div className="app-deployment-sub">
                            {entry.releaseKey ? `部署 ${entry.deploymentId.slice(0, 8)}` : '等待版本落盘'}
                            {entry.deployedAt && ` · ${formatDeployTime(entry.deployedAt)}`}
                          </div>
                        </div>
                        <div className="app-deployment-actions">
                          {entry.hasLog ? (
                            <button type="button" className="btn btn-sm btn-success" onClick={() => setViewing(entry)}>应用日志</button>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-sm app-no-log-link"
                              onClick={() => requestTabSwitch('history')}
                              title={entry.runMode === 'scheduled'
                                ? '定时/触发应用没有常驻日志。点击查看逐次执行日志'
                                : '该版本未产生应用日志。点击查看逐次执行日志'}
                            >执行日志</button>
                          )}
                          {entry.releaseKey && (
                            <>
                              <button type="button" className="btn btn-sm app-icon-button" onClick={() => void handleOpenFolder(entry, true)} title="打开该版本的部署目录" aria-label={`打开 ${label} 的部署目录`}>📂</button>
                              <button
                                type="button"
                                className="btn btn-sm btn-danger app-icon-button"
                                disabled={blocked || groupBusy}
                                onClick={() => void handleDeleteRelease(entry)}
                                title={entry.isCurrent
                                  ? '当前生效版本不可删除；请先部署新版本，或卸载整个应用'
                                  : isRunning
                                    ? '该版本的进程正在运行，请先在中台停止应用再删除'
                                    : '删除本机上这一份部署文件（不影响中台记录）'}
                                aria-label={`删除 ${label} 的本地部署`}
                              >{busy === entry.appId + entry.releaseKey ? '…' : '🗑'}</button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {(hiddenCount > 0 || limit > initialLimit) && (
                    <div className="app-release-more">
                      {hiddenCount > 0 && <button type="button" onClick={() => setReleaseLimits(previous => ({ ...previous, [appId]: limit + MORE_RELEASE_COUNT }))}>再显示 {Math.min(hiddenCount, MORE_RELEASE_COUNT)} 个旧版本 · 剩余 {hiddenCount} 个</button>}
                      {limit > initialLimit && <button type="button" onClick={() => setReleaseLimits(previous => ({ ...previous, [appId]: initialLimit }))}>收起旧版本</button>}
                    </div>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
      {filteredGroups.length > visibleAppCount && (
        <button type="button" className="btn apps-more-apps" onClick={() => setVisibleAppCount(count => count + INITIAL_APP_COUNT)}>
          再显示 {Math.min(INITIAL_APP_COUNT, filteredGroups.length - visibleAppCount)} 个应用 · 剩余 {filteredGroups.length - visibleAppCount} 个
        </button>
      )}
    </div>
  );
}
