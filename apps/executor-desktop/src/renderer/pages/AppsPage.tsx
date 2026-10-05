import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../components/Icon';
import PageHeader from '../components/PageHeader';
import ConfirmBar from '../components/ConfirmBar';
import EmptyState from '../components/EmptyState';
import LogViewer, { ViewerLine, ViewerLogLevel } from '../components/LogViewer';
import { requestTabSwitch } from '../tab-switch';
// V4 后续优化（6）i18n 二期：应用页文案入双语表（zh 值与原硬编码逐字一致）。
import { createCfgTexts, resolveRendererLocale } from '../i18n';

const t = createCfgTexts(resolveRendererLocale(() => navigator.language));

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

/** 页内二次确认的载荷（替代原生的 confirm 弹窗）。 */
type PendingConfirm =
  | { kind: 'uninstall'; appId: string; name: string; count: number }
  | { kind: 'delete-release'; appId: string; entry: AppEntry; label: string };

/** 关键词分级（与 HistoryPage 同口径）：error/warn/空 —— 映射为共享查看器的行级别。 */
function classifyLog(line: string): ViewerLogLevel {
  const l = line.toLowerCase();
  if (l.includes('error') || l.includes('failed') || l.includes('err ')) return 'error';
  if (l.includes('warn')) return 'warn';
  return '';
}

// ── 应用日志查看器（日志工作台 v3 第二步之二：改接共享 components/LogViewer）──
// UX 审计 B-06：三个日志查看器三种物种——原页面内 AppLogViewer 的整套 UI
// （搜索/匹配跳转/自动滚动/加载更早/Esc）已由共享组件承接（真全屏
// .log-fullscreen、搜索 + Ctrl+F、级别 chips、折行、跟随底部/查看最新、
// 窗口化 350 行、Esc 关闭 + 焦点归还、到达动效均为组件内置），页面侧只留
// 应用页差异：
//   - 数据链路：readAppLog(logPath, fromLine) 增量拉取 + 2s autoRefresh 轮询；
//     失败时停轮询（「实时」钮转「已暂停」，再点即恢复——与迁移前一致）。
//     不传 onRetry：共享查看器的错误行即不带原位重试钮，本页的失败恢复
//     通路是「实时」钮。
//   - 「实时/已暂停」「全部重载」经 extraTools 注入工具行。
//   - 无 app.log 的引导空态经 emptyState 注入（!entry.hasLog 分支保留于此）；
//     行号走共享组件默认 buffered（缓冲下标+1，与状态页一致）。
const APP_LOG_BUFFER = 2400;

