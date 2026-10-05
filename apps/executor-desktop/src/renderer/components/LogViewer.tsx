import React, { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon';
import LogLineList from './LogLineList';
import { createCfgTexts, resolveRendererLocale } from '../i18n';

/** V4 后续优化（6）：查看器内置文案入双语表（zh 值与原硬编码逐字一致）。 */
const t = createCfgTexts(resolveRendererLocale(() => navigator.language));

/**
 * 共享全屏日志查看器（日志工作台 v3 第一步：从 StatusWindow 原样抽取）。
 *
 * 内置能力（自原 StatusWindow.LogViewer 搬移）：搜索（Ctrl+F 聚焦、匹配计数、
 * 上/下条匹配跳转）、级别 chips（全部/警告/错误 + 计数）、折行切换、跟随底部
 * （滚到底 40px 内恢复；上滚/拖滚动条/翻页键暂停）、窗口化加载更早（350/页）、
 * Esc 关闭、打开时聚焦搜索框 + 关闭时焦点归还、`.log-fullscreen` 真全屏结构。
 *
 * v3 能力：
 *  - A-03 trace 合并 / E-02 到达动效 / 行号：行渲染自 V4-2 起收口到共享
 *    components/LogLineList（与状态页预览同一条渲染管线，本组件只保留
 *    容器职责：滚动、窗口化、过滤、跟随）。
 *  - 暂停跟随新行提示：跟随暂停期间有新行到达时，内容区顶部中央浮出
 *    「N 条新日志 ↓」胶囊（`.log-new-pill`），点击清空查询 + 跳底 + 恢复跟随。
 *
 * V4-2 新增 props：
 *  - navTools：顶栏标题右侧的导航工具位（历史查看器的「上一次/下一次执行」）；
 *  - onOpenFile：行内 hover「打开日志文件」入口的打开逻辑（warn/error 行浮现）。
 *
 * 历史页 / 应用页的差异（仅异常 chip、行号偏移、文件侧栏、自定义空态等）
 * 全部经 props 承接，交互与视觉与状态页完全一致。
 */

export type ViewerLogLevel = '' | 'warn' | 'error';
export type ViewerLevelFilter = 'all' | 'issues' | 'warn' | 'error';
export interface ViewerLine { id: number | string; text: string; level: ViewerLogLevel; }

const LOG_VIEWER_PAGE = 350;

export interface LogViewerProps {
  /** 顶栏标题节点（如 `运行日志 <small>N 行</small>`） */
  title: React.ReactNode;
  onClose: () => void;
  lines: ViewerLine[];
  /** 有值时显示错误行（保留重试钮位） */
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** 初始级别过滤；'issues'=所有非空级别（历史页「仅异常」） */
  initialLevelFilter?: ViewerLevelFilter;
  /** 'issues' chip 是否显示（历史页才传 true） */
  showIssuesChip?: boolean;
  /** 可选：日志文件侧栏节点；查看器只负责「日志文件」显隐开关按钮 */
  filesPanel?: React.ReactNode;
  /** 是否渲染「日志文件」开关钮（有 filesPanel 才显示） */
  showFilesButton?: boolean;
  /** 打开时文件侧栏是否直接展开（右栏「全部日志文件」入口用） */
  initialShowFiles?: boolean;
  /** 工具行追加控件（应用页「实时/已暂停」「全部重载」等） */
  extraTools?: React.ReactNode;
  /** 自定义空态（应用页「无 app.log」引导块）；缺省内置「等待日志输出...」 */
  emptyState?: React.ReactNode;
  /** 有行但筛选/搜索无结果的自定义空态；缺省内置 */
  emptyFilteredState?: React.ReactNode;
  /** buffered=行号=数据数组下标+1（状态/应用） */
  lineNumbers?: 'hidden' | 'buffered';
  /** 传入时行号 = lineNoOffset - lines.length + index + 1（历史页全局行号） */
  lineNoOffset?: number | null;
  /** 新行到达 2s 绿底淡出（E-02） */
  arriveAnimation?: boolean;
  /** 缓冲上限提示，如「更早记录请打开日志文件」 */
  bufferNote?: string;
  /** 顶栏导航工具位（历史查看器「上一次/下一次执行」切换） */
  navTools?: React.ReactNode;
  /** 行内「打开日志文件」入口（warn/error 行 hover 浮现）；缺省不渲染 */
  onOpenFile?: () => void;
  /** 行内入口的 title 文案（应用查看器为「打开部署目录」等） */
  onOpenFileTitle?: string;
  /** 工具行下方的轻量通知（应用查看器「打开目录失败」等瞬时反馈） */
  notice?: React.ReactNode;
}

export default function LogViewer({
  title,
  onClose,
  lines,
  loading = false,
  error = null,
  onRetry,
  initialLevelFilter = 'all',
  showIssuesChip = false,
  filesPanel,
  showFilesButton = true,
  initialShowFiles = false,
  extraTools,
  emptyState,
  emptyFilteredState,
  lineNumbers = 'buffered',
  lineNoOffset = null,
  arriveAnimation = false,
  bufferNote,
  navTools,
  onOpenFile,
  onOpenFileTitle,
  notice,
}: LogViewerProps) {
  const [query, setQuery] = useState('');
  const [levelFilter, setLevelFilter] = useState<ViewerLevelFilter>(initialLevelFilter);
  const [matchIdx, setMatchIdx] = useState(0);
  const [visibleCount, setVisibleCount] = useState(LOG_VIEWER_PAGE);
  const [following, setFollowing] = useState(true);
  const [wrapLines, setWrapLines] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [showFiles, setShowFiles] = useState(initialShowFiles === true);
  // 实时日志跟随：用户停在底部时新行自动滚底，向上翻看后不打断（与主日志区一致）
  const followRef = useRef(true);

  const q = query.trim().toLowerCase();
  const counts = useMemo(() => ({
    issues: lines.filter((line) => line.level !== '').length,
    error: lines.filter((line) => line.level === 'error').length,
    warn: lines.filter((line) => line.level === 'warn').length,
  }), [lines]);
  const filtered = useMemo(() => lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) =>
      levelFilter === 'all' ||
      (levelFilter === 'issues' ? line.level !== '' : line.level === levelFilter))
    .filter(({ line }) => !q || line.text.toLowerCase().includes(q)), [lines, levelFilter, q]);
  const matchedIndices = q ? filtered.map(({ i }) => i) : [];
  // 检索匹配可以很多，但只挂载当前结果附近的行；上下跳转仍覆盖全部匹配。
  const searchStart = q && filtered.length > LOG_VIEWER_PAGE
    ? Math.max(0, Math.min(matchIdx - 100, filtered.length - LOG_VIEWER_PAGE))
    : 0;
  const displayed = q
    ? filtered.slice(searchStart, searchStart + LOG_VIEWER_PAGE)
    : filtered.slice(-visibleCount);
  const hiddenCount = filtered.length - displayed.length;

  // ── 暂停跟随新行提示：跟随暂停期间逐行累计新到的行；恢复跟随（回到底部 /
  // 点击胶囊）即清零。用「上一次最后一行的 id」从尾部回扫计数，缓冲截断
  // （丢最旧行）时依然准确。
  const [newCount, setNewCount] = useState(0);
  const seenMarkerRef = useRef<{ lastId: string | number | null; len: number }>({ lastId: null, len: 0 });
  useEffect(() => {
    const prev = seenMarkerRef.current;
    let added = 0;
    if (prev.lastId !== null) {
      let i = lines.length - 1;
      while (i >= 0 && lines[i].id !== prev.lastId) i--;
      added = lines.length - 1 - i; // 找不到（缓冲截断过半）时按整窗新行兜底
    } else {
      added = Math.max(0, lines.length - prev.len);
    }
    seenMarkerRef.current = { lastId: lines.length ? lines[lines.length - 1].id : null, len: lines.length };
    if (followRef.current) {
      setNewCount(0);
      return;
    }
    if (added > 0) setNewCount((count) => count + added);
  }, [lines]);

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
  }, [lines, q, levelFilter, visibleCount]);

  function handleViewerScroll() {
    const el = containerRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) {
      const resumed = !followRef.current;
      followRef.current = true;
      setFollowing(true);
      // 手动滚回底部恢复跟随：未读胶囊即时清零（不必等下一行日志触发 effect）
      if (resumed) setNewCount(0);
    }
  }

  function jumpToLatest() {
    setQuery('');
    setVisibleCount(LOG_VIEWER_PAGE);
    followRef.current = true;
    setFollowing(true);
    setNewCount(0);
    requestAnimationFrame(() => {
      if (containerRef.current) containerRef.current.scrollTop = containerRef.current.scrollHeight;
    });
  }

  // Esc 关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // 焦点管理：打开即聚焦搜索框（Ctrl+F 的常驻版）；卸载时把焦点还给
  // 触发按钮，避免焦点留在被浮层盖住的背景控件上（与历史页查看器同口径）。
  const returnFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => { returnFocusRef.current?.focus(); };
  }, []);

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

  // 级别 chips：全部/警告/错误为内置（计数由 lines 派生）；'issues' 由
  // showIssuesChip 控制是否插入（历史页「仅异常」）。
  const levelChips: Array<[ViewerLevelFilter, string, number]> = [['all', t('logviewer.levelAll'), lines.length]];
  if (showIssuesChip) levelChips.push(['issues', t('logviewer.levelIssues'), counts.issues]);
  levelChips.push(['warn', t('logviewer.levelWarn'), counts.warn], ['error', t('logviewer.levelError'), counts.error]);

  return (
    <div className="log-fullscreen">
      {/* 顶栏 */}
      <div className="log-fs-bar">
        <span className="log-fs-title">{title}</span>

        {navTools && <div className="log-fs-navtools">{navTools}</div>}

        <div className="log-fs-search">
          <span className="log-fs-search-icon"><Icon name="search" /></span>
          <input
            ref={inputRef}
            className="log-fs-input"
            type="search"
            aria-label={t('logviewer.searchAria')}
            placeholder={t('logviewer.searchPlaceholder')}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setMatchIdx(0); }}
          />
          {q && (
            <span className="log-fs-count">
              {totalMatches ? `${safeMatchIdx + 1} / ${totalMatches}` : t('logviewer.noResult')}
            </span>
          )}
          {q && totalMatches > 0 && (
            <>
              <button className="log-fs-nav" aria-label={t('logviewer.prevMatch')} onClick={() => setMatchIdx((p) => Math.max(0, p - 1))}><Icon name="arrow-up" /></button>
              <button className="log-fs-nav" aria-label={t('logviewer.nextMatch')} onClick={() => setMatchIdx((p) => Math.min(totalMatches - 1, p + 1))}><Icon name="arrow-down" /></button>
            </>
          )}
        </div>

        <div className="log-fs-actions">
          {filesPanel && showFilesButton && (
            <button className="btn btn-sm" onClick={() => setShowFiles((v) => !v)}>
              <Icon name="folder" /> {t('logviewer.files')}
            </button>
          )}
          <button className="btn btn-sm" onClick={onClose}><Icon name="close" /> {t('ui.close')}</button>
        </div>
      </div>
      <div className="log-fs-tools">
        <div className="log-level-filters" role="group" aria-label={t('logviewer.levelFilterAria')}>
          {levelChips.map(([value, label, count]) => (
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
            ? (filtered.length > displayed.length
              ? t('logviewer.matchSummaryRanged', filtered.length, searchStart + 1, searchStart + displayed.length)
              : t('logviewer.matchSummary', filtered.length))
            : t('logviewer.showSummary', displayed.length, filtered.length)}
          {bufferNote ? ` · ${bufferNote}` : ''}
        </span>
        <button className="btn btn-sm" aria-pressed={wrapLines} onClick={() => setWrapLines((value) => !value)}>{wrapLines ? t('logviewer.unwrap') : t('logviewer.wrap')}</button>
        <button className="btn btn-sm" onClick={jumpToLatest}>{following && !q ? t('logviewer.following') : t('logviewer.jumpLatest')}</button>
        {extraTools}
      </div>
      {notice && <div className="log-fs-notice" role="status">{notice}</div>}

      {/* 主体：日志 + 可选文件面板 */}
      <div className="log-fs-body">
        {/* 包裹层承载浮出的「新日志」胶囊（定位锚点，不随内容滚动） */}
        <div className="log-fs-content-wrap">
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
            {error && (
              <div className="log-error" role="alert">
                <Icon name="warning" className="icon-xs" />
                <span className="log-error-text">{error}</span>
                {onRetry && <button className="btn btn-sm" onClick={onRetry}>{t('ui.retry')}</button>}
              </div>
            )}
            {hiddenCount > 0 && !q && (
              <button className="log-load-older" onClick={() => { followRef.current = false; setFollowing(false); setVisibleCount((n) => n + LOG_VIEWER_PAGE); }}>
                {t('logviewer.loadOlder', hiddenCount)}
              </button>
            )}
            {/* 行渲染收口到共享 LogLineList（V4-2：与状态页预览同一条管线） */}
            <LogLineList
              lines={lines}
              displayed={displayed}
              query={q}
              currentIdx={q && matchedIndices.length ? matchedIndices[safeMatchIdx] : null}
              lineNumbers={lineNumbers}
              lineNoOffset={lineNoOffset}
              arriveAnimation={arriveAnimation}
              onOpenFile={onOpenFile}
              onOpenFileTitle={onOpenFileTitle}
            />
            {lines.length === 0 && !error && (
              loading
                ? <span className="log-empty"><Icon name="terminal" className="icon-xs" />{t('logviewer.loadingLogs')}</span>
                : (emptyState ?? <span className="log-empty"><Icon name="terminal" className="icon-xs" />{t('logviewer.waiting')}</span>)
            )}
            {filtered.length === 0 && lines.length > 0 && (
              emptyFilteredState ?? (
                <span className="log-empty"><Icon name="search" className="icon-xs" />{q ? t('logviewer.noMatch') : t('logviewer.levelEmpty')}</span>
              )
            )}
          </div>
          {/* 跟随暂停期间有新行到达：顶部中央胶囊，点击回底并恢复跟随 */}
          {newCount > 0 && !following && (
            <button className="log-new-pill" onClick={jumpToLatest}>{t('logviewer.newPill', newCount)}</button>
          )}
        </div>

        {/* 日志文件侧栏（节点由调用方注入，状态页 = LogFilesPanel） */}
        {showFiles && filesPanel}
      </div>
    </div>
  );
}
