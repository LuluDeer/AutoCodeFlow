import { passesFilter, type AppFilter, type AppSort, type FilterableGroup } from '../../apps-view';

export type AppEntry = {
  appId: string;
  appName: string | null;
  deploymentId: string;
  version: string | null;
  releaseKey: string;
  isCurrent: boolean;
  deployedAt: number | null;
  hasLog: boolean;
  logPath: string;
  deployDir: string;
  appRoot: string;
  runMode: string | null;
};

export type AppGroup = {
  appId: string;
  name: string | null;
  entries: AppEntry[];
  newestAt: number;
  current: AppEntry | null;
  runningCount: number;
  versionCount: number;
  hasName: boolean;
  hasCurrent: boolean;
  hasLog: boolean;
  nameMatches: boolean;
  matchedEntries: AppEntry[];
};

export type RunningMap = Record<string, { pid?: number; running?: boolean }>;
export type RunStatus = 'running' | 'scheduled' | 'stopped';
/** 运行态读取失败时的第四档：不是「已停止」，而是「不知道」。 */
export type DisplayRunStatus = RunStatus | 'unknown';

const APP_FILTERS: readonly AppFilter[] = [
  'all',
  'running',
  'hasCurrent',
  'noCurrent',
  'unnamed',
  'hasLog',
];

/** 从全量分组派生各筛选标签对应的应用数量（与 History 状态计数同口径）。 */
export function countAppFilters(groups: ReadonlyArray<FilterableGroup>): Record<AppFilter, number> {
  const counts: Record<AppFilter, number> = {
    all: groups.length,
    running: 0,
    hasCurrent: 0,
    noCurrent: 0,
    unnamed: 0,
    hasLog: 0,
  };
  for (const group of groups) {
    for (const filter of APP_FILTERS) {
      if (filter !== 'all' && passesFilter(group, filter)) {
        counts[filter] += 1;
      }
    }
  }
  return counts;
}

