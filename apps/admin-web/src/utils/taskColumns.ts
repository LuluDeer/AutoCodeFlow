/**
 * 任务列表列键与缺省隐藏列常量（列定义/列宽在列文件内维护）。
 *
 * 偏好持久化已收口到 utils/columnPrefs + hooks/useColumnPrefs（新信封键
 * `autoflow-tasklist-columns:v1`）；本文件只保留列键表、注册表与缺省收起口径。
 * `TASKLIST_COLUMNS_STORAGE_KEY` 为旧版纯隐藏数组存量键，仅供一次性迁移读取。
 */
import type { ColumnRegistryItem } from './columnPrefs';

export const TASKLIST_COLUMNS_STORAGE_KEY = 'tasklist.columns.v1';

/** 任务列表全部列键（顺序即展示顺序；与 TaskListPage columns 对齐）。
 *  P1-1 列重排：核心六列（名称/状态/上次执行/下次执行/启用/操作）在前，低频辅助列在后。 */
export const TASK_LIST_COLUMN_KEYS = [
  'name',
  'status',
  'lastRun',
  'nextRun',
  'toggle',
  'actions',
  'trigger',
  'priority',
  'schedule',
  'runtime',
] as const;

export type TaskColumnKey = (typeof TASK_LIST_COLUMN_KEYS)[number];

/**
 * 缺省隐藏列（P1-1 任务列表 1280 首屏治理）：首屏只保留值班核心六列——
 * 名称 / 状态 / 上次执行 / 下次执行 / 启用 / 操作；触发方式、优先级、调度表达式、
 * 运行时收进「列设置」，用户可勾选恢复。
 */
export const DEFAULT_HIDDEN_COLUMNS: TaskColumnKey[] = [
  'trigger',
  'priority',
  'schedule',
  'runtime',
];

/** 任务列表列注册表（缺省隐藏 = DEFAULT_HIDDEN_COLUMNS），供 useColumnPrefs 使用。 */
export const TASK_COLUMN_REGISTRY: ColumnRegistryItem[] = TASK_LIST_COLUMN_KEYS.map((k) => ({
  key: k,
  defaultHidden: DEFAULT_HIDDEN_COLUMNS.includes(k),
}));
