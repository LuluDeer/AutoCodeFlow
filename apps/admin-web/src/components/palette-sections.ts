/**
 * CommandPalette 的分组归并纯数据层（无 hook、无 setState、无跳转、无 JSX）。
 *
 * 从 CommandPalette.tsx 外提：分组归并是确定性派生数据，与交互状态解耦；
 * 组件体只保留请求编排、键盘导航与渲染。类型与空态常量一并落在这里，
 * 供组件与本文件双向复用，避免组件文件继续膨胀（体量棘轮：逐文件只许降）。
 */
import type { ReactNode } from 'react';
// P3-2（2026-10-26 审计）：执行记录行的开始时间此前裸 ISO 串（与全站格式
// 不一致），统一走共享 formatDateTime（locale 跟随 i18n）。
import { formatDateTime } from '../utils/timeFormat';
import type { Task, TaskExecution } from '../api/tasks';
import type { Executor } from '../api/executors';
import type { Application } from '../api/applications';

/** 每组最多展示条数（组内截断，不做虚拟滚动） */
export const MAX_PER_GROUP = 5;

type EntityKind = 'action' | 'page' | 'task' | 'execution' | 'executor' | 'application';
/** 有后端结果组的实体类型（action/page 为静态分组，不进 results） */
type EntityResultsKind = 'task' | 'execution' | 'executor' | 'application';

/** 分组渲染顺序：操作 → 管理页面 → 任务 → 执行记录 → 执行器 → 应用 */
const GROUP_ORDER: EntityKind[] = ['action', 'page', 'task', 'execution', 'executor', 'application'];

interface PaletteItem {
  key: string;
  id: string;
  title: string;
  description?: string;
  /** execution 跳转需要所属任务 id */
  taskId?: string;
  /** task 条目按 status 动态附带的行内动作键（触发/暂停/恢复） */
  actions?: TaskActionKind[];
}

/** UI-11 任务行内动作键 */
type TaskActionKind = 'trigger' | 'pause' | 'resume';

/** 静态动作（操作分组，始终可见） */
interface StaticAction {
  key: string;
  /** 与 PaletteItem.id 对齐，供扁平条目占位复用 */
  id: string;
  title: string;
  description: string;
  to?: string;
  /** admin-only 动作（写面后端全链 @Roles(ADMIN)，对齐 ApplicationListPage 门控） */
  adminOnly?: boolean;
  icon: ReactNode;
}

interface GroupResult<T> {
  status: 'idle' | 'loading' | 'ok' | 'error';
  items: T[];
}

interface SearchResults {
  task: GroupResult<Task>;
  execution: GroupResult<TaskExecution>;
  executor: GroupResult<Executor>;
  application: GroupResult<Application>;
}

interface Section {
  kind: EntityKind;
  items: PaletteItem[];
  /**
   * R195（P3-2）：本组**实际命中**的条数（截断**前**的真实数量）。
   * 与 `items.length` 的差 = 被 `.slice(0, MAX_PER_GROUP)` 截掉的部分 ⇒
   * 用来告诉用户「还剩多少、怎么找全」，避免把「只列 5 条」读成「**系统里就这么些**」。
   */
  total?: number;
  /** 静态动作分组专用（kind==='action' 时生效） */
  statics?: StaticAction[];
  offset: number;
}

const IDLE_RESULTS: SearchResults = {
  task: { status: 'idle', items: [] },
  execution: { status: 'idle', items: [] },
  executor: { status: 'idle', items: [] },
  application: { status: 'idle', items: [] },
};

const LOADING_RESULTS: SearchResults = {
  task: { status: 'loading', items: [] },
  execution: { status: 'loading', items: [] },
  executor: { status: 'loading', items: [] },
  application: { status: 'loading', items: [] },
};

/**
 * 把四路搜索结果 + 静态动作/页面导航收成渲染分组（纯计算：无 hook、无 setState、无跳转）。
 */
function computeSections(input: {
  results: SearchResults;
  kwLower: string;
  visibleActions: StaticAction[];
  pageNavActions: StaticAction[];
}): Section[] {
  const { results, kwLower, visibleActions, pageNavActions } = input;
  const contains = (s?: string | null) => !!s && s.toLowerCase().includes(kwLower);
  // R195（P3-2）：每组**命中数**（截断前）——`.slice` 之前先量一次，否则「被截掉多少」
  // 在渲染期就再也算不出来。`hit` 记下命中数并返回**截断后**的数组（四组共用一处实现）。
  const matched: Record<EntityKind, number> = { action: 0, page: 0, task: 0, execution: 0, executor: 0, application: 0 };
  const hit = <T,>(kind: EntityKind, arr: T[]): T[] => (matched[kind] = arr.length, arr.slice(0, MAX_PER_GROUP));
  const byKind: Record<EntityKind, PaletteItem[]> = {
    action: [],
    page: [],
    task: hit("task", results.task.items.filter((t) => contains(t.name) || contains(t.description)))
      .map((t) => ({
        key: `task-${t.id}`,
        id: t.id,
        title: t.name,
        description: [t.status, t.triggerType].filter(Boolean).join(' · '),
        // UI-11 行内动作：触发不限 status（对齐 TaskListPage 列表按钮）；
        // 暂停/恢复按 status 二选一（active→暂停，paused→恢复）
        actions:
          t.status === 'paused'
            ? ['trigger', 'resume']
            : ['trigger', 'pause'],
      })),
    execution: hit("execution", results.execution.items.filter((x) => contains(x.taskName) || contains(x.id)))
      .map((x) => ({
        key: `execution-${x.id}`,
        id: x.id,
        taskId: x.taskId,
        title: x.taskName || x.taskId,
        // P3-2：startTime 此前裸 ISO 串（如 `failed · 2026-10-25T15:35:00.014Z`），
        // 与全站时间格式不一致——统一 formatDateTime（locale 跟随 i18n）。
        description: [x.status, x.startTime ? formatDateTime(x.startTime) : null]
          .filter(Boolean)
          .join(' · '),
      })),
    executor: hit("executor", results.executor.items.filter((e) => contains(e.appName) || contains(e.address)))
      .map((e) => ({
        key: `executor-${e.id}`,
        id: e.id,
        title: e.appName,
        description: [e.address, e.status].filter(Boolean).join(' · '),
      })),
    application: hit("application", results.application.items.filter((a) => contains(a.name) || contains(a.description)))
      .map((a) => ({
        key: `application-${a.id}`,
        id: a.id,
        title: a.name,
        description: a.description || a.version,
      })),
  };
  let offset = 0;
  return GROUP_ORDER.map((kind) => {
    const section: Section = {
      kind,
      items: byKind[kind],
      // R195（P3-2）：命中数（截断前）——给「组内截断提示」用。
      total: matched[kind],
      // 操作分组 = 始终可见的主操作；管理页面分组 = 全部可达静态页面
      statics: kind === 'action' ? visibleActions : kind === 'page' ? pageNavActions : undefined,
      offset,
    };
    offset += byKind[kind].length;
    return section;
  });
}

export type {
  EntityKind,
  EntityResultsKind,
  PaletteItem,
  TaskActionKind,
  StaticAction,
  GroupResult,
  SearchResults,
  Section,
};
export { GROUP_ORDER, IDLE_RESULTS, LOADING_RESULTS, computeSections };
