/**
 * Apps 页（运行台账）的纯函数：筛选、排序、头像色相。
 *
 * 抽成无 React 依赖的模块，便于单测与审阅；AppEntry/AppGroup 的完整类型
 * 仍在 AppsPage.tsx（那里有 IPC 窄接口与字段注释），本模块只依赖结构子集。
 */

export type AppFilter = 'all' | 'running' | 'hasCurrent' | 'noCurrent' | 'unnamed' | 'hasLog';
export type AppSort = 'recent' | 'name' | 'versions' | 'running';

/**
 * appId → 0..5 的确定性色相。同一应用在任何一次渲染/重启后都是同一种颜色，
 * 让表格在扫读时能靠颜色快速定位；未知名称应用仍走中性灰（不参与哈希）。
 */
export function avatarTone(appId: string): number {
  let hash = 0;
  for (let i = 0; i < appId.length; i += 1) {
    hash = (hash * 31 + appId.charCodeAt(i)) >>> 0;
  }
  return hash % 6;
}

export interface FilterableGroup {
  runningCount: number;
  hasCurrent: boolean;
  hasName: boolean;
  hasLog: boolean;
}

/** 分组是否通过当前筛选。搜索命中与否由调用方先判定。 */
export function passesFilter(group: FilterableGroup, filter: AppFilter): boolean {
  switch (filter) {
    case 'running':
      return group.runningCount > 0;
    case 'hasCurrent':
      return group.hasCurrent;
    case 'noCurrent':
      return !group.hasCurrent;
    case 'unnamed':
      return !group.hasName;
    case 'hasLog':
      return group.hasLog;
    default:
      return true;
  }
}

export interface SortableGroup {
  appId: string;
  name: string | null;
  newestAt: number;
  versionCount: number;
  runningCount: number;
}

function compareName(a: SortableGroup, b: SortableGroup): number {
  return (a.name ?? a.appId).localeCompare(b.name ?? b.appId, 'zh-CN');
}

/** 台账排序：运行中优先 → 最近部署 → 版本数 → 名称（同名次序稳定）。 */
export function compareGroups(a: SortableGroup, b: SortableGroup, sort: AppSort): number {
  switch (sort) {
    case 'name':
      return compareName(a, b);
    case 'versions':
      return b.versionCount - a.versionCount
        || b.newestAt - a.newestAt
        || compareName(a, b);
    case 'running':
      return b.runningCount - a.runningCount
        || b.newestAt - a.newestAt
        || compareName(a, b);
    default:
      return b.newestAt - a.newestAt || compareName(a, b);
  }
}
