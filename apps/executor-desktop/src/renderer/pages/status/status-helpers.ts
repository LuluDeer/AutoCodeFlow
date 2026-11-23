import { useEffect, useRef } from 'react';

/**
 * 格式化右栏「最近失败」时间：
 *  · 今日显示 `HH:mm`；
 *  · 跨日（非今日）显示 `MM/DD HH:mm`，避免历史记录排在今日下方看似乱序；
 *  · 非有限时间戳返回 `'—'`。
 */
export function formatFailureTime(ms: number | undefined, nowMs: number = Date.now()): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  const now = new Date(nowMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (isToday) return hhmm;
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${hhmm}`;
}

/** 完整本地日期时间 `YYYY-MM-DD HH:mm`（用于 tooltip 悬停核对）。 */
export function formatFullDateTime(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface FailureTitleInput {
  startTime?: number;
  taskName?: string;
  errorMessage?: string;
}

/** 构造「最近失败」条目的完整 tooltip：完整日期 + 任务名 + 错误摘要。 */
export function formatFailureTitle(
  record: FailureTitleInput,
  unnamedTask: string,
  fallbackTitle: string,
): string {
  const fullDate = formatFullDateTime(record.startTime);
  const name = record.taskName?.trim() || unnamedTask;
  const err = record.errorMessage?.trim() || '';
  const head = fullDate ? `${fullDate} · ${name}` : name;
  if (err) return `${head} — ${err}`;
  return head || fallbackTitle;
}

/** 构造活动条运行中任务的完整 tooltip（任务名 + 运行时长）。 */
export function formatRunningTaskTitle(name: string, durationText: string | null): string {
  return durationText ? `${name} · ${durationText}` : name;
}

/** 格式化活动条单个运行中任务的持续时长文案。 */
export function formatRunningDuration(
  since: number | null,
  formatMs: (ms: number) => string,
  formatLabel: (dur: string) => string,
  nowMs: number = Date.now(),
): string | null {
  if (since === null) return null;
  return formatLabel(formatMs(nowMs - since));
}

/** 复制反馈读屏播报文案（idle 时返回空串，避免复位回「复制」时产生误报）。 */
export function formatCopyLiveText(
  state: 'idle' | 'copied' | 'error',
  copiedText: string,
  errorText: string,
): string {
  if (state === 'copied') return copiedText;
  if (state === 'error') return errorText;
  return '';
}

/** 判断事件目标或焦点元素是否为可编辑输入控件（避免 Ctrl+F 劫持输入框原生查找）。 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as { tagName?: string; isContentEditable?: boolean };
  if (el.isContentEditable) return true;
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * 状态页 `Ctrl+F` / `Cmd+F` 快捷打开全屏日志搜索：
 * 仅当状态页激活、未开全屏且焦点不在可编辑控件内时触发。
 */
export function useStatusCtrlF(
  active: boolean,
  fullscreen: boolean,
  onOpen: () => void,
): void {
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    if (!active || fullscreen) return;
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== 'f') return;
      if (isEditableTarget(e.target) || isEditableTarget(document.activeElement)) return;
      e.preventDefault();
      onOpenRef.current();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [active, fullscreen]);
}
