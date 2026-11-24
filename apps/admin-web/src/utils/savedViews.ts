/**
 * 保存筛选视图模型（纯函数，无 React 依赖）。
 *
 * 一条视图 = 命名快照：当前筛选 / 排序 / 分页口径（filters 形状由各页面定义，
 * 本模块只做不透明透传 + 形状守卫）。持久化信封 data 为 `SavedView<F>[]`。
 *
 * 口径：
 *  - 上限 MAX_SAVED_VIEWS 条；超限时按 savedAt 淘汰最旧；
 *  - 名称去首尾空白、压缩内部空白，长度上限 VIEW_NAME_MAX；空名拒绝；
 *  - 坏值防御：非数组 / 缺字段 / 时间戳非法 / filters 形状不符 / id 重复 → 逐条剔除。
 */

/** 保存视图条数上限（任务书口径：合理上限如 20 条）。 */
export const MAX_SAVED_VIEWS = 20;
/** 视图名称长度上限（字符）。 */
export const VIEW_NAME_MAX = 30;

export interface SavedView<F> {
  id: string;
  name: string;
  savedAt: number;
  filters: F;
}

/** 生成视图 id：优先 crypto.randomUUID，旧环境回落时间戳 + 随机串。 */
export function makeViewId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `view-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 名称归一化：trim + 压缩内部空白；不截断（超长由调用方按 VIEW_NAME_MAX 拒绝）。 */
export function normalizeViewName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/**
 * 校验持久化数组。任一非法条目逐条剔除；整体非数组 → null（调用方回落空列表）。
 */
export function validateSavedViews<F>(
  raw: unknown,
  validateFilters: (filters: unknown) => filters is F,
): SavedView<F>[] | null {
  if (!Array.isArray(raw)) return null;
  const out: SavedView<F>[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const e = item as Record<string, unknown>;
    if (typeof e.id !== 'string' || typeof e.name !== 'string') continue;
    if (typeof e.savedAt !== 'number' || !Number.isFinite(e.savedAt)) continue;
    if (!validateFilters(e.filters)) continue;
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push({ id: e.id, name: e.name, savedAt: e.savedAt, filters: e.filters });
  }
  return out;
}

/**
 * 新增 / 覆盖一条视图（同 id 覆盖）。超上限时保留最新 MAX_SAVED_VIEWS 条。
 */
export function upsertView<F>(list: SavedView<F>[], view: SavedView<F>): SavedView<F>[] {
  const idx = list.findIndex((v) => v.id === view.id);
  const next = idx >= 0 ? list.map((v, i) => (i === idx ? view : v)) : [...list, view];
  if (next.length > MAX_SAVED_VIEWS) {
    return [...next].sort((a, b) => b.savedAt - a.savedAt).slice(0, MAX_SAVED_VIEWS);
  }
  return next;
}

/** 重命名；id 不存在或空名 → 原列表不变。 */
export function renameView<F>(
  list: SavedView<F>[],
  id: string,
  name: string,
): SavedView<F>[] {
  const normalized = normalizeViewName(name);
  if (!normalized) return list;
  return list.map((v) => (v.id === id ? { ...v, name: normalized } : v));
}

/** 删除一条视图；id 不存在 → 原列表不变。 */
export function removeView<F>(list: SavedView<F>[], id: string): SavedView<F>[] {
  return list.filter((v) => v.id !== id);
}
