import React, { useCallback, useEffect, useRef, useState } from 'react';
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

/** 部署时间行内显示：MM-dd HH:mm（同年省年份，行内空间紧张）。 */
function formatDeployTime(ms: number | null): string {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

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
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // 停止轮询（对齐 HistoryPage 查看器）：持续失败时不再每 2s 重抛刷屏；
      // 按钮随之显示「已暂停」，用户排除问题后可手动点「实时」重试。
      setAutoRefresh(false);
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
    autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 40;
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
            placeholder="搜索日志…"
            value={query}
            onChange={e => { setQuery(e.target.value); setMatchIdx(0); }}
          />
          {q && (
            <span className="log-fs-count">
              {totalMatches ? `${safeMatchIdx + 1} / ${totalMatches}` : '无结果'}
            </span>
          )}
          {q && totalMatches > 0 && (
            <>
              <button className="log-fs-nav" onClick={() => setMatchIdx(p => Math.max(0, p - 1))}>↑</button>
              <button className="log-fs-nav" onClick={() => setMatchIdx(p => Math.min(totalMatches - 1, p + 1))}>↓</button>
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
          <button className="btn btn-sm" onClick={onClose}>✕ 关闭</button>
        </div>
      </div>
      <div className="log-fs-body">
        <div className="log-viewer log-fs-content" ref={logRef} onScroll={handleScroll}>
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
          {filtered.map(({ line, i, hit }) => {
            if (!hit) return null;
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
  // D 修正：列表加载失败同样不能静默——失败会让页面显示「暂无已部署应用」，
  // 用户会误以为需要去后台部署，而真实原因是本地 IPC/目录读取异常。
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<AppEntry | null>(null);
  // 行内操作的结果反馈（打开目录失败 / 删除被拒等）——必须显性化：
  // 静默失败会让用户以为按钮坏了（原实现连按钮都没有）。
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  // 正在执行破坏性操作的 appId——期间禁用按钮，避免重复点击。
  const [busy, setBusy] = useState<string | null>(null);

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
    void refresh(false);
    // 中台部署/更新应用后，执行器本地会拉取——列表自动跟进，无需手动刷新
    // （与 HistoryPage 的 5s 轮询对齐）；窗口重新可见时也立即同步一次。
    const timer = setInterval(() => void refresh(true), 5000);
    const onVisible = () => { if (!document.hidden) void refresh(true); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
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
        <button className="btn btn-sm" onClick={() => void refresh(false)} disabled={loading}>
          {loading ? '加载中...' : '↺ 刷新'}
        </button>
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

      {apps.length === 0 && !loading && !error && (
        <div className="apps-empty">
          暂未发现本地部署的应用<br />
          <span>需要先在管理后台创建并部署应用到本执行器</span>
        </div>
      )}

      {Object.entries(grouped).map(([appId, entries]) => {
        // 名字解析优先级：app.json（权威）→ 执行器日志回溯 → 如实显示「未知应用名」。
        // 绝不用 appId 当名字——UUID 对用户没有信息量（用户报障的核心）。
        const named = entries.find((e) => e.appName);
        const displayName = named?.appName ?? null;
        const groupBusy = busy === appId;
        return (
          <div key={appId} className="app-group">
            <div className="app-group-card">
              {/* App header */}
              <div className="app-group-header">
                <span className="app-group-icon">📦</span>
                {displayName ? (
                  <span className="app-group-name" title={`应用 ID：${appId}`}>
                    {displayName}
                  </span>
                ) : (
                  // 旧部署没有 app.json、日志也已过期 → 本机确实不知道名字。
                  // 如实说明 + 给出短 ID 供比对，而不是拿 UUID 冒充应用名。
                  <span className="app-group-name app-group-name-unknown" title={`应用 ID：${appId}`}>
                    未知应用名
                    <span className="app-group-id-hint">{appId.slice(0, 8)}</span>
                  </span>
                )}
                <span className="app-group-count">{entries.length} 个部署</span>
                <div className="app-group-actions">
                  <button
                    className="btn btn-sm"
                    onClick={() => void handleOpenFolder(entries[0], false)}
                    title="在文件资源管理器中打开该应用的部署目录"
                  >
                    📂 打开文件夹
                  </button>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => void handleUninstall(appId, displayName ?? appId.slice(0, 8), entries.length)}
                    disabled={groupBusy}
                    title="停止本机进程并删除该应用的全部本地部署文件"
                  >
                    {groupBusy ? '处理中...' : '🗑 卸载应用'}
                  </button>
                </div>
              </div>

              {/* 部署根目录：让用户知道文件到底在哪（此前完全看不到） */}
              <div className="app-group-path" title={entries[0]?.appRoot ?? ''}>
                {entries[0]?.appRoot}
              </div>

              {/* Deployment rows */}
              {entries.map(entry => (
                <div key={entry.releaseKey || entry.deploymentId} className="app-deployment-row">
                  {/* 完整 releaseKey + 部署时间放 tooltip：行内只显示缩写，
                      同一版本号多次部署（releaseKey 不同）靠部署时间区分。 */}
                  <span
                    className="app-deployment-id"
                    title={entry.releaseKey
                      ? `部署目录：${entry.releaseKey}\n部署时间：${entry.deployedAt ? new Date(entry.deployedAt).toLocaleString('zh-CN', { hour12: false }) : '未知'}`
                      : '尚无成功部署（目录下没有 release）'}
                  >
                    {entry.version ? (
                      <span className="app-deployment-version">v{entry.version}</span>
                    ) : (
                      <span className="app-deployment-version app-no-log">版本未知</span>
                    )}
                    {entry.isCurrent && (
                      <span className="app-badge app-badge-current" title="current 指向的即时版本">
                        当前版本
                      </span>
                    )}
                    {/* 运行态：与「当前版本」是**两件事**——current 指向只说明
                        current 链切到了这个 release；进程是否活着要看执行器的
                        daemon 登记。daemon 启动失败时 current 已切过去但进程没起来，
                        只显示「当前版本」会让用户以为应用在跑。 */}
                    {entry.releaseKey && running[entry.deploymentId]?.running && (
                      <span
                        className="app-badge app-badge-running"
                        title={`进程运行中${running[entry.deploymentId]?.pid ? `（PID ${running[entry.deploymentId]?.pid}）` : ''}`}
                      >
                        ● 运行中
                      </span>
                    )}
                    {entry.releaseKey && (
                      <span className="app-deployment-uuid">
                        {entry.deploymentId.slice(0, 8)}
                      </span>
                    )}
                    {entry.deployedAt ? (
                      <span className="app-deployment-time">{formatDeployTime(entry.deployedAt)}</span>
                    ) : null}
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
                      // 「无日志」是可解释的正常状态（见查看器内说明），但仍要
                      // 让用户能一步跳到真正有日志的地方——给一个死胡同文案
                      // 正是用户报障的体验。按钮语义（可点）用 .app-no-log-link。
                      <button
                        className="btn btn-sm app-no-log-link"
                        onClick={() => requestTabSwitch('history')}
                        title={
                          entry.runMode === 'scheduled'
                            ? '该应用以定时/触发模式部署，不常驻运行，因此没有 app.log。点击查看执行日志'
                            : '该部署未产生 app.log（常驻模式才写应用日志）。点击查看执行日志'
                        }
                      >
                        无应用日志 · 看执行日志
                      </button>
                    )}
                    {entry.releaseKey && (
                      <>
                        <button
                          className="btn btn-sm"
                          onClick={() => void handleOpenFolder(entry, true)}
                          title="打开该版本的部署目录（含 app.log 与代码文件）"
                        >
                          📂
                        </button>
                        {/* 当前生效版本不可删（删了应用直接不可用）——按钮直接禁用
                            并把原因放 tooltip，比点了才报错更省事。
                            运行中的版本同样禁用：主进程会保守拒绝（删正在跑的版本
                            会留下孤儿进程 + 半删目录），禁用比让用户点了吃报错更好。 */}
                        {(() => {
                          const isRunning = Boolean(running[entry.deploymentId]?.running);
                          const blocked = entry.isCurrent || isRunning;
                          return (
                            <button
                              className="btn btn-sm btn-danger"
                              disabled={blocked || groupBusy}
                              onClick={() => void handleDeleteRelease(entry)}
                              title={
                                entry.isCurrent
                                  ? '当前生效版本不可删除；请先部署新版本，或卸载整个应用'
                                  : isRunning
                                    ? '该版本的进程正在运行，请先在中台停止应用再删除'
                                    : '删除本机上这一份部署文件（不影响中台记录）'
                              }
                            >
                              {busy === entry.appId + entry.releaseKey ? '…' : '🗑'}
                            </button>
                          );
                        })()}
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
