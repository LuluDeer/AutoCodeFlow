import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../components/Icon';
import PageHeader from '../components/PageHeader';
import ConfirmBar from '../components/ConfirmBar';
import EmptyState from '../components/EmptyState';
import LogViewer, { ViewerLogLevel } from '../components/LogViewer';
import { TAB_SWITCH_EVENT, requestTabSwitch } from '../tab-switch';
// P3-2：IPC reject 错误消息剥 Electron 包装前缀（用户可读化）。
import { ipcErrorMessage } from '../ipc-error';
// P2-1：增量日志读取响应分类（missing/error 标记 → 错误态而非清空缓冲）。
import { classifyLogRead, MISSING_AFTER_START_MESSAGE } from '../log-read-classify';
// V4 后续优化（6）i18n 二期：历史页文案入双语表（zh 值与原硬编码逐字一致）。
import { createCfgTexts, formatLocaleDateTime, resolveRendererLocale } from '../i18n';

const t = createCfgTexts(resolveRendererLocale(() => navigator.language));

declare const window: Window & {
  electronAPI: {
    getHistory: () => Promise<ExecRecord[]>;
    // F-26：canceled = R105 主进程原生二次确认被用户取消（非失败）。
    clearHistory: () => Promise<{ ok: boolean; canceled?: boolean }>;
    // F-22：truncated = 主进程首读走了尾窗（lines 只是文件尾部窗口）。
    readLog: (executionId: string, fromLine?: number) => Promise<{ lines: string[]; totalLines: number; truncated?: boolean }>;
    writeClipboardText: (text: string) => Promise<{ ok: boolean; error?: string }>;
    revealExecLog: (executionId: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
    openTaskLogFolder: () => Promise<{ ok: boolean; path?: string; error?: string }>;
    // 拓展包：导出某次执行的日志文件（主进程 copyFile 到用户选择的路径）。
    exportExecLog: (executionId: string) => Promise<{
      ok: boolean; canceled?: boolean; path?: string; tooLarge?: boolean; error?: string;
    }>;
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

// UI V5（2026-10-27）：历史页改为「执行台账」——单列按时间倒序，任务只是
// 筛选维度；分页以执行条数为单位（初始 40 条，之后每次 40 条）。
const INITIAL_VISIBLE_RUNS = 40;
const RUN_PAGE_SIZE = 40;
// B-05 后半（2026-10 审计）：running 超过该时长仍无终态 → 疑似僵死
const STALE_RUNNING_MS = 6 * 60 * 60 * 1000;
// ≥1400px 详情面板常驻右侧；更窄时同一节点切换为右侧抽屉。
const DETAIL_NARROW_QUERY = '(max-width: 1399px)';

/**
 * 列表里一次执行的开始时间缺省值。
 *
 * meta 记录理论上都带 startTime，但早期/异常中断写入的记录可能缺字段——
 * 排序与展示都要有确定行为，不能让 undefined 参与比较（NaN 排序会让整条
 * 台账顺序随机抖动，且刷新一次变一次）。
 */
function startOf(r: ExecRecord): number {
  return typeof r.startTime === 'number' && Number.isFinite(r.startTime) ? r.startTime : 0;
}

// ── B-04（2026-10 审计）：历史列表的时间维度 ──────────────────────────
/** 日期分桶标签，下标即桶序（按时间从新到旧单调；V4 后续优化（6）入双语表）。 */
const DATE_BUCKET_LABELS = [
  t('history.bucket.today'),
  t('history.bucket.yesterday'),
  t('history.bucket.week'),
  t('history.bucket.earlier'),
] as const;

/**
 * 一次执行所属的日期桶（本地时区自然日）：今天=d0、昨天=d1、近 7 天=d2、
 * 其余为更早。startTime 缺失（startOf 归 0）无法判定 → 归「更早」，记录本身
 * 仍可见，只是不享受时间定位。
 * 用「本地零点差 ÷ 一天」取整而不是直接减 86_400_000：DST 切换日自然日
 * 只有 23/25 小时，直接相减会把桶边界附近的记录错分进相邻桶。
 */
function dateBucketOf(latestStart: number, nowMs: number): number {
  if (!latestStart) return 3;
  const startOfDay = (ms: number) => {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const dayDiff = Math.round((startOfDay(nowMs) - startOfDay(latestStart)) / 86_400_000);
  if (dayDiff <= 0) return 0;
  if (dayDiff === 1) return 1;
  if (dayDiff <= 6) return 2;
  return 3;
}

function formatDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  // 跨小时任务显示成「345m 0s」不可读（2026-10 审计）：≥1h 切换 h/m 档位
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function formatTime(ts?: number): string {
  if (!ts || !Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  return formatLocaleDateTime(d, {
    ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function statusBadge(status?: string) {
  // A-04（2026-10 审计）：「运行中」一词三色——历史徽章此前用 pending 黄，
  // 与「等待/启动中」语义冲突；统一状态色映射后运行中=蓝（badge-blue，
  // 由状态色收口项在 components.css 新增）。
  const map: Record<string, string> = {
    success: 'badge-success', failed: 'badge-error', running: 'badge-blue',
  };
  const labels: Record<string, string> = {
    success: t('history.status.success'),
    failed: t('history.status.failed'),
    running: t('history.status.running'),
  };
  const cls = map[status || ''] || 'badge-offline';
  return <span className={`badge ${cls}`}>{labels[status || ''] || t('history.status.unknown')}</span>;
}

/** 台账行内的状态点（色彩只落在 8px 圆点上，不再满屏彩色徽章）。 */
function statusTone(status?: string): string {
  if (status === 'success') return 'is-success';
  if (status === 'failed') return 'is-failed';
  if (status === 'running') return 'is-running';
  return 'is-unknown';
}

function statusText(status?: string): string {
  if (status === 'success') return t('history.status.success');
  if (status === 'failed') return t('history.status.failed');
  if (status === 'running') return t('history.status.running');
  return t('history.status.unknown');
}

/** 任务的稳定键：任务名优先（任务筛选按名称收口），缺失时退回 taskId/执行 ID。 */
function taskKeyOf(r: ExecRecord): string {
  return r.taskName || r.taskId || r.executionId;
}

function taskLabelOf(r: ExecRecord): string {
  return r.taskName || t('historyx.taskFilter.unnamed');
}

/** 行的时长文案：终态算差值，running 显示「已运行 X」，其余 —。 */
function runDurationText(run: ExecRecord): string {
  if (run.endTime !== undefined) return formatDuration(run.endTime - run.startTime);
  if (run.status === 'running' && startOf(run) > 0) {
    return t('history.run.runningFor', formatDuration(Date.now() - startOf(run)));
  }
  return '—';
}

// 执行 ID（executionId）在台账行内不再展示（行宽最贵的位置留给任务名与
// 排障动作）；完整值 + 复制入口收进详情面板。
function CopyExecIdButton({ id }: { id: string }) {
  // idle/copied/error 三态：点击复制 + 短暂反馈（桌面端无 toast 体系）。
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle');
  // P3-3：preload 对超 1MiB 内容诚实回 error:'tooLarge'——失败原因要区分
  // 「内容过大」与一般失败，假「已复制」比失败更伤信任。
  const [tooLarge, setTooLarge] = useState(false);
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 1500);
    return () => clearTimeout(timer);
  }, [state]);
  function copy() {
    window.electronAPI
      .writeClipboardText(id)
      .then((r) => {
        if (r?.ok === false) {
          setTooLarge(r?.error === 'tooLarge');
          setState('error');
        } else {
          setState('copied');
        }
      })
      .catch(() => { setTooLarge(false); setState('error'); });
  }
  return (
    <button
      type="button"
      className={`btn btn-sm historyx-copy${state === 'copied' ? ' is-copied' : state === 'error' ? ' is-error' : ''}`}
      onClick={copy}
      title={state === 'error' ? (tooLarge ? t('status.copyTooLarge') : t('status.copyFailed')) : t('history.execIdTitle', id)}
      aria-label={t('historyx.detail.copyId')}
    >
      <Icon name={state === 'copied' ? 'check' : state === 'error' ? 'warning' : 'copy'} />
      {state === 'copied'
        ? t('status.copied')
        : state === 'error'
          ? (tooLarge ? t('status.copyTooLarge') : t('status.copyFailed'))
          : t('historyx.detail.copyId')}
    </button>
  );
}

// ────────────────────────────────────────────────────────────
// 实时日志查看器（日志工作台 v3 第二步：改接共享 components/LogViewer）
// ────────────────────────────────────────────────────────────

/** 关键词分级（与 AppsPage 同口径）：error/warn/空 —— 映射为共享查看器的行级别。 */
function classifyLog(line: string): ViewerLogLevel {
  const l = line.toLowerCase();
  if (l.includes('error') || l.includes('failed') || l.includes('err ')) return 'error';
  if (l.includes('warn')) return 'warn';
  return '';
}

/**
 * 单次执行的日志查看器。
 *
 * UI 全部由共享 components/LogViewer 承接（真全屏 .log-fullscreen；搜索 +
 * Ctrl+F、级别 chips（「异常」chip 承接原「仅异常」）、折行、跟随底部/
 * 查看最新、窗口化加载更早、Esc 关闭 + 焦点归还均为组件内置），历史页的
 * 差异（仅异常 chip、全局行号偏移、自定义空态）全部经 props 承接。本组件
 * 只保留页面侧的数据链路，viewer 只接 lines/loading/error/onRetry：
 *  - 增量拉取 readLog(executionId, linesRef.current) + 1.5s（running）/
 *    5s（终态）轮询；
 *  - NETOPT-7⑥（2026-09-20）：读取失败的页内呈现 + 终止无限轮询。原实现
 *    fetchLog 无 catch：任一次 readLog reject（日志文件被 TTL 清理/IPC 异常）
 *    → setLoading(false) 不执行 → 永久「加载日志...」，且 1.5s/5s 轮询持续
 *    重抛 unhandled rejection。同仓 AppsPage.tsx 的 AppLogViewer 对同一 IPC
 *    形态有 try/catch + error 态，照此对齐。
 *  - reloadKey 原位重试：失败时轮询已被终止（NETOPT-7⑥），置 reloadKey
 *    递增即重建整条拉取链（effect 负责清空旧行、重挂 interval），与
 *    AppsPage 查看器「可点『实时』重试」的失败恢复口径对齐，不必关闭重开。
 */
function ExecutionLogOverlay({ record, onClose, nav, onRevealLog }: {
  record: ExecRecord;
  onClose: () => void;
  /** V4-2（X-03）：同任务邻次执行的切换工具（顶栏「上一次/下一次」） */
  nav?: { index: number; count: number; onPrev: () => void; onNext: () => void };
  /** 行内「打开日志文件」入口的打开逻辑（warn/error 行 hover 浮现） */
  onRevealLog?: () => void;
}) {
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // F-22：首读截断口径（主进程尾窗分支返回 true）——汇总行据此切换为
  // 「已截断：仅显示最后 N 行 · 文件共 M 行」的如实降级显示。
  const [truncated, setTruncated] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const linesRef = useRef(0);
  const inFlight = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // NETOPT-7⑥ 的轮询停止标记：fetchLog 失败后置位，轮询与隐藏门控的补拉
  // kick 一并静默；「重试」（reloadKey）重建拉取链时复位。
  const pollStoppedRef = useRef(false);

  const fetchLog = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await window.electronAPI.readLog(record.executionId, linesRef.current);
      // P2-1：主进程对「文件不存在 / 读取失败」返回 missing/error 标记（不再
      // 是成功形态空结果）。分类点在 log-read-classify.ts：
      //   · error        → 错误态（NETOPT-7⑥ 口径），已有缓冲保留；
      //   · missing 且已有缓冲 → 「日志已消失」错误态，缓冲保留（用户还能
      //     看到消失前的内容），停止轮询；
      //   · missing 且首读 → 合法空态（执行尚未产生日志），不报错；
      //   · totalLines 回退且未报 missing → 真轮转，沿用整体换新文件尾部。
      const previousTotal = linesRef.current;
      const verdict = classifyLogRead(res, previousTotal);
      if (verdict.kind === 'error') {
        setError(verdict.message || MISSING_AFTER_START_MESSAGE);
        pollStoppedRef.current = true;
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        return;
      }
      if (verdict.kind === 'missing') {
        // 首读即 missing：合法空态（无日志可读），不报错。
        setError(null);
        return;
      }
      setError(null);
      linesRef.current = verdict.totalLines;
      if (verdict.kind === 'shrink') {
        // 日志轮转或截断后，旧行不能继续混在新文件的内容里。
        setLines(verdict.lines.slice(-1500));
        setTruncated(false);
      } else if (verdict.lines.length > 0) {
        setLines(prev => {
          const next = [...prev, ...verdict.lines];
          return next.length > 1500 ? next.slice(-1500) : next;
        });
      }
      // F-22：截断口径只在首读/刷新（主进程尾窗分支）的响应上出现；增量
      // 响应不带该字段（undefined）→ 保持现状，不因后续追加而丢标记。
      if (verdict.truncated) setTruncated(true);
    } catch (err) {
      setError(ipcErrorMessage(err));
      // 终止轮询：文件已被 TTL 清理/通道异常时，1.5s/5s 重试只会反复失败。
      // 置停止标记（隐藏门控的补拉 kick 同样被拦），用户点「重试」
      // （reloadKey）即重新拉取。
      pollStoppedRef.current = true;
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, [record.executionId]);

  // 初始加载 / 原位重试：整链重建（旧行清空、水位归零、恢复轮询资格）。
  // P3-11：依赖去掉 record.status——状态翻转（running→终态）此前会整链重建
  // （setLines([]) + 水位归零 + 从头尾窗重拉），查看器闪空、滚动位置丢失。
  // 状态只影响轮询间隔，轮询 effect（下方）已单独依赖 record.status；
  // executionId 变化时组件本就以 key=executionId 重挂。
  useEffect(() => {
    linesRef.current = 0;
    pollStoppedRef.current = false;
    setLines([]);
    setLoading(true);
    fetchLog();
  }, [record.executionId, fetchLog, reloadKey]);

  // poll every 1.5s while running, every 5s otherwise —— 隐藏页轮询门控：
  // Tab 常驻挂载（App.tsx），历史 Tab 隐藏/窗口最小化时查看器仍在后台拉增量。
  // 沿用仓内 AppsPage.tsx 列表轮询的 active() + MutationObserver 门控
  // （panel.hidden + visibilitychange）：隐藏期间暂停，恢复可见立即补拉一次
  // （增量 fromLine 语义不变，隐藏期间的行一次性并入）。
  useEffect(() => {
    const panel = document.getElementById('history-panel');
    const active = () => !document.hidden && !panel?.hidden;
    const poll = () => { if (active() && !pollStoppedRef.current) fetchLog(); };
    const interval = record.status === 'running' ? 1500 : 5000;
    timerRef.current = setInterval(poll, interval);
    const observer = panel ? new MutationObserver(poll) : null;
    if (panel) observer?.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    document.addEventListener('visibilitychange', poll);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      observer?.disconnect();
      document.removeEventListener('visibilitychange', poll);
    };
  }, [record.executionId, record.status, fetchLog, reloadKey]);

  // 行级别在数据侧判定一次，渲染层（共享查看器）只按 level 过滤/着色。
  // F-24（UIUX 审计）：行 id 用**文件全局行号**（与 AppsPage 查看器同款），
  // 不再用缓冲数组下标——缓冲超 1500 行后每次追加都触发 slice(-1500)，全部
  // 既有行的下标整体平移 → id 全变，下游两个按 id 判「新行」的机制全部失真
  // （LogLineList 到达动效整窗误闪、LogViewer「N 条新日志」胶囊一次性 +~1500）。
  // 缓冲首行的全局行号 = linesRef.current（文件总行数）- lines.length；轮转
  // 分支的整窗替换也满足该式（新文件尾部重新编号）。linesRef 在 fetchLog 里
  // 先于 setLines 更新，memo 随 lines 变化重算时两者必然同帧一致。
  const viewerLines = useMemo(
    () => lines.map((text, index) => ({
      id: linesRef.current - lines.length + index,
      text,
      level: classifyLog(text),
    })),
    [lines],
  );

  // ── 拓展包：查看器「导出日志」───────────────────────────────────────
  // 主进程把该次执行的日志文件 copyFile 到用户选择的路径（原文件不动）；
  // 大文件返回 tooLarge（error 文案已含"打开日志文件夹手动复制"的出路）。
  // 结果经共享查看器的 notice 行呈现（6s 自动消退，与列表页 notice 同口径）。
  const [exportState, setExportState] = useState<'idle' | 'busy'>('idle');
  const [exportMsg, setExportMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  useEffect(() => {
    if (!exportMsg) return;
    const timer = setTimeout(() => setExportMsg(null), 6000);
    return () => clearTimeout(timer);
  }, [exportMsg]);

  async function handleExportLog() {
    if (exportState === 'busy') return;
    setExportState('busy');
    try {
      const res = await window.electronAPI.exportExecLog(record.executionId);
      if (res.canceled) return;
      if (res.ok === true && res.path) {
        setExportMsg({ kind: 'ok', text: t('history.exportLogDone', res.path) });
      } else {
        setExportMsg({ kind: 'err', text: t('history.exportLogFail', res.error ?? '') });
      }
    } catch (err) {
      setExportMsg({ kind: 'err', text: ipcErrorMessage(err) });
    } finally {
      setExportState('idle');
    }
  }

  return (
    <LogViewer
      title={(
        <>
          <span title={record.taskName}>{record.taskName}</span>
          {' '}
          <span className="log-fs-deployment-id" title={record.executionId}>{record.executionId}</span>
          {' '}
          {statusBadge(record.status)}
        </>
      )}
      lines={viewerLines}
      onClose={onClose}
      loading={loading}
      error={error ? t('history.overlay.loadFail', error) : null}
      onRetry={() => setReloadKey((k) => k + 1)}
      // running 轮询有到达感：新行 2s 绿底淡出（M-01 补齐，三查看器口径一致）
      arriveAnimation
      onOpenFile={onRevealLog}
      // 拓展包：工具行「导出日志」+ 结果 notice（共享查看器的轻量通知位）
      extraTools={
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void handleExportLog()}
          disabled={exportState === 'busy'}
          title={t('history.exportLogTitle')}
        ><Icon name="download" /> {t('history.exportLog')}</button>
      }
      notice={exportMsg ? (
        <span
          className={exportMsg.kind === 'ok' ? 'is-ok' : undefined}
          role={exportMsg.kind === 'ok' ? 'status' : 'alert'}
        >
          {exportMsg.kind === 'ok' ? <Icon name="check" className="icon-xs" /> : <Icon name="warning" className="icon-xs" />}
          {' '}
          {exportMsg.text}
        </span>
      ) : undefined}
      navTools={nav && nav.count > 1 ? (
        <>
          <button
            type="button"
            className="btn btn-sm"
            disabled={nav.index <= 0}
            onClick={nav.onPrev}
            title={t('history.overlay.prevRun')}
            aria-label={t('history.overlay.prevRun')}
          ><Icon name="chevron-right" className="icon-xs icon-flip-h" /></button>
          <span className="log-fs-navpos">{nav.index + 1} / {nav.count}</span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={nav.index >= nav.count - 1}
            onClick={nav.onNext}
            title={t('history.overlay.nextRun')}
            aria-label={t('history.overlay.nextRun')}
          ><Icon name="chevron-right" className="icon-xs" /></button>
        </>
      ) : undefined}
      showIssuesChip
      // 全局行号：缓冲截断后行号仍=文件内绝对行号
      // （lineNoOffset - lines.length + index + 1，组件内置语义）。
      lineNoOffset={linesRef.current}
      // 汇总行三条数字并排：组件内置「显示 x / y 行」，这里追加已载入/文件共；
      // F-22：首读被主进程尾窗截断时如实降级——不再暗示缓冲外的内容都已载入。
      bufferNote={lines.length > 0
        ? truncated
          ? t('history.overlay.truncatedNote', lines.length, linesRef.current)
          : t('history.overlay.bufferNote', lines.length, linesRef.current)
        : undefined}
      emptyState={<span className="log-empty"><Icon name="terminal" className="icon-xs" />{t('history.overlay.empty')}</span>}
      emptyFilteredState={<span className="log-empty"><Icon name="search" className="icon-xs" />{t('history.overlay.emptyFiltered')}</span>}
    />
  );
}

// ────────────────────────────────────────────────────────────
// 主页面：执行台账 + 详情面板
// ────────────────────────────────────────────────────────────
export default function HistoryPage({ active }: { active: boolean }) {
  const [records, setRecords] = useState<ExecRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewingLog, setViewingLog] = useState<ExecRecord | null>(null);
  // D 修正：原实现 catch 静默返回空列表——IPC 失败会显示成「暂无执行记录」，
  // 用户无法区分「真的没跑过任务」与「读取失败」。
  const [error, setError] = useState<string | null>(null);
  // D 修正：原用 window.confirm()。Electron 无边框窗口下原生 confirm 会阻塞
  // 渲染进程且样式不可控（部分平台直接不显示），改用页内确认态。
  const [confirmingClear, setConfirmingClear] = useState(false);
  // 行内操作反馈（定位日志失败等）——静默失败会让用户以为按钮坏了。
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // ── 过滤 / 搜索（沿用既有能力，任务筛选改为台账的一个维度）──
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'success' | 'failed' | 'running'>('all');
  const [taskFilter, setTaskFilter] = useState('');
  // 台账分页：初始 40 条；筛选变化时归零（见下方 effect）。
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_RUNS);
  // 选中执行 → 详情面板/抽屉。null = 未选中。
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterBarHeight, setFilterBarHeight] = useState(58);
  const [isNarrow, setIsNarrow] = useState(() => window.matchMedia(DETAIL_NARROW_QUERY).matches);
  const [exportingId, setExportingId] = useState<string | null>(null);

  // V4-4（X-05）：列表页搜索快捷键——查看器有 Ctrl+F，列表页同键不同域；
  // 查看器打开时让位（viewingLog 守卫），键盘动线两态不打架。
  const searchRef = useRef<HTMLInputElement>(null);
  // P3-8：load 的在飞标记（useCallback 内引用，需先于其定义声明）。
  const loadInFlight = useRef(false);
  // 筛选行高度参与日期头/详情面板的 sticky 偏移（窄窗换行时也保持贴合）。
  const filtersRef = useRef<HTMLDivElement>(null);
  // 详情面板/抽屉与焦点归还。
  const detailRef = useRef<HTMLElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const lastRowRef = useRef<HTMLElement | null>(null);
  const prevSelectedRef = useRef<string | null>(null);
  // 首次加载自动选中最近一条执行（保留历史变量名，语义由「自动展开首组」变为
  // 「自动选中最近一条」——台账没有组可展开）。
  const autoExpanded = useRef(false);

  // 操作反馈 6s 后自动消失。
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  /** 在文件管理器中定位某次执行的日志文件。 */
  async function handleRevealLog(executionId: string) {
    try {
      const res = await window.electronAPI.revealExecLog(executionId);
      if (!res.ok) setNotice({ kind: 'err', text: res.error ?? t('history.notice.revealFail') });
    } catch (err) {
      setNotice({ kind: 'err', text: ipcErrorMessage(err) });
    }
  }

  /** 打开任务日志所在目录（一次看当天所有执行）。 */
  async function handleOpenLogFolder() {
    try {
      const res = await window.electronAPI.openTaskLogFolder();
      if (!res.ok) setNotice({ kind: 'err', text: res.error ?? t('history.notice.folderFail') });
    } catch (err) {
      setNotice({ kind: 'err', text: ipcErrorMessage(err) });
    }
  }

  /** 详情面板的「导出日志」——与查看器内同一条 IPC，这里结果落页面 notice。 */
  async function handleExportSelectedLog(executionId: string) {
    if (exportingId) return;
    setExportingId(executionId);
    try {
      const res = await window.electronAPI.exportExecLog(executionId);
      if (res.canceled) return;
      if (res.ok === true && res.path) {
        setNotice({ kind: 'ok', text: t('history.exportLogDone', res.path) });
      } else {
        setNotice({ kind: 'err', text: t('history.exportLogFail', res.error ?? '') });
      }
    } catch (err) {
      setNotice({ kind: 'err', text: ipcErrorMessage(err) });
    } finally {
      setExportingId(null);
    }
  }

  const load = useCallback(async (background: boolean = false) => {
    // P3-8：in-flight 去重——60s 兜底轮询、history:changed 推送、
    // visibilitychange/MutationObserver kick 可能相邻触发；后完成者覆盖先
    // 完成者会让列表短暂回退旧数据（乱序竞态）。对齐 StatusWindow agent
    // 轮询的 inFlight 守卫先例：在飞时丢弃本次触发（下一次兜底轮询会补上）。
    if (loadInFlight.current) return;
    // 后台轮询不切 loading：空列表下每 5s 闪烁「加载中...」会掩盖空态。
    if (!background) setLoading(true);
    loadInFlight.current = true;
    try {
      const api = (window as any).electronAPI;
      if (typeof api?.getHistory !== 'function') {
        setError(t('history.unsupported'));
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
      setError(ipcErrorMessage(err));
    } finally {
      if (!background) setLoading(false);
      loadInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void load(false);
    // getHistory 推送化（战役遗留 #4）：主进程 meta 目录变更哨广播
    // history:changed → 后台刷新一次（10s 轮询退役）。推送事件本身低频且已
    // debounce，隐藏页也刷——保持数据新鲜；60s 低频兜底仅在可见时跑（fs.watch
    // 失灵的最后一张网，对齐推送前的 document.hidden 门控）。旧 preload 缺
    // 通道时整体退化为纯兜底轮询（typeof 守卫，EXP-09 口径）。
    const electronAPI = (window as any).electronAPI;
    const offChanged =
      typeof electronAPI?.onHistoryChanged === 'function'
        ? electronAPI.onHistoryChanged(() => { void load(true); })
        : null;
    const timer = setInterval(() => { if (!document.hidden) void load(true); }, 60_000);
    return () => { clearInterval(timer); offChanged?.(); };
  }, [active, load]);

  // V4-4（X-05）：Ctrl+F 聚焦搜索框（查看器打开时归查看器的同键处理）
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key !== 'f') return;
      if (viewingLog) return;
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [active, viewingLog]);

  // V4 后续优化（2）：状态页「最近失败」等入口请求切历史页时附带状态过滤——
  // 与 App 的切页监听共用同一事件流，对象形态 detail 在此消费过滤字段。
  useEffect(() => {
    const onSwitch = (e: Event) => {
      const raw: unknown = (e as CustomEvent).detail;
      if (raw && typeof raw === 'object' && (raw as { tab?: unknown }).tab === 'history') {
        const f = (raw as { historyStatusFilter?: unknown }).historyStatusFilter;
        if (f === 'success' || f === 'failed' || f === 'running') {
          setStatusFilter(f);
        }
      }
    };
    window.addEventListener(TAB_SWITCH_EVENT, onSwitch);
    return () => window.removeEventListener(TAB_SWITCH_EVENT, onSwitch);
  }, []);

  async function handleClear() {
    try {
      const result = await window.electronAPI.clearHistory();
      // F-26（R105）：主进程原生二次确认被取消时回 {ok:false, canceled:true}
      // ——用户点了「取消」，不是失败：静默收起确认条返回（finally），
      // 不进顶部 error 条（原先的 throw 会把「取消」呈现成「清除失败」红条）。
      if (!result.ok && result.canceled) return;
      if (!result.ok) throw new Error(t('history.notice.clearFail'));
      setRecords([]);
      setSelectedId(null);
      setError(null);
      autoExpanded.current = false;
      setNotice({ kind: 'ok', text: t('history.notice.cleared') });
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setConfirmingClear(false);
    }
  }

  // V4 后续优化（4）：搜索过滤走 useDeferredValue——输入保持即时响应，
  // 全量过滤在低优先级渲染里追平（千条记录量级打字不掉帧）。
  const deferredQuery = useDeferredValue(query);
  const q = deferredQuery.trim().toLowerCase();

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

  // 任务维度的下拉选项（全量记录，不随当前任务筛选收缩——否则选中后
  // 选项里只剩自己，无法切回其它任务）。
  const taskOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const rec of records) {
      const key = taskKeyOf(rec);
      if (!seen.has(key)) seen.set(key, taskLabelOf(rec));
    }
    return Array.from(seen.entries(), ([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [records]);

  // 任务从记录中消失（清理/轮转）时不要让 select 停在无对应 option 的空值上。
  useEffect(() => {
    if (taskFilter && !taskOptions.some((option) => option.value === taskFilter)) {
      setTaskFilter('');
    }
  }, [taskFilter, taskOptions]);

  // 过滤后的失败数（保留「基于过滤后集合」的统计口径）。
  const failedVisible = useMemo(() => {
    let count = 0;
    for (const rec of filtered) {
      if (rec.status === 'failed') count += 1;
    }
    return count;
  }, [filtered]);

  // 台账：状态/搜索过滤 → 任务过滤 → 按开始时间倒序（单列，时间即骨架）。
  const ledger = useMemo(() => {
    const rows: ExecRecord[] = [];
    for (const rec of filtered) {
      if (taskFilter && taskKeyOf(rec) !== taskFilter) continue;
      rows.push(rec);
    }
    rows.sort((a, b) => startOf(b) - startOf(a));
    return rows;
  }, [filtered, taskFilter]);

  // 全量记录按时间倒序：用于首次加载自动选中最近一条（不自动展开任何组，
  // 台账没有组可展开；autoExpanded 的语义随之变为「自动选中」）。
  const allSorted = useMemo(() => {
    const rows = records.slice();
    rows.sort((a, b) => startOf(b) - startOf(a));
    return rows;
  }, [records]);

  const visibleRows = ledger.slice(0, visibleCount);

  // P3-12②：分页重置挂到**提交态**（deferredQuery）而非每次键入——连续输入
  // 时列表不会反复跳回顶部；筛选/任务变化同样归零。
  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE_RUNS);
  }, [deferredQuery, statusFilter, taskFilter]);

  // 首次数据到达后自动选中最近一条执行（用户手动选择过则不再干预）。
  // 窄窗（<1400）详情是覆盖式抽屉：自动打开会把列表半遮住，改为不自动
  // 选中，等用户点行再打开。宽屏是并排面板，自动选中不遮挡列表。
  useEffect(() => {
    if (autoExpanded.current || allSorted.length === 0) return;
    if (isNarrow) return;
    autoExpanded.current = true;
    setSelectedId((current) => current ?? allSorted[0].executionId);
  }, [allSorted, isNarrow]);

  // 选中目标被清除（清除全部/重新加载后记录消失）时收起详情。
  useEffect(() => {
    if (selectedId && records.length > 0 && !records.some((r) => r.executionId === selectedId)) {
      setSelectedId(null);
    }
  }, [records, selectedId]);

  // 选中后详情的焦点/滚动：新选中 → 面板滚回顶部；窄窗首次打开聚焦关闭钮。
  useEffect(() => {
    if (!selectedId) {
      prevSelectedRef.current = null;
      return;
    }
    const newlyOpened = prevSelectedRef.current === null;
    prevSelectedRef.current = selectedId;
    // 面板本体是 overflow:hidden，真正滚动的是内部 body。
    detailRef.current
      ?.querySelector<HTMLElement>('.historyx-detail-body')
      ?.scrollTo({ top: 0 });
    if (newlyOpened && isNarrow) closeBtnRef.current?.focus();
  }, [selectedId, isNarrow]);

  useEffect(() => {
    const mq = window.matchMedia(DETAIL_NARROW_QUERY);
    const onChange = () => setIsNarrow(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // 筛选行高度 → sticky 偏移（日期头与详情面板沿用同一个变量）。
  useEffect(() => {
    const el = filtersRef.current;
    if (!el) return;
    const update = () => setFilterBarHeight(el.offsetHeight);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [records.length]);

  // 吸顶偏移写进 CSS 自定义属性（不用 JSX 内联样式：renderer 有
  // 「JSX 不得含内联样式属性」的守卫；台账出现/筛选行换行时都要重算）。
  useEffect(() => {
    const el = layoutRef.current;
    if (!el) return;
    el.style.setProperty('--historyx-filter-h', `${filterBarHeight}px`);
  }, [filterBarHeight, ledger.length]);

  const closeDetail = useCallback(() => {
    setSelectedId(null);
    if (isNarrow) lastRowRef.current?.focus();
  }, [isNarrow]);

  // Esc 关闭详情/抽屉（查看器打开时归查看器；确认条在捕获阶段自行拦截）。
  useEffect(() => {
    if (!active || !selectedId || viewingLog) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || confirmingClear) return;
      e.preventDefault();
      closeDetail();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [active, selectedId, viewingLog, confirmingClear, closeDetail]);

  const selectRun = (run: ExecRecord, trigger?: HTMLElement | null) => {
    if (trigger) lastRowRef.current = trigger;
    setSelectedId(run.executionId);
  };

  // 汇总统计（基于全量，不随过滤变化——作为"总览"语义）
  const totalRuns = records.length;
  const taskCount = useMemo(() => new Set(records.map(taskKeyOf)).size, [records]);
  const statusTotals = useMemo(() => records.reduce((counts, record) => {
    if (record.status === 'success' || record.status === 'failed' || record.status === 'running') {
      counts[record.status] += 1;
    }
    return counts;
  }, { success: 0, failed: 0, running: 0 }), [records]);

  const selected = useMemo(
    () => (selectedId ? records.find((r) => r.executionId === selectedId) ?? null : null),
    [records, selectedId],
  );

  // 详情面板的「同任务最近 5 次」小列表。
  const recentSameTask = useMemo(() => {
    if (!selected) return [] as ExecRecord[];
    const key = taskKeyOf(selected);
    return records
      .filter((r) => taskKeyOf(r) === key)
      .sort((a, b) => startOf(b) - startOf(a))
      .slice(0, 5);
  }, [records, selected]);

  // V4-2（X-03）：同任务的邻次执行（查看器顶栏「上一次/下一次」切换）。
  // 基于全量 records（不受筛选影响），按开始时间倒序与台账口径一致。
  const siblingRuns = useMemo(() => {
    if (!viewingLog) return [] as ExecRecord[];
    const key = taskKeyOf(viewingLog);
    return records
      .filter((r) => taskKeyOf(r) === key)
      .sort((a, b) => startOf(b) - startOf(a));
  }, [records, viewingLog]);
  const viewingIndex = viewingLog
    ? siblingRuns.findIndex((r) => r.executionId === viewingLog.executionId)
    : -1;

  if (viewingLog) {
    // 真全屏：共享 LogViewer 渲染 .log-fullscreen（position:fixed），覆盖
    // Tab 栏——不再是面板内假全屏浮层（UX 审计 B-06）。
    // key=executionId：切换邻次执行时整条数据链路重建（行缓冲/游标/轮询复位）。
    const idx = viewingIndex;
    return (
      <ExecutionLogOverlay
        key={viewingLog.executionId}
        record={viewingLog}
        onClose={() => setViewingLog(null)}
        nav={siblingRuns.length > 1 && idx >= 0 ? {
          index: idx,
          count: siblingRuns.length,
          onPrev: () => setViewingLog(siblingRuns[idx - 1] ?? viewingLog),
          onNext: () => setViewingLog(siblingRuns[idx + 1] ?? viewingLog),
        } : undefined}
        onRevealLog={() => { void handleRevealLog(viewingLog.executionId); }}
      />
    );
  }

  const hasFilters = q.length > 0 || statusFilter !== 'all' || taskFilter !== '';
  const filterBar = (
    <div className="history-filters" ref={filtersRef}>
      <div className="history-search">
        <span className="history-search-icon" aria-hidden="true"><Icon name="search" /></span>
        <input
          ref={searchRef}
          className="history-search-input"
          type="search"
          placeholder={t('history.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t('history.searchAria')}
        />
      </div>
      <div className="history-filter-chips" role="group" aria-label={t('history.filterAria')}>
        {([
          ['all', t('history.chip.all', totalRuns)],
          ['success', t('history.chip.success', statusTotals.success)],
          ['failed', t('history.chip.failed', statusTotals.failed)],
          ['running', t('history.chip.running', statusTotals.running)],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={`history-chip${statusFilter === value ? ' active' : ''}`}
            onClick={() => { setStatusFilter(value); }}
            aria-pressed={statusFilter === value}
          >{label}</button>
        ))}
      </div>
      <label className="historyx-task-filter">
        <select
          className="historyx-task-select"
          value={taskFilter}
          onChange={(e) => setTaskFilter(e.target.value)}
          aria-label={t('historyx.taskFilter.aria')}
        >
          <option value="">{t('historyx.taskFilter.all')}</option>
          {taskOptions.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
    </div>
  );

  const nowMs = Date.now();

  return (
    <div className="history-page">
      <PageHeader
        icon={<Icon name="clock" />}
        title={t('history.title')}
        meta={hasFilters
          ? t('historyx.metaFiltered', ledger.length, totalRuns, failedVisible)
          : t('historyx.meta', totalRuns, taskCount, statusTotals.failed)}
        actions={
          <>
            <button className="btn btn-sm" onClick={() => void load(false)} disabled={loading}><Icon name="refresh" /> {t('ui.refresh')}</button>
            {/* 用户报障：历史记录只能看，日志拿不到手。直接给一个「打开日志目录」
                入口（当天分片），配合每行的「定位日志文件」。 */}
            <button
              className="btn btn-sm"
              onClick={() => void handleOpenLogFolder()}
              title={t('history.logFolderTitle')}
            ><Icon name="folder" /> {t('history.logFolder')}</button>
            {/* 低频破坏性动作收进 ⋯，页头不再与刷新/日志目录挤在同一行。 */}
            <details className="historyx-menu">
              <summary
                className="btn btn-sm historyx-menu-trigger"
                aria-label={t('historyx.more')}
                title={t('historyx.more')}
              >⋯</summary>
              <div className="historyx-menu-pop">
                <button
                  type="button"
                  className="btn btn-sm btn-danger-ghost historyx-menu-danger"
                  onClick={(e) => {
                    e.currentTarget.closest('details')?.removeAttribute('open');
                    setConfirmingClear(true);
                  }}
                  disabled={records.length === 0 || confirmingClear}
                ><Icon name="trash" /> {t('history.clearAll')}</button>
              </div>
            </details>
          </>
        }
      />

      {confirmingClear && (
        <ConfirmBar
          titleId="history-clear-title"
          title={t('history.clearConfirmTitle', records.length)}
          description={t('history.clearConfirmDesc')}
          confirmLabel={t('history.clearConfirmOk')}
          variant="danger"
          onConfirm={() => void handleClear()}
          onCancel={() => setConfirmingClear(false)}
        />
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

      {records.length > 0 && filterBar}

      {loading && records.length === 0 ? (
        <div className="historyx-skeleton" aria-label={t('history.loadingAria')} aria-busy="true">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="skeleton skeleton-group">
              <div className="skeleton-row">
                <div className="skeleton-line w-45" />
                <div className="skeleton-line w-30 ml-auto" />
              </div>
            </div>
          ))}
        </div>
      ) : ledger.length === 0 ? (
        /* V4-5（V-09）：空态家族 EmptyState（page 档）；「过滤后为空」与
            「完全没记录」文案区分的既有守卫口径保持不变 */
        <EmptyState icon="clock" title={error ? t('history.empty.errorTitle') : records.length > 0 ? t('history.empty.noMatchTitle') : t('history.empty.noneTitle')}>
          <span className="empty-state-text">{error
            ? t('history.empty.errorBody')
            : records.length > 0
              // 有记录但过滤后为空——必须与"完全没记录"区分开
              ? t('history.empty.filteredBody')
              : t('history.empty.noneBody')}</span>
          {!error && records.length === 0 && (
            <>
              <span className="empty-hint">{t('history.empty.hint')}</span>
              {/* 空态给行动出口：历史为空最常见的根因是执行器没在跑（2026-10 指引升级） */}
              <button className="btn btn-sm" onClick={() => requestTabSwitch('status')}>
                <Icon name="activity" className="icon-xs" /> {t('history.empty.goStatus')}
              </button>
            </>
          )}
          {records.length > 0 && (
            <button
              className="btn btn-sm"
              onClick={() => { setQuery(''); setStatusFilter('all'); setTaskFilter(''); setVisibleCount(INITIAL_VISIBLE_RUNS); }}
            >{t('history.empty.clearFilters')}</button>
          )}
        </EmptyState>
      ) : (
        <div className="historyx-layout" ref={layoutRef}>
          <div className="historyx-list">
            {visibleRows.map((run, idx) => {
              // B-04：桶切换处插日期分组头（首行必插；桶序随行序单调不减）。
              const bucket = dateBucketOf(startOf(run), nowMs);
              const prevBucket = idx > 0 ? dateBucketOf(startOf(visibleRows[idx - 1]), nowMs) : -1;
              // B-05 后半（2026-10 审计）：running 超 6h 仍无终态，大概率进程
              // 僵死——时长染黄 + tooltip 引导看日志确认。判定是启发式，不自动
              // 改写状态（误报比漏报更伤信任）。
              const staleRunning = run.status === 'running' && startOf(run) > 0
                && Date.now() - startOf(run) > STALE_RUNNING_MS;
              const key = run.executionId;
              const isOpen = selectedId === key;
              const label = taskLabelOf(run);
              const errText = run.errorMessage
                ? run.errorMessage.replace(/\s+/g, ' ').trim()
                : run.status === 'failed' && run.exitCode !== undefined
                  ? t('history.run.exitCode', run.exitCode)
                  : '';

              return (
                <React.Fragment key={key}>
                  {bucket !== prevBucket && (
                    <div className="history-date-header">{DATE_BUCKET_LABELS[bucket]}</div>
                  )}
                  <div
                    className={`history-run-row ${statusTone(run.status)}${isOpen ? ' is-selected' : ''}`}
                    role="button"
                    tabIndex={0}
                    aria-expanded={isOpen}
                    aria-controls={`history-runs-${key}`}
                    aria-label={t('historyx.rowAria', label, statusText(run.status))}
                    onClick={(e) => selectRun(run, e.currentTarget)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return;
                      e.preventDefault();
                      selectRun(run, e.currentTarget);
                    }}
                  >
                    <span className="historyx-run-status">
                      <span className={`historyx-status-dot ${statusTone(run.status)}`} aria-hidden="true" />
                      <span className={`historyx-status-text ${statusTone(run.status)}`}>{statusText(run.status)}</span>
                    </span>

                    <span className="historyx-run-main">
                      {/* 任务名是展示文本，不再做成行内按钮：整行 role=button
                          里嵌 button 既不合 ARIA，也会让窄窗点击任务名变成
                          “筛选”而不是“打开详情”。按任务筛选由顶部 select 承担。 */}
                      <span className="historyx-task-name" title={label}>{label}</span>
                      {errText && (
                        <span className="history-run-err" title={run.errorMessage || errText}>
                          <Icon name="warning" className="icon-xs" />
                          <span>{errText}</span>
                        </span>
                      )}
                    </span>

                    <span className="historyx-run-meta">
                      <span className="historyx-run-time" title={run.startTime ? formatLocaleDateTime(run.startTime) : undefined}>
                        {formatTime(run.startTime)}
                      </span>
                      <span className={`historyx-run-dur${staleRunning ? ' history-run-dur-stale' : ''}`} title={staleRunning ? t('history.run.staleTitle') : undefined}>
                        {runDurationText(run)}
                      </span>
                    </span>

                    <span className="historyx-run-actions">
                      <button
                        type="button"
                        className="btn btn-sm historyx-action"
                        onClick={(e) => { e.stopPropagation(); setViewingLog(run); }}
                        onKeyDown={(e) => e.stopPropagation()}
                        title={t('status.viewLogs')}
                        aria-label={t('status.viewLogs')}
                      ><Icon name="terminal" /><span className="historyx-action-text">{t('status.viewLogs')}</span></button>
                      <button
                        type="button"
                        className="btn btn-sm historyx-action"
                        onClick={(e) => { e.stopPropagation(); void handleRevealLog(run.executionId); }}
                        onKeyDown={(e) => e.stopPropagation()}
                        title={t('history.run.revealTitle')}
                        aria-label={t('history.run.reveal')}
                      ><Icon name="external" /><span className="historyx-action-text">{t('history.run.reveal')}</span></button>
                    </span>
                  </div>
                </React.Fragment>
              );
            })}

            {ledger.length > visibleCount && (
              <button
                type="button"
                className="historyx-more"
                onClick={() => setVisibleCount((count) => count + RUN_PAGE_SIZE)}
              >{t('historyx.loadOlder')}</button>
            )}
            {ledger.length <= visibleCount && ledger.length > INITIAL_VISIBLE_RUNS && (
              <div className="historyx-end">{t('historyx.allShown')}</div>
            )}
          </div>

          <aside
            id={selected ? `history-runs-${selected.executionId}` : undefined}
            ref={detailRef}
            className={`historyx-detail${selected ? ' has-selection' : ' is-empty'}${isNarrow ? ' is-drawer' : ''}`}
            aria-label={t('historyx.detail.title')}
          >
            <div className="historyx-detail-head">
              <h2 className="historyx-detail-title">
                {selected ? taskLabelOf(selected) : t('historyx.detail.title')}
              </h2>
              <button
                ref={closeBtnRef}
                type="button"
                className="btn btn-sm historyx-detail-close"
                onClick={closeDetail}
                aria-label={t('historyx.detail.close')}
                title={t('historyx.detail.close')}
              ><Icon name="close" /></button>
            </div>

            {!selected ? (
              <p className="historyx-detail-guide">{t('historyx.detail.empty')}</p>
            ) : (
              <div className="historyx-detail-body">
                <div className="historyx-detail-status">
                  {statusBadge(selected.status)}
                  <span className="historyx-detail-duration">{runDurationText(selected)}</span>
                </div>

                <dl className="historyx-facts">
                  <div className="historyx-fact">
                    <dt>{t('historyx.detail.start')}</dt>
                    <dd title={selected.startTime ? formatLocaleDateTime(selected.startTime) : undefined}>{formatTime(selected.startTime)}</dd>
                  </div>
                  <div className="historyx-fact">
                    <dt>{t('historyx.detail.end')}</dt>
                    <dd title={selected.endTime ? formatLocaleDateTime(selected.endTime) : undefined}>
                      {selected.endTime !== undefined
                        ? formatTime(selected.endTime)
                        : selected.status === 'running'
                          ? t('historyx.detail.running')
                          : '—'}
                    </dd>
                  </div>
                  <div className="historyx-fact">
                    <dt>{t('historyx.detail.duration')}</dt>
                    <dd>{runDurationText(selected)}</dd>
                  </div>
                  <div className="historyx-fact">
                    <dt>{t('historyx.detail.exitCode')}</dt>
                    <dd>{selected.exitCode !== undefined ? String(selected.exitCode) : '—'}</dd>
                  </div>
                </dl>

                <section className="historyx-section">
                  <h3 className="historyx-section-title">{t('historyx.detail.execId')}</h3>
                  <div className="historyx-id-row">
                    <code className="historyx-detail-id">{selected.executionId}</code>
                    <CopyExecIdButton key={selected.executionId} id={selected.executionId} />
                  </div>
                </section>

                <section className="historyx-section">
                  <h3 className="historyx-section-title">{t('historyx.detail.error')}</h3>
                  {selected.errorMessage ? (
                    <p className="historyx-detail-error">{selected.errorMessage}</p>
                  ) : selected.status === 'failed' ? (
                    <p className="historyx-detail-error">
                      {selected.exitCode !== undefined ? t('history.run.exitCode', selected.exitCode) : t('historyx.detail.noError')}
                    </p>
                  ) : (
                    <p className="historyx-detail-noerror">{t('historyx.detail.noError')}</p>
                  )}
                </section>

                <div className="historyx-detail-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setViewingLog(selected)}
                  ><Icon name="terminal" /> {t('historyx.detail.viewLog')}</button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void handleRevealLog(selected.executionId)}
                  ><Icon name="external" /> {t('historyx.detail.reveal')}</button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void handleExportSelectedLog(selected.executionId)}
                    disabled={exportingId === selected.executionId}
                  ><Icon name="download" /> {t('history.exportLog')}</button>
                </div>

                {recentSameTask.length > 1 && (
                  <section className="historyx-section">
                    <h3 className="historyx-section-title">{t('historyx.detail.recent')}</h3>
                    <div className="historyx-recent">
                      {recentSameTask.map((run) => {
                        const active = run.executionId === selected.executionId;
                        return (
                          <button
                            key={run.executionId}
                            type="button"
                            className={`historyx-recent-row${active ? ' is-active' : ''}`}
                            onClick={() => setSelectedId(run.executionId)}
                            aria-current={active ? 'true' : undefined}
                          >
                            <span className={`historyx-status-dot ${statusTone(run.status)}`} aria-hidden="true" />
                            <span className="historyx-recent-time">{formatTime(run.startTime)}</span>
                            <span className="historyx-recent-dur">{runDurationText(run)}</span>
                            <span className={`historyx-recent-status ${statusTone(run.status)}`}>{statusText(run.status)}</span>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                )}
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
