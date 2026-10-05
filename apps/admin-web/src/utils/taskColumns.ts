/**
 * COLSET-01：任务列表列显隐偏好（localStorage 持久化，键 tasklist.columns.v1）。
 *
 * ── 设计约束（与 task-list-deep 列宽契约共存） ──────────────────────────────
 * 只做**显隐过滤**（visibleColumns.filter）——列定义、列宽、scroll.x 一律不动；
 * 持久化的是「隐藏列集合」（缺省空数组 = 全显，与既有渲染零行为差异）。
 * 隐藏而非记忆可见的好处：未来新增列时默认出现，不会被旧存量偏好藏掉。
 *
 * 脏值防御：非法 JSON / 非数组 / 含未知列键的条目一律剔除；无法解析时按
 * 缺省全显处理（回退到现状行为）。
 */
export const TASKLIST_COLUMNS_STORAGE_KEY = 'tasklist.columns.v1';

/** 任务列表全部列键（顺序即 Checkbox.Group 展示顺序；与 TaskListPage columns 对齐） */
export const TASK_LIST_COLUMN_KEYS = [
  'name',
  'status',
  'trigger',
  'priority',
  'schedule',
  'nextRun',
  'lastRun',
  'runtime',
  'toggle',
  'actions',
] as const;

export type TaskColumnKey = (typeof TASK_LIST_COLUMN_KEYS)[number];

/**
 * 解析持久化值 → 隐藏列集合。
 * 缺席/非法 → null（调用方按缺省全显处理）；合法 → 剔除未知键后的隐藏列数组。
 */
export function parseHiddenColumns(raw: string | null): TaskColumnKey[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const valid = new Set<string>(TASK_LIST_COLUMN_KEYS);
    return parsed.filter((k): k is TaskColumnKey => typeof k === 'string' && valid.has(k));
  } catch {
    return null;
  }
}

/** 读取隐藏列集合（storage 不可用/脏值 → 空数组 = 全显） */
export function readHiddenColumns(): TaskColumnKey[] {
  try {
    return parseHiddenColumns(window.localStorage.getItem(TASKLIST_COLUMNS_STORAGE_KEY)) ?? [];
  } catch {
    return [];
  }
}

/** 持久化隐藏列集合（隐私模式等 storage 不可用时静默降级为会话内记忆） */
export function writeHiddenColumns(keys: TaskColumnKey[]): void {
  try {
    window.localStorage.setItem(TASKLIST_COLUMNS_STORAGE_KEY, JSON.stringify(keys));
  } catch {
    /* localStorage 不可用时忽略 */
  }
}
