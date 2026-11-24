/**
 * 保存筛选视图 hook（localStorage 信封持久化，增 / 删 / 改 / 切换）。
 *
 * - 首次挂载惰性读取信封；坏值 / 版本不符 / storage 不可用 → 空列表；
 * - save：命名快照当前筛选口径；重名允许（以 id 区分）；空名 / 超长名拒绝；
 *   超 MAX_SAVED_VIEWS 条由模型淘汰最旧；
 * - rename / remove 同步落盘；remove 命中当前激活项时清空激活态；
 * - activeId 仅记录本页当前激活的视图（会话内状态，不持久化——刷新后回到
 *   「当前未保存口径」，与 URL 深链口径一致）。
 */
import { useCallback, useState } from 'react';
import { readEnvelope, writeEnvelope } from '../utils/prefsEnvelope';
import {
  VIEW_NAME_MAX,
  makeViewId,
  normalizeViewName,
  removeView,
  renameView,
  upsertView,
  validateSavedViews,
  type SavedView,
} from '../utils/savedViews';

/** 视图信封结构版本；filters 形状增删导致旧存量不合法时 +1。 */
export const SAVED_VIEWS_SCHEMA_VERSION = 1;

export interface SaveResult {
  ok: boolean;
  reason?: 'empty' | 'tooLong';
}

export interface UseSavedViewsResult<F> {
  views: SavedView<F>[];
  activeId: string | null;
  count: number;
  save: (name: string, filters: F) => SaveResult;
  rename: (id: string, name: string) => SaveResult;
  remove: (id: string) => void;
  activate: (id: string | null) => void;
}

function validateName(name: string): SaveResult {
  const normalized = normalizeViewName(name);
  if (!normalized) return { ok: false, reason: 'empty' };
  if (normalized.length > VIEW_NAME_MAX) return { ok: false, reason: 'tooLong' };
  return { ok: true };
}

export function useSavedViews<F>(
  storageKey: string,
  validateFilters: (filters: unknown) => filters is F,
): UseSavedViewsResult<F> {
  const [views, setViews] = useState<SavedView<F>[]>(() => {
    const parsed = readEnvelope<unknown>(
      storageKey,
      SAVED_VIEWS_SCHEMA_VERSION,
      (d) => validateSavedViews(d, validateFilters) !== null,
    );
    return parsed ? validateSavedViews(parsed, validateFilters) ?? [] : [];
  });
  const [activeId, setActiveId] = useState<string | null>(null);

  const persist = useCallback(
    (next: SavedView<F>[]) => {
      setViews(next);
      writeEnvelope(storageKey, SAVED_VIEWS_SCHEMA_VERSION, next);
    },
    [storageKey],
  );

  const save = useCallback(
    (name: string, filters: F): SaveResult => {
      const check = validateName(name);
      if (!check.ok) return check;
      const view: SavedView<F> = {
        id: makeViewId(),
        name: normalizeViewName(name),
        savedAt: Date.now(),
        filters,
      };
      persist(upsertView(views, view));
      setActiveId(view.id);
      return { ok: true };
    },
    [persist, views],
  );

  const rename = useCallback(
    (id: string, name: string): SaveResult => {
      const check = validateName(name);
      if (!check.ok) return check;
      persist(renameView(views, id, normalizeViewName(name)));
      return { ok: true };
    },
    [persist, views],
  );

  const remove = useCallback(
    (id: string) => {
      persist(removeView(views, id));
      setActiveId((cur) => (cur === id ? null : cur));
    },
    [persist, views],
  );

  const activate = useCallback((id: string | null) => setActiveId(id), []);

  return { views, activeId, count: views.length, save, rename, remove, activate };
}