/** 部署时间行内显示；跨年时保留年份，避免旧版本看起来像今年部署。 */
export function formatDeployTime(ms: number | null): string {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  const year = d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}-`;
  return `${year}${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function runModeOf(group: AppGroup): string {
  return group.entries[0]?.runMode ?? '—';
}

export function groupStatus(group: AppGroup): RunStatus {
  if (group.runningCount > 0) return 'running';
  if (runModeOf(group) === 'scheduled') return 'scheduled';
  return 'stopped';
}

/** 列表副标题用的「模式 · 」前缀；无模式（null / '-' / '—'）时不渲染分隔符。 */
export function runModePrefix(group: AppGroup): string {
  const mode = group.entries[0]?.runMode?.trim();
  return mode && mode !== '-' && mode !== '—' ? `${mode} · ` : '';
}

/** 运行态未知时保守返回 null：未知 ≠ 没有可删版本。 */
export function firstDeletable(group: AppGroup, running: RunningMap, unknown = false): AppEntry | null {
  if (unknown) return null;
  return group.entries.find(entry =>
    entry.releaseKey
    && !entry.isCurrent
    && !running[entry.deploymentId]?.running,
  ) ?? null;
}

/**
 * T1：运行态读取失败 ≠ 全部停止。
 * unknown=true 时：不谎报「运行中」徽标、破坏性操作一律禁用、状态列显式
 * 显示「运行状态未知」（不冒充「已停止 / 定时」）。判定集中在此处，
 * 页面只消费结果，不复制第二套 unknown 分支。
 */
export interface RunningActionGate {
  unknown: boolean;
  isRunning(deploymentId: string): boolean;
  blockedByRunning(deploymentId: string): boolean;
  displayStatusOf(group: AppGroup): DisplayRunStatus;
}

export function runningActionGate(running: RunningMap, unknown: boolean): RunningActionGate {
  return {
    unknown,
    isRunning: (deploymentId) => !unknown && Boolean(running[deploymentId]?.running),
    blockedByRunning: (deploymentId) => unknown || Boolean(running[deploymentId]?.running),
    displayStatusOf: (group) => (unknown ? 'unknown' : groupStatus(group)),
  };
}

/** 删除动作的四态；前 3 态禁用，allowed 可执行。 */
export type DeleteActionReason = 'current' | 'running' | 'unknown' | 'allowed';

export interface DeleteActionInfo {
  reason: DeleteActionReason;
  disabled: boolean;
  /** title 用的双语键（三态禁用原因 + allowed） */
  titleKey: string;
  /** 不可用按钮/菜单项的短文案键；allowed 时调用方改用 deleteAria + 版本名 */
  labelKey: string;
}

/**
 * T1：删除动作的**单一口径**。抽屉内的版本行与表格 ⋯ 菜单共用本函数，
 * 避免两处对同一个禁用状态给出不同解释（例如一律写「当前版本不可删」，
 * 真实原因却是执行器仍在运行或运行态读取失败）。
 *
 * 判定优先级：current > unknown > running > allowed。unknown 必须排在
 * running 之前：`blockedByRunning()` 在读取失败时对所有 id 返回 true，
 * 若先看它会把「状态未知」误报成「运行中」。group 用于兜底同步——若
 * entry.isCurrent 与 group.current 漂移，以 group 的 current 指向为准。
 */
export function deleteActionInfo(
  entry: AppEntry | null,
  gate: RunningActionGate,
  group: AppGroup,
): DeleteActionInfo {
  // 表格 ⋯ 菜单没有具体版本（firstDeletable 返回 null）：按分组推断真正阻塞原因。
  // 优先 unknown——读取失败时任何「已停止」结论都不可信。
  if (!entry) {
    if (gate.unknown) {
      return {
        reason: 'unknown', disabled: true,
        titleKey: 'appx.deleteBlockedUnknown', labelKey: 'appx.deleteReason.unknownLabel',
      };
    }
    const runningBlocked = group.entries.some(e =>
      !e.isCurrent && gate.blockedByRunning(e.deploymentId));
    if (runningBlocked) {
      return {
        reason: 'running', disabled: true,
        titleKey: 'apps.deleteBlockedRunning', labelKey: 'appx.deleteReason.runningLabel',
      };
    }
    return {
      reason: 'current', disabled: true,
      titleKey: 'apps.deleteBlockedCurrent', labelKey: 'appx.deleteReason.currentLabel',
    };
  }
  const isCurrent = entry.isCurrent
    || Boolean(group.current && group.current.deploymentId === entry.deploymentId);
  if (isCurrent) {
    return {
      reason: 'current', disabled: true,
      titleKey: 'apps.deleteBlockedCurrent', labelKey: 'appx.deleteReason.currentLabel',
    };
  }
  if (gate.unknown) {
    return {
      reason: 'unknown', disabled: true,
      titleKey: 'appx.deleteBlockedUnknown', labelKey: 'appx.deleteReason.unknownLabel',
    };
  }
  if (gate.blockedByRunning(entry.deploymentId)) {
    return {
      reason: 'running', disabled: true,
      titleKey: 'apps.deleteBlockedRunning', labelKey: 'appx.deleteReason.runningLabel',
    };
  }
  return {
    reason: 'allowed', disabled: false,
    titleKey: 'apps.deleteAllowedTitle', labelKey: 'appx.deleteReason.allowedLabel',
  };
}

/**
 * T2：部署定位串——复制后粘到中台应用页即可精确定位这份部署。
 * 三字段缺一不可但都可以缺省（旧部署没有 version / 尚未发布没有 deploymentId），
 * 缺字段统一用破折号占位，绝不拼出 `undefined` / `null` 字面量。
 * 第二行是中台应用页 URL：base 只接受 http(s)，去掉 /api 后缀与尾斜杠，
 * appId 做 URI 编码；合法 base 且 deploymentId/version 为非空、非占位值时追加
 * `deploymentId`/`version` query key（值 encodeURIComponent），缺字段则不拼占位垃圾；
 * base 缺失或非法时只返回定位字段，不硬编码任何域名。
 */
export function formatDeployLocator(
  entry: Pick<AppEntry, 'appId' | 'deploymentId' | 'version'>,
  consoleBaseUrl?: string | null,
): string {
  const field = (value: string | null | undefined) =>
    typeof value === 'string' && value.trim() ? value.trim() : '—';
  const cleanedDeploymentId = field(entry.deploymentId);
  const cleanedVersion = field(entry.version);
  const lines = [
    `appId=${field(entry.appId)}`,
    `deploymentId=${cleanedDeploymentId}`,
    `version=${cleanedVersion}`,
  ];
  const base = typeof consoleBaseUrl === 'string'
    ? consoleBaseUrl.trim().replace(/\/+$/, '').replace(/\/api$/i, '')
    : '';
  if (/^https?:\/\//i.test(base)) {
    const query = ['tab=releases'];
    if (cleanedDeploymentId !== '—') {
      query.push(`deploymentId=${encodeURIComponent(cleanedDeploymentId)}`);
    }
    if (cleanedVersion !== '—') {
      query.push(`version=${encodeURIComponent(cleanedVersion)}`);
    }
    lines.push(`${base}/applications/${encodeURIComponent(entry.appId || '')}?${query.join('&')}`);
  }
  return lines.join('\n');
}

export function sortAriaOf(
  sortOrder: AppSort,
  col: 'app' | 'current' | 'versions' | 'status' | 'deployed',
): 'ascending' | 'descending' | 'none' {
  if (sortOrder === 'name' && col === 'app') return 'ascending';
  if (sortOrder === 'versions' && col === 'versions') return 'descending';
  if (sortOrder === 'recent' && col === 'deployed') return 'descending';
  if (sortOrder === 'running' && col === 'status') return 'descending';
  return 'none';
}

export function buildAppGroups(
  apps: ReadonlyArray<AppEntry>,
  running: RunningMap,
  tokens: ReadonlyArray<string>,
): AppGroup[] {
  const byId = new Map<string, AppEntry[]>();
  for (const entry of apps) {
    const entries = byId.get(entry.appId) ?? [];
    entries.push(entry);
    byId.set(entry.appId, entries);
  }
  return Array.from(byId, ([appId, unsorted]): AppGroup => {
    const entries = [...unsorted].sort((a, b) =>
      Number(b.isCurrent) - Number(a.isCurrent)
      || Number(Boolean(running[b.deploymentId]?.running)) - Number(Boolean(running[a.deploymentId]?.running))
      || (b.deployedAt ?? 0) - (a.deployedAt ?? 0),
    );
    const name = entries.find(entry => entry.appName)?.appName ?? null;
    const common = `${name ?? ''} ${appId} ${entries[0]?.appRoot ?? ''}`.toLocaleLowerCase();
    const nameMatches = tokens.every(token => common.includes(token));
    const matchedEntries = tokens.length && !nameMatches
      ? entries.filter(entry => {
        const searchable = `${common} ${entry.version ?? ''} ${entry.releaseKey} ${entry.deploymentId}`.toLocaleLowerCase();
        return tokens.every(token => searchable.includes(token));
      })
      : entries;
    const current = entries.find(entry => entry.isCurrent) ?? null;
    return {
      appId,
      name,
      entries,
      newestAt: entries.reduce((latest, entry) => Math.max(latest, entry.deployedAt ?? 0), 0),
      current,
      runningCount: entries.filter(entry => running[entry.deploymentId]?.running).length,
      versionCount: entries.filter(entry => Boolean(entry.releaseKey)).length,
      hasName: Boolean(name),
      hasCurrent: Boolean(current),
      hasLog: entries.some(entry => entry.hasLog),
      nameMatches,
      matchedEntries,
    };
  });
}
