/**
 * 执行记录保存视图的筛选口径快照（纯类型 + 守卫 + 快照 / 回填，无 React 依赖）。
 *
 * 快照内容：搜索词 + 四类筛选 + 时间区间 ISO + 分页口径；本页无服务端排序。
 * 时间区间以 ISO 串落快照，回填时由 dayjs 还原，非法时刻回落空区间（与深链口径一致）。
 */
import dayjs, { type Dayjs } from 'dayjs';

export interface ExecViewFilters {
  q: string;
  /** 逗号分隔的状态数组（导出/列表请求直接透传；空数组表示无筛选）。 */
  status?: string;
  executor: string;
  runtime?: string;
  triggerType?: string;
  startTime?: string;
  endTime?: string;
  page: number;
  pageSize: number;
}

export function isExecViewFilters(f: unknown): f is ExecViewFilters {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return false;
  const e = f as Record<string, unknown>;
  const optStr = (v: unknown) => v === undefined || typeof v === 'string';
  const posInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0;
  return (
    typeof e.q === 'string' &&
    optStr(e.status) &&
    typeof e.executor === 'string' &&
    optStr(e.runtime) &&
    optStr(e.triggerType) &&
    optStr(e.startTime) &&
    optStr(e.endTime) &&
    posInt(e.page) &&
    posInt(e.pageSize)
  );
}

/** 当前筛选 / 分页输入（页面状态直出，快照前不需复制）。 */
export interface ExecFilterInputs {
  search: string;
  statusFilter: string[] | undefined;
  executorFilter: string;
  runtimeFilter: string | undefined;
  triggerTypeFilter: string | undefined;
  timeRange: [Dayjs, Dayjs] | null;
  page: number;
  pageSize: number;
}

export function snapshotExecFilters(inputs: ExecFilterInputs): ExecViewFilters {
  return {
    q: inputs.search,
    status: inputs.statusFilter?.length ? inputs.statusFilter.join(',') : undefined,
    executor: inputs.executorFilter,
    runtime: inputs.runtimeFilter,
    triggerType: inputs.triggerTypeFilter,
    startTime: inputs.timeRange?.[0]?.toISOString(),
    endTime: inputs.timeRange?.[1]?.toISOString(),
    page: inputs.page,
    pageSize: inputs.pageSize,
  };
}

/** 回填视图口径所需的状态 setter（页面注入，模块不持有 React 状态）。 */
export interface ExecFilterSetters {
  setSearch: (v: string) => void;
  /** 接收已解析的状态数组（深链/视图快照写入统一传数组）。 */
  setStatusFilter: (v: string[] | undefined) => void;
  setExecutorFilter: (v: string) => void;
  setRuntimeFilter: (v: string | undefined) => void;
  setTriggerTypeFilter: (v: string | undefined) => void;
  setTimeRange: (v: [Dayjs, Dayjs] | null) => void;
  setPage: (v: number) => void;
  setPageSize: (v: number) => void;
}

/** 把快照口径回填到状态；时间区间任一时刻非法 → 空区间。 */
export function restoreExecFilters(setters: ExecFilterSetters, f: ExecViewFilters): void {
  setters.setSearch(f.q);
  setters.setStatusFilter(
    typeof f.status === 'string'
      ? f.status.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined,
  );
  setters.setExecutorFilter(f.executor);
  setters.setRuntimeFilter(f.runtime);
  setters.setTriggerTypeFilter(f.triggerType);
  const sd = f.startTime ? dayjs(f.startTime) : null;
  const ed = f.endTime ? dayjs(f.endTime) : null;
  setters.setTimeRange(sd && ed && sd.isValid() && ed.isValid() ? [sd, ed] : null);
  setters.setPage(f.page);
  setters.setPageSize(f.pageSize);
}
