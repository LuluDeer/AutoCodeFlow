/**
 * 任务列表保存视图的筛选口径快照（纯类型 + 守卫 + 快照构造，无 React 依赖）。
 *
 * 快照内容：搜索词 + 三类筛选 + 分页口径；本页无服务端排序，故不含排序键。
 * 形状守卫用于信封坏值降级：非法条目在 useSavedViews 加载时逐条剔除。
 */

export interface TaskListViewFilters {
  q: string;
  status?: string;
  trigger?: string;
  lastStatus?: string;
  page: number;
  pageSize: number;
}

export function isTaskListViewFilters(f: unknown): f is TaskListViewFilters {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return false;
  const e = f as Record<string, unknown>;
  const optStr = (v: unknown) => v === undefined || typeof v === 'string';
  const posInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0;
  return (
    typeof e.q === 'string' &&
    optStr(e.status) &&
    optStr(e.trigger) &&
    optStr(e.lastStatus) &&
    posInt(e.page) &&
    posInt(e.pageSize)
  );
}

/** 当前筛选 / 分页输入（页面状态直出，快照前不需复制）。 */
export interface TaskFilterInputs {
  search: string;
  statusFilter: string | undefined;
  triggerFilter: string | undefined;
  lastStatusFilter: string | undefined;
  page: number;
  pageSize: number;
}

export function snapshotTaskFilters(inputs: TaskFilterInputs): TaskListViewFilters {
  return {
    q: inputs.search,
    status: inputs.statusFilter,
    trigger: inputs.triggerFilter,
    lastStatus: inputs.lastStatusFilter,
    page: inputs.page,
    pageSize: inputs.pageSize,
  };
}