function AppLogScreen({ entry, onClose }: { entry: AppEntry; onClose: () => void }) {
  const [lines, setLines] = useState<ViewerLine[]>([]);
  const [loading, setLoading] = useState(false);
  // D 修正：原实现 `catch { /* ignore */ }` 把 IPC 失败静默吞掉——用户看到
  // 「暂无日志文件」而真实原因是读取失败（权限/文件被删/通道异常），无法区分。
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const totalLinesRef = useRef(0);
  const inFlight = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // V4 后续优化（3）：行内「打开部署目录」入口的失败反馈——复用查看器工具行
  // 下方 notice 位（不与日志读取失败的 error 行混用，6s 自动消失）。
  const [folderNote, setFolderNote] = useState<string | null>(null);
  useEffect(() => {
    if (!folderNote) return;
    const t = setTimeout(() => setFolderNote(null), 6000);
    return () => clearTimeout(t);
  }, [folderNote]);

  async function openFolder() {
    setFolderNote(null);
    try {
      const res = await window.electronAPI.openReleaseFolder(entry.appId, entry.releaseKey);
      if (!res.ok) setFolderNote(`打开目录失败：${res.error ?? '未知原因'}`);
    } catch (err) {
      setFolderNote(`打开目录失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const fetchLogs = useCallback(async (fromLine = 0) => {
    if (!entry.hasLog || inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await window.electronAPI.readAppLog(entry.logPath, fromLine);
      // 行 id = 文件全局行号（本次返回首行的行号 = totalLines - 返回行数）。
      // 追加轮询与缓冲滑动（只留最近 APP_LOG_BUFFER 行）之下 id 保持稳定，
      // 共享查看器的到达动效/「N 条新日志」计数才不会把整屏误判成新行。
      const firstLineNo = result.totalLines - result.lines.length;
      const toViewerLine = (text: string, idx: number): ViewerLine =>
        ({ id: firstLineNo + idx, text, level: classifyLog(text) });
      if (result.totalLines < fromLine) {
        // 日志轮转/截断：旧行不能混进新文件的内容，整体换成新文件尾部。
        setLines(result.lines.slice(-APP_LOG_BUFFER).map(toViewerLine));
      } else if (result.lines.length > 0) {
        const fetched = result.lines.map(toViewerLine);
        setLines(prev => {
          const next = fromLine === 0 ? fetched : [...prev, ...fetched];
          return next.length > APP_LOG_BUFFER ? next.slice(-APP_LOG_BUFFER) : next;
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
    // 隐藏页轮询门控：Tab 常驻挂载（App.tsx），应用 Tab 隐藏/窗口最小化时
    // 查看器仍每 2s 拉增量。沿用本页列表轮询的 active() + MutationObserver
    // 门控（见 refresh 的 useEffect）：隐藏期间暂停拉取，恢复可见立即补拉
    // 一次（增量 fromLine 语义不变，隐藏期间的行一次性并入）。读取失败仍
    // 停轮询（fetchLogs → setAutoRefresh(false)），「实时」钮恢复。
    const panel = document.getElementById('apps-panel');
    const active = () => !document.hidden && !panel?.hidden;
    timerRef.current = setInterval(() => {
      if (active()) fetchLogs(totalLinesRef.current);
    }, 2000);
    const kick = () => { if (active()) fetchLogs(totalLinesRef.current); };
    const observer = panel ? new MutationObserver(kick) : null;
    if (panel) observer?.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    document.addEventListener('visibilitychange', kick);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      observer?.disconnect();
      document.removeEventListener('visibilitychange', kick);
    };
  }, [autoRefresh, fetchLogs]);

  return (
    <LogViewer
      title={(
        <>
          {entry.appName ?? t('apps.unknownName')}
          {entry.version ? ` v${entry.version}` : ''}
          {entry.isCurrent ? t('apps.currentVersionSuffix') : ''} /{' '}
          <span className="log-fs-deployment-id">{entry.deploymentId.slice(0, 8)}</span>
        </>
      )}
      lines={lines}
      onClose={onClose}
      loading={loading}
      error={error ? t('apps.viewer.loadFail', error) : null}
      // 实时轮询有到达感：新行 2s 绿底淡出（行 id 为文件全局行号，首屏不闪）
      arriveAnimation
      // V4 后续优化（3）：warn/error 行 hover 直接打开部署目录（与其他查看器
      // 的「打开文件」入口同位不同义，title 随语义）
      onOpenFile={openFolder}
      onOpenFileTitle={t('apps.openDeployDir')}
      notice={folderNote ?? undefined}
      extraTools={(
        <>
          <button
            className={`btn btn-sm${autoRefresh ? ' btn-success' : ''}`}
            onClick={() => setAutoRefresh(v => !v)}
            title={autoRefresh ? t('apps.autoRefreshOffTitle') : t('apps.autoRefreshOnTitle')}
          >
            <Icon name="refresh" /> {autoRefresh ? t('apps.live') : t('apps.paused')}
          </button>
          <button className="btn btn-sm" onClick={() => void fetchLogs(0)}>
            <Icon name="refresh" /> {t('apps.reloadAll')}
          </button>
        </>
      )}
      emptyState={entry.hasLog ? (
        <span className="log-empty"><Icon name="terminal" className="icon-xs" />{t('apps.viewer.emptyLog')}</span>
      ) : (
        <div className="log-empty-block">
          <span className="log-empty">{t('apps.viewer.noAppLog')}</span>
          {/* 用户报障：「明明有日志，但是应用tab却显示没日志」。真实原因是
              两类日志不是一回事——应用日志（app.log）只有常驻 daemon/once
              模式才写（deploy.ts 只对这两者调 startApp），而用户看到的日志
              是**任务执行日志**，在「历史」页。必须把区别讲清楚 + 给出可点
              的通路，否则用户会以为日志丢了。 */}
          <span className="log-empty-hint">
            {entry.runMode === 'scheduled'
              ? t('apps.viewer.scheduledReason')
              : t('apps.viewer.daemonReason')}
            <br />
            {t('apps.viewer.execLogHint')}
          </span>
          <button
            className="btn btn-sm"
            onClick={() => {
              // 关掉查看器再切页：否则用户切回来后仍停在"无日志"的空视图上。
              onClose();
              requestTabSwitch('history');
            }}
          ><Icon name="doc" /> {t('apps.viewer.goHistory')}</button>
        </div>
      )}
    />
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
  // 破坏性操作（卸载应用 / 删除版本）的页内二次确认态。原实现用原生 confirm
  // 弹窗——无边框窗口下会阻塞渲染进程且样式不可控（部分平台直接
  // 不显示，HistoryPage 清除历史早已因此改为页内确认），此处对齐。
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  // C-05：确认条出现时必须滚进视口——列表尾部卡片的「卸载/删除」把确认条插在
  // 卡内，落在视口外（截图 14 恰好可见纯属夹具卡短）。
  const confirmBarRef = useRef<HTMLDivElement | null>(null);
  const hasLoadedRef = useRef(false);
  // V4-4（X-05）：Ctrl+F 聚焦本页搜索框；查看器打开（viewing）时让位给查看器。
  const searchRef = useRef<HTMLInputElement>(null);
  const viewingRef = useRef(false);
  viewingRef.current = viewing !== null;

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
    const observer = panel ? new MutationObserver(refreshActive) : null;
    if (panel) observer?.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
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

  // V4-4（X-05）：Ctrl+F 聚焦搜索框（页面可见且查看器未打开时；HistoryPage 同口径）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key !== 'f') return;
      const panel = document.getElementById('apps-panel');
      if (!panel || panel.hidden || viewingRef.current) return;
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // C-05：确认条插入后滚进视口（block:'nearest'——本就可见时零滚动，不打扰）。
  // useEffect 在 DOM 提交后执行，确认条此时必然已挂上 ref；不做动画。
  useEffect(() => {
    if (pendingConfirm) confirmBarRef.current?.scrollIntoView({ block: 'nearest' });
  }, [pendingConfirm]);

  /** 打开应用根目录（用户报障：客户端本地无法查看部署的应用文件夹）。 */
  async function handleOpenFolder(entry: AppEntry, releaseOnly: boolean) {
    const res = releaseOnly
      ? await window.electronAPI.openReleaseFolder(entry.appId, entry.releaseKey)
      : await window.electronAPI.openAppFolder(entry.appId);
    if (!res.ok) setNotice({ kind: 'err', text: t('apps.notice.openFolderFail', res.error ?? t('apps.unknownReason')) });
  }

  /** 删除单个历史版本（用户报障：无法撤销部署）。仅由页内确认条触发。 */
  async function handleDeleteRelease(entry: AppEntry) {
    const label = entry.version ? `v${entry.version}` : entry.releaseKey;
    setBusy(entry.appId + entry.releaseKey);
    try {
      const res = await window.electronAPI.deleteAppRelease(
        entry.appId,
        entry.releaseKey,
        entry.deploymentId,
      );
      if (res.ok) {
        setNotice({ kind: 'ok', text: t('apps.notice.deleted', label) });
        await refresh(true);
      } else {
        setNotice({ kind: 'err', text: res.error ?? t('apps.notice.deleteFail') });
      }
    } catch (err) {
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  /** 卸载整个应用（本机目录 + 停止常驻进程）。仅由页内确认条触发。 */
  async function handleUninstall(appId: string, displayName: string, count: number) {
    setBusy(appId);
    try {
      const res = await window.electronAPI.uninstallApp(appId);
      if (res.ok) {
        setNotice({
          kind: 'ok',
          text:
            res.mode === 'executor'
              ? t('apps.notice.uninstalled', displayName, res.stopped?.length ?? 0)
              : t('apps.notice.uninstalledOffline', displayName),
        });
        await refresh(true);
      } else {
        // 部分成功也要说清楚：进程可能已停但目录没删掉（executor 的 rm 失败
        // 是藏在 HTTP 200 应答体里的，主进程已如实回报）。
        const stoppedNote = res.stopped?.length ? t('apps.notice.partialStop', res.stopped.length) : '';
        setNotice({ kind: 'err', text: (res.error ?? t('apps.notice.uninstallFail')) + stoppedNote });
        // 失败也可能已改变了本机状态（进程被停）——刷新一次让列表与现实一致。
        await refresh(true);
      }
    } catch (err) {
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  // V4 后续优化（4）：搜索过滤走 useDeferredValue（同 HistoryPage 口径）
  const deferredSearch = useDeferredValue(search);
  const query = deferredSearch.trim().toLocaleLowerCase();
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
    return <AppLogScreen entry={viewing} onClose={() => setViewing(null)} />;
  }

  return (
    <div className="status-page apps-page">
      <PageHeader
        icon={<Icon name="box" />}
        title={t('apps.title')}
        meta={<>{t('apps.meta', grouped.length, releaseCount)}{runningCount > 0 && t('apps.metaRunning', runningCount)}</>}
        actions={
          <button className="btn btn-sm" onClick={() => void refresh(false)} disabled={loading}>
            {loading ? t('shell.loading') : <><Icon name="refresh" /> {t('ui.refresh')}</>}
          </button>
        }
      />

      <div className="apps-controls">
        <div className="apps-search">
          <span className="apps-search-icon" aria-hidden="true"><Icon name="search" /></span>
          <input
            ref={searchRef}
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder={t('apps.searchPlaceholder')}
            aria-label={t('apps.searchAria')}
          />
          {search && <button type="button" onClick={() => setSearch('')} aria-label={t('apps.clearSearch')}><Icon name="close" className="icon-xs" /></button>}
        </div>
        <div className="apps-filters" aria-label={t('apps.filtersAria')}>
          <button type="button" className={filter === 'all' ? 'active' : ''} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>{t('logviewer.levelAll')}</button>
          <button type="button" className={filter === 'running' ? 'active' : ''} aria-pressed={filter === 'running'} onClick={() => setFilter('running')}>{t('history.status.running')}</button>
          <button type="button" className={filter === 'unnamed' ? 'active' : ''} aria-pressed={filter === 'unnamed'} onClick={() => setFilter('unnamed')}>{t('apps.filterUnnamed')}</button>
        </div>
        <select
          className="apps-sort"
          value={sortOrder}
          onChange={event => setSortOrder(event.target.value as 'recent' | 'name')}
          aria-label={t('apps.sortAria')}
        >
          <option value="recent">{t('apps.sortRecent')}</option>
          <option value="name">{t('apps.sortName')}</option>
        </select>
      </div>

      {error && (
        <div className="apps-error" role="alert">
          <Icon name="warning" className="icon-xs" /> {t('apps.loadError', error)}
        </div>
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

      {loading && apps.length === 0 && !error && (
        <div className="apps-list" aria-label="正在读取本地应用">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="skeleton skeleton-group">
              <div className="skeleton-line w-45" />
              <div className="skeleton-row">
                <div className="skeleton-line w-70" />
              </div>
            </div>
          ))}
        </div>
      )}

      {apps.length === 0 && !loading && !error && (
        /* V4-5（G-02/V-09）：空态换 EmptyState 且行动出口改对——「没有应用」
            的下一步在管理后台（说明前置），刷新只是「已部署过」的补救项 */
        <EmptyState icon="box" title={t('apps.empty.title')}>
          <span className="empty-state-text">{t('apps.empty.body')}</span>
          <span className="empty-hint">{t('apps.empty.hint')}</span>
          <button className="btn btn-sm" onClick={() => void refresh(false)} disabled={loading}>
            <Icon name="refresh" /> {t('apps.empty.refresh')}
          </button>
        </EmptyState>
      )}

      {apps.length > 0 && filteredGroups.length === 0 && (
        <EmptyState icon="search" title={t('apps.empty.noMatchTitle')}>
          <span className="empty-state-text">{filter === 'running' && !query
            ? t('apps.empty.noRunningBody')
            : t('apps.empty.noMatchBody')}</span>
          <button type="button" className="btn btn-sm" onClick={() => { setSearch(''); setFilter('all'); }}>{t('history.empty.clearFilters')}</button>
        </EmptyState>
      )}

      {filteredGroups.length > 0 && (
        <div className="apps-results-summary">
          {query || filter !== 'all' ? t('apps.summary.found', filteredGroups.length) : sortOrder === 'recent' ? t('apps.summary.recent') : t('apps.summary.name')}
          {filteredGroups.length > visibleAppCount && t('apps.summary.shown', visibleAppCount)}
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
                onClick={event => {
                  // C-05：展开后把卡片滚进视口（收起不滚）。必须先同步取卡片
                  // 元素再 rAF——React 合成事件的 currentTarget 在处理器返回后
                  // 即被置空，rAF 回调里不能再取；rAF 时本次展开的 DOM 已提交，
                  // 'nearest' 按**展开后**的卡片高度做最小滚动。
                  const card = event.currentTarget.closest<HTMLElement>('.app-group-card');
                  setExpandedApps(previous => ({ ...previous, [appId]: !expanded }));
                  if (card && !expanded) {
                    requestAnimationFrame(() => card.scrollIntoView({ block: 'nearest' }));
                  }
                }}
              >
                <span className="app-group-main">
                  <span className="app-group-name-row">
                    <span className={`app-avatar${name ? '' : ' app-avatar-unknown'}`} aria-hidden="true">
                      {name ? name.trim().charAt(0).toUpperCase() : '?'}
                    </span>
                    <span className={`app-group-name${name ? '' : ' app-group-name-unknown'}`} title={name ? t('apps.nameTitle', name, appId) : t('apps.nameUnknownTitle', appId)}>
                      {name ?? t('apps.unknownName')}
                      {!name && <span className="app-group-id-hint">{appId.slice(0, 8)}</span>}
                    </span>
                    {/* B-07：当前版本徽章升格到折叠态名称行——默认视图不必展开
                        就能看出应用哪个版本在生效（15 个应用的默认视图此前
                        只是一个目录页）。无 current 时不渲染徽章，副标题如实
                        保留「无当前版本」口径。 */}
                    {current && (
                      <span className="app-badge app-badge-current">
                        {current.version ? `当前 v${current.version}` : '当前版本未知'}
                      </span>
                    )}
                  </span>
                  <span className="app-group-summary">
                    {/* 有徽章后副标题不再重复「当前 vX」；无 current 时保持原口径 */}
                    {!current && t('apps.noCurrent')}
                    {group.newestAt > 0 && `${current ? '' : ' · '}${t('apps.lastDeployed', formatDeployTime(group.newestAt))}`}
                  </span>
                </span>
                <span className="app-group-header-meta">
                  {/* V4-5（I-06）：scheduled 前置预告——「为什么没有应用日志」的
                      教育从查看器空态前移到列表层（数据已有 entry.runMode） */}
                  {entries.some(entry => entry.runMode === 'scheduled') && (
                    <span className="app-badge app-badge-scheduled" title={t('apps.scheduledTitle')}>{t('apps.scheduled')}</span>
                  )}
                  {group.runningCount > 0 && <span className="app-badge app-badge-running">{t('apps.runningCount', group.runningCount)}</span>}
                  <span className="app-group-count">{t('apps.versionCount', entries.filter(entry => entry.releaseKey).length || 0)}</span>
                  <span className={`app-group-chevron${expanded ? ' expanded' : ''}`} aria-hidden="true"><Icon name="chevron-down" /></span>
                </span>
              </button>

              {/* V4-5（M-02）：常驻挂载 + collapsible 高度过渡（同 HistoryPage 口径） */}
              <div
                id={`app-releases-${appId}`}
                className="collapsible app-group-details-collapsible"
                data-open={expanded}
                aria-hidden={!expanded}
              >
                <div className="collapsible-inner" inert={!expanded}>
                <div className="app-group-details">
                  <div className="app-group-tools">
                    <span className="app-group-path" title={entries[0]?.appRoot ?? ''}>{entries[0]?.appRoot}</span>
                    <div className="app-group-actions">
                      <button type="button" className="btn btn-sm" onClick={() => void handleOpenFolder(entries[0], false)} title={t('apps.openFolderTitle')}><Icon name="folder" /> {t('apps.openFolder')}</button>
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-danger"
                        onClick={() => setPendingConfirm({ kind: 'uninstall', appId, name: name ?? appId.slice(0, 8), count: entries.length })}
                        disabled={groupBusy || Boolean(pendingConfirm)}
                        title={t('apps.uninstallTitle')}
                      >
                        {busy === appId ? t('apps.busy') : t('apps.uninstall')}
                      </button>
                    </div>
                  </div>
                  {pendingConfirm && pendingConfirm.appId === appId && (
                    /* V4-4（X-01）：换装共享 ConfirmBar——主钮统一 autoFocus
                        （此前此处 autoFocus 在「取消」上，与停机确认相反） */
                    <div ref={confirmBarRef}>
                      <ConfirmBar
                        titleId={`apps-confirm-title-${appId}`}
                        title={
                          pendingConfirm.kind === 'uninstall'
                            ? t('apps.uninstallConfirmTitle', pendingConfirm.name)
                            : t('apps.deleteConfirmTitle', pendingConfirm.label, pendingConfirm.entry.deploymentId.slice(0, 8))}
                        description={
                          (pendingConfirm.kind === 'uninstall'
                            ? t('apps.uninstallConfirmDesc', pendingConfirm.count)
                            : t('apps.deleteConfirmDesc'))
                          + t('apps.irreversible')}
                        confirmLabel={pendingConfirm.kind === 'uninstall' ? t('apps.confirmUninstall') : t('apps.confirmDelete')}
                        variant="danger"
                        confirmDisabled={Boolean(busy)}
                        onConfirm={() => {
                          const action = pendingConfirm;
                          setPendingConfirm(null);
                          if (action.kind === 'uninstall') void handleUninstall(action.appId, action.name, action.count);
                          else void handleDeleteRelease(action.entry);
                        }}
                        onCancel={() => setPendingConfirm(null)}
                      />
                    </div>
                  )}
                  <div className="app-releases-heading">{t('apps.localReleases')}{query && !group.nameMatches ? t('apps.matching', releases.length) : ''}</div>
                  {releases.slice(0, limit).map(entry => {
                    const isRunning = Boolean(running[entry.deploymentId]?.running);
                    const blocked = entry.isCurrent || isRunning;
                    const label = entry.version ? `v${entry.version}` : entry.releaseKey ? t('apps.versionUnknown') : t('apps.noReleaseYet');
                    return (
                      <div key={entry.releaseKey || entry.deploymentId} className="app-deployment-row">
                        <div className="app-deployment-info" title={entry.releaseKey
                          ? t('apps.deploymentTitle', entry.releaseKey, entry.deploymentId, entry.deployedAt ? new Date(entry.deployedAt).toLocaleString('zh-CN', { hour12: false }) : t('apps.deployTimeUnknown'))
                          : t('apps.deploymentPendingTitle')}>
                          <div className="app-deployment-top">
                            <span className="app-deployment-version">{label}</span>
                            {entry.isCurrent && <span className="app-badge app-badge-current" title={t('apps.currentBadgeTitle')}>{t('apps.currentBadge')}</span>}
                            {isRunning && <span className="app-badge app-badge-running" title={running[entry.deploymentId]?.pid ? t('apps.runningBadgeTitle', running[entry.deploymentId]?.pid) : t('apps.runningBadgeTitlePlain')}>{t('history.status.running')}</span>}
                          </div>
                          <div className="app-deployment-sub">
                            {entry.releaseKey ? t('apps.deployedAs', entry.deploymentId.slice(0, 8)) : t('apps.awaitingRelease')}
                            {entry.deployedAt && ` · ${formatDeployTime(entry.deployedAt)}`}
                          </div>
                        </div>
                        <div className="app-deployment-actions">
                          {entry.hasLog ? (
                            <button type="button" className="btn btn-sm" onClick={() => setViewing(entry)}>{t('apps.appLog')}</button>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-sm app-no-log-link"
                              onClick={() => requestTabSwitch('history')}
                              title={entry.runMode === 'scheduled'
                                ? t('apps.noLogScheduledTitle')
                                : t('apps.noLogTitle')}
                            >{t('apps.execLog')}</button>
                          )}
                          {entry.releaseKey && (
                            <>
                              <button type="button" className="btn btn-sm app-icon-button" onClick={() => void handleOpenFolder(entry, true)} title={t('apps.openReleaseTitle')} aria-label={t('apps.openReleaseAria', label)}><Icon name="folder" /></button>
                              <button
                                type="button"
                                className="btn btn-sm btn-danger-ghost app-icon-button"
                                disabled={blocked || groupBusy || Boolean(pendingConfirm)}
                                onClick={() => setPendingConfirm({ kind: 'delete-release', appId, entry, label })}
                                title={entry.isCurrent
                                  ? t('apps.deleteBlockedCurrent')
                                  : isRunning
                                    ? t('apps.deleteBlockedRunning')
                                    : t('apps.deleteAllowedTitle')}
                                aria-label={t('apps.deleteAria', label)}
                              >{busy === entry.appId + entry.releaseKey ? '...' : <Icon name="trash" />}</button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {(hiddenCount > 0 || limit > initialLimit) && (
                    <div className="app-release-more">
                      {hiddenCount > 0 && <button type="button" onClick={() => setReleaseLimits(previous => ({ ...previous, [appId]: limit + MORE_RELEASE_COUNT }))}>{t('apps.moreReleases', Math.min(hiddenCount, MORE_RELEASE_COUNT), hiddenCount)}</button>}
                      {limit > initialLimit && <button type="button" onClick={() => setReleaseLimits(previous => ({ ...previous, [appId]: initialLimit }))}>{t('apps.collapseReleases')}</button>}
                    </div>
                  )}
                </div>
                </div>
              </div>
            </section>
          );
        })}
      </div>
      {filteredGroups.length > visibleAppCount && (
        <button type="button" className="btn apps-more-apps" onClick={() => setVisibleAppCount(count => count + INITIAL_APP_COUNT)}>
          {t('apps.moreApps', Math.min(INITIAL_APP_COUNT, filteredGroups.length - visibleAppCount), filteredGroups.length - visibleAppCount)}
        </button>
      )}
    </div>
  );
}
