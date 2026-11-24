/**
 * 窗口位置 / 尺寸 / 显示器记忆的纯决策层（无 Electron 依赖，裸 Node selftest 直接驱动）。
 *
 * 背景：旧状态窗只持久化 `{ width, height, maximized }`，重启后位置永远回到
 * 光标所在显示器居中；多显示器场景下，被拔掉的副屏上存过的坐标会让窗口落到
 * 黑屏区域（用户报告「托盘在但窗口看不到」的同类故障形态之一）。
 *
 * 本模块负责三件可测的事：
 *  1) 解析落盘状态（兼容旧形状：只有 width/height/maximized 也算合法）；
 *  2) 按当前显示器列表把保存的矩形解析成可恢复的矩形——保存时所在显示器
 *     已断开时回落主屏；保存的坐标与任何可见工作区都不重叠时在目标工作区内
 *     居中；尺寸钳进目标工作区；
 *  3) 判断一个矩形是否还落在某块可见显示器工作区内（display-metrics-changed
 *     后评估是否需要重新钳位）。
 *
 * Electron 的 `screen` / `BrowserWindow` 接线在 window-manager.ts，本文件不 import。
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 与 Electron Display 对齐的最小形状（id + workArea），便于注入假显示器测例。 */
export interface DisplayLike {
  id: string;
  workArea: Rect;
}

/** 落盘的窗口状态（status-window.json 的归一形状）。 */
export interface SavedWindowState {
  /** 无保存位置（旧形状 / 缺坐标）时为 null；宽度/高度一定有有限值。 */
  bounds: Rect | null;
  /** 保存时窗口所在显示器 id；未知 / 旧记录为 null。 */
  displayId: string | null;
  maximized: boolean;
}

/** 恢复时允许的最小窗口尺寸（防止钳出一个不可用的小窗）。 */
export const RESTORE_MIN_WIDTH = 320;
export const RESTORE_MIN_HEIGHT = 240;

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * 解析落盘 JSON。非对象 / 缺宽度或高度 → null（调用方回落默认尺寸居中）。
 * 旧形状 `{ width, height, maximized }` 兼容：bounds 缺 x/y 时按「未保存位置」处理。
 */
export function parseSavedState(raw: unknown): SavedWindowState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (!isFiniteNumber(v.width) || !isFiniteNumber(v.height)) return null;
  const bounds: Rect = {
    x: isFiniteNumber(v.x) ? v.x : NaN,
    y: isFiniteNumber(v.y) ? v.y : NaN,
    width: v.width,
    height: v.height,
  };
  const displayId = typeof v.displayId === 'string' && v.displayId !== '' ? v.displayId : null;
  return { bounds, displayId, maximized: v.maximized === true };
}

/** 矩形与工作区的可见重叠面积（宽 / 高方向的重叠长度；无重叠为 0 或负）。 */
function overlap(rect: Rect, area: Rect): { ow: number; oh: number } {
  const ow = Math.min(rect.x + rect.width, area.x + area.width) - Math.max(rect.x, area.x);
  const oh = Math.min(rect.y + rect.height, area.y + area.height) - Math.max(rect.y, area.y);
  return { ow, oh };
}

/** 在工作区内居中给出一个指定宽高的矩形。 */
export function centerInArea(area: Rect, width: number, height: number): Rect {
  return {
    x: Math.round(area.x + Math.max(0, (area.width - width) / 2)),
    y: Math.round(area.y + Math.max(0, (area.height - height) / 2)),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/**
 * 把保存的窗口状态解析成可恢复的矩形；无保存尺寸 / 无显示器列表时返回 null
 * （调用方按默认尺寸处理）。
 *
 * 优先级：保存时所在显示器仍在 → 用它；已断开 → 回落列表首项（主屏）。
 * 位置：保存坐标与目标工作区基本不重叠（拔掉副屏 / 坐标漂移）→ 居中；
 * 否则把坐标钳进工作区边界，避免窗口半边跑出屏幕。
 */
export function resolveRestoreBounds(
  saved: SavedWindowState,
  displays: readonly DisplayLike[],
): Rect | null {
  if (!saved.bounds || displays.length === 0) return null;
  const target = displays.find((d) => d.id === saved.displayId) ?? displays[0];
  const area = target.workArea;

  const width = Math.min(Math.max(saved.bounds.width, RESTORE_MIN_WIDTH), area.width);
  const height = Math.min(Math.max(saved.bounds.height, RESTORE_MIN_HEIGHT), area.height);

  const hasPosition = isFiniteNumber(saved.bounds.x) && isFiniteNumber(saved.bounds.y);
  if (!hasPosition) return centerInArea(area, width, height);

  const candidate: Rect = { x: saved.bounds.x, y: saved.bounds.y, width, height };
  const { ow, oh } = overlap(candidate, area);
  const enoughOverlap = ow >= Math.min(width, 200) && oh >= Math.min(height, 120);
  if (!enoughOverlap) return centerInArea(area, width, height);

  return {
    x: Math.round(Math.min(Math.max(candidate.x, area.x), area.x + area.width - width)),
    y: Math.round(Math.min(Math.max(candidate.y, area.y), area.y + area.height - height)),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/**
 * 矩形是否还落在某块可见显示器的工作区内（重叠达到最小可操作尺寸）。
 * display-metrics-changed（拔屏 / 改缩放 / 改分辨率）后用它判断是否需要重新钳位。
 */
export function intersectsAnyDisplay(rect: Rect, displays: readonly DisplayLike[]): boolean {
  return displays.some((d) => {
    const { ow, oh } = overlap(rect, d.workArea);
    return ow >= 80 && oh >= 60;
  });
}
