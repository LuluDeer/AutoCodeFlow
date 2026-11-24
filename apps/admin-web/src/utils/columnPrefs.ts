/**
 * 列自定义偏好模型（显隐 + 顺序，纯函数，无 React 依赖）。
 *
 * 持久化形状（信封 data，版本见 useColumnPrefs）：
 * ```ts
 * { hidden: string[]; order: string[] }
 * ```
 *
 * 坏值防御（与 useDraft / prefsEnvelope 同口径）：
 *  - 非对象、hidden/order 非数组 → 视为无存量，回落注册表缺省；
 *  - 未知列键一律剔除；order 缺失的注册表列按注册表顺序补在末尾；
 *  - hidden 与 order 取交集，持久化形状本身不自洽时以顺序序列为准重算可见集。
 *
 * 注册表（registry）由调用方按页面提供：每个键带 `defaultHidden` 缺省态；
 * 模型不硬编码任何具体页面的列。
 */

export interface ColumnRegistryItem {
  key: string;
  /** 无存量时的缺省隐藏态（true = 默认收起） */
  defaultHidden: boolean;
}

export interface ColumnPrefs {
  hidden: string[];
  order: string[];
}

/** 由注册表构造缺省偏好：order = 注册表顺序；hidden = defaultHidden 集合。 */
export function defaultColumnPrefs(registry: ColumnRegistryItem[]): ColumnPrefs {
  return {
    hidden: registry.filter((r) => r.defaultHidden).map((r) => r.key),
    order: registry.map((r) => r.key),
  };
}

/**
 * 校验并归一化持久化 data。非法 → null（调用方回落缺省）。
 * 返回的 hidden/order 只含注册表内合法键，order 含全部注册表键。
 */
export function parseColumnPrefs(raw: unknown, registry: ColumnRegistryItem[]): ColumnPrefs | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const env = raw as Record<string, unknown>;
  if (!Array.isArray(env.hidden) || !Array.isArray(env.order)) return null;

  const valid = new Set(registry.map((r) => r.key));
  const asStringArray = (v: unknown[]): string[] =>
    v.filter((k): k is string => typeof k === 'string' && valid.has(k));

  const hidden = asStringArray(env.hidden);
  const orderUnique: string[] = [];
  for (const k of asStringArray(env.order)) {
    if (!orderUnique.includes(k)) orderUnique.push(k);
  }
  // 注册表中未出现在 order 的键，按注册表顺序补尾（新增列默认出现，不被旧存量藏掉）
  for (const r of registry) {
    if (!orderUnique.includes(r.key)) orderUnique.push(r.key);
  }
  return { hidden, order: orderUnique };
}

/** 解析结果：按偏好顺序给出可见列键序列 + 隐藏集合。 */
export interface ResolvedColumns {
  /** 可见列键，按 prefs.order 顺序 */
  orderedVisible: string[];
  hidden: Set<string>;
  /** 全部列键（注册表顺序兜底） */
  allKeys: string[];
}

export function resolveColumnPrefs(registry: ColumnRegistryItem[], prefs: ColumnPrefs): ResolvedColumns {
  const allKeys = registry.map((r) => r.key);
  const hidden = new Set(prefs.hidden);
  const orderedVisible = prefs.order.filter((k) => !hidden.has(k) && allKeys.includes(k));
  return { orderedVisible, hidden, allKeys };
}

/** 切换某列显隐，返回新偏好（不可变更新）。隐藏到只剩一列时拒绝隐藏（防死面）。 */
export function toggleColumnHidden(prefs: ColumnPrefs, key: string): ColumnPrefs {
  if (prefs.hidden.includes(key)) {
    return { ...prefs, hidden: prefs.hidden.filter((k) => k !== key) };
  }
  const visibleCount = prefs.order.filter((k) => !prefs.hidden.includes(k)).length;
  if (visibleCount <= 1) return prefs;
  return { ...prefs, hidden: [...prefs.hidden, key] };
}

/**
 * 把某列在 order 序列中上移（dir=-1）/ 下移（dir=1）。
 * 已在边界时返回原偏好（不可变更新，不原地改）。
 */
export function moveColumn(prefs: ColumnPrefs, key: string, dir: -1 | 1): ColumnPrefs {
  const order = [...prefs.order];
  const idx = order.indexOf(key);
  if (idx < 0) return prefs;
  const target = idx + dir;
  if (target < 0 || target >= order.length) return prefs;
  [order[idx], order[target]] = [order[target], order[idx]];
  return { ...prefs, order };
}
