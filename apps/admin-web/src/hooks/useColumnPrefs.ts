/**
 * 列自定义偏好 hook（显隐 + 顺序 + 重置默认，localStorage 信封持久化）。
 *
 * - 首次挂载惰性读取信封；坏值 / 版本不符 / storage 不可用 → 注册表缺省；
 * - 每次切换显隐 / 移动顺序后同步落盘（偏好体量极小，无需防抖）；
 * - 重置默认：删除信封并回落注册表缺省；
 * - `legacyHiddenKey`：一次性读取旧版「纯隐藏数组」存量（迁移用，不回写旧键）。
 *
 * 页面侧只持有本 hook 返回的解析结果与回调，列定义 / 列宽仍在各页面列模块内维护。
 */
import { useCallback, useState } from 'react';
import {
  defaultColumnPrefs,
  moveColumn,
  parseColumnPrefs,
  resolveColumnPrefs,
  toggleColumnHidden,
  type ColumnPrefs,
  type ColumnRegistryItem,
  type ResolvedColumns,
} from '../utils/columnPrefs';
import { readEnvelope, removeEnvelope, writeEnvelope } from '../utils/prefsEnvelope';

/** 列偏好信封结构版本；字段增删导致旧形状不合法时 +1（旧存量整体丢弃）。 */
export const COLUMN_PREFS_SCHEMA_VERSION = 1;

export interface UseColumnPrefsOptions {
  /** 旧版纯隐藏数组存量键（仅迁移读取，不回写） */
  legacyHiddenKey?: string;
}

/** 解析旧版纯数组隐藏集合：非法 JSON / 非数组 / 未知键剔除。 */
function parseLegacyHidden(raw: string, registry: ColumnRegistryItem[]): string[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const valid = new Set(registry.map((r) => r.key));
    return parsed.filter((k): k is string => typeof k === 'string' && valid.has(k));
  } catch {
    return null;
  }
}

export interface UseColumnPrefsResult extends ResolvedColumns {
  prefs: ColumnPrefs;
  toggle: (key: string) => void;
  move: (key: string, dir: -1 | 1) => void;
  reset: () => void;
}

export function useColumnPrefs(
  storageKey: string,
  registry: ColumnRegistryItem[],
  options: UseColumnPrefsOptions = {},
): UseColumnPrefsResult {
  const [prefs, setPrefs] = useState<ColumnPrefs>(() => {
    const parsed = readEnvelope<unknown>(storageKey, COLUMN_PREFS_SCHEMA_VERSION, (d) =>
      parseColumnPrefs(d, registry) !== null,
    );
    if (parsed) return parseColumnPrefs(parsed, registry) ?? defaultColumnPrefs(registry);

    if (options.legacyHiddenKey) {
      try {
        const raw = window.localStorage.getItem(options.legacyHiddenKey);
        if (raw) {
          const legacy = parseLegacyHidden(raw, registry);
          if (legacy) return { ...defaultColumnPrefs(registry), hidden: legacy };
        }
      } catch {
        /* storage 不可用 → 缺省 */
      }
    }
    return defaultColumnPrefs(registry);
  });

  const persist = useCallback(
    (next: ColumnPrefs) => {
      setPrefs(next);
      writeEnvelope(storageKey, COLUMN_PREFS_SCHEMA_VERSION, next);
    },
    [storageKey],
  );

  const toggle = useCallback(
    (key: string) => persist(toggleColumnHidden(prefs, key)),
    [persist, prefs],
  );

  const move = useCallback(
    (key: string, dir: -1 | 1) => persist(moveColumn(prefs, key, dir)),
    [persist, prefs],
  );

  const reset = useCallback(() => {
    removeEnvelope(storageKey);
    setPrefs(defaultColumnPrefs(registry));
  }, [storageKey, registry]);

  const resolved = resolveColumnPrefs(registry, prefs);
  return { prefs, ...resolved, toggle, move, reset };
}
