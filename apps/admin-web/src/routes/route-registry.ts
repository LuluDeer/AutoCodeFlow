/**
 * UX-AUDIT / NAV-UNIFY: 路由与角色的**单一事实源**。
 *
 * 侧栏、命令面板、路由守卫都从本模块的 ROUTES 派生：
 *   1. 页面是否存在（`ROUTES`）；
 *   2. 角色是否可见（`adminOnly`）；
 *   3. 是否出现在侧栏（`shellVisible`）；
 *   4. 是否出现在命令面板（`palette`）。
 *
 * 旧实现把 USER_SHELL_PATHS / ADMIN_SHELL_PATHS 另写一份 Set，命令面板只看
 * adminOnly，于是 USER 能从 ⌘K 跳到侧栏没有、进入后 403 的页面。现在
 * `paletteRoutes()` 与 `shellMenuRoutes()` 共用 `roleVisibleRoutes()` 这一个
 * 角色可见集合；确需「面板可达但侧栏不显」的页面，显式写 `shellVisible: []`，
 * 不再靠另一份隐藏 Set 表达。
 */
import type { ReactNode } from 'react';

export type Role = 'admin' | 'user';

/** 页面在侧栏/命令面板共享的一条描述（i18n key，渲染处用 t() 求值）。 */
export interface RouteDescriptor {
  /** 真实路由路径（与 router.tsx 的 path 一致）。 */
  path: string;
  /** 侧栏标签 i18n key。 */
  labelKey: string;
  /** 命令面板描述 i18n key（无侧栏文案时复用 labelKey）。 */
  descriptionKey: string;
  /** 图标节点（命令面板/侧栏共用，调用方传入以避免本模块依赖 antd 图标）。 */
  icon?: ReactNode;
  /** 是否登记为侧栏候选（最终仍由 shellVisible 决定）。 */
  sidebar: boolean;
  /** 是否出现在命令面板「管理页面」分组。 */
  palette: boolean;
  /** 是否仅管理员可见（侧栏过滤 + 命令面板过滤 + 路由守卫口径）。 */
  adminOnly: boolean;
  /**
   * 侧栏可见角色。省略 = 沿用 `sidebar`；`[]` = 面板可达但侧栏不显（显式声明，
   * 仅供产品确需深链入口的 ADMIN 页使用）；数组 = 仅列出的角色可见。
   * USER 的命令面板也消费它，确保「⌘K 可达」不超出「侧栏可见」。
   */
  shellVisible?: boolean | readonly Role[];
  /**
   * 追加的可见角色门槛（默认所有登录用户）。当前仅 adminOnly 在使用，
   * 保留字段便于未来「仅某项目角色可见」页面接入而不改消费方。
   */
  roles?: readonly Role[];
}

/** 全站页面注册表。顺序即命令面板/侧栏的默认展示顺序（分组由消费方决定）。 */
export const ROUTES: readonly RouteDescriptor[] = [
  { path: '/dashboard', labelKey: 'nav.dashboard', descriptionKey: 'palette.pageNav.dashboardDesc', sidebar: true, palette: true, adminOnly: false, shellVisible: ['admin'] },
  { path: '/tasks', labelKey: 'nav.tasks', descriptionKey: 'palette.pageNav.tasksDesc', sidebar: true, palette: true, adminOnly: false, shellVisible: ['admin'] },
  { path: '/task-templates', labelKey: 'nav.taskTemplates', descriptionKey: 'palette.pageNav.taskTemplatesDesc', sidebar: true, palette: true, adminOnly: false, shellVisible: ['admin'] },
  { path: '/artifacts', labelKey: 'nav.artifacts', descriptionKey: 'palette.pageNav.artifactsDesc', sidebar: true, palette: true, adminOnly: false, shellVisible: ['admin'] },
  { path: '/executions', labelKey: 'nav.executions', descriptionKey: 'palette.pageNav.executionsDesc', sidebar: true, palette: true, adminOnly: false },
  // UX-AUDIT：/inbox 对业务人员开放（只读），此前仅命令面板可见且误标 adminOnly，
  // 侧栏无入口 ⇒ ApprovalQueueCard 把用户引到「找不到」的页面。现在统一为全角色可见。
  { path: '/inbox', labelKey: 'inbox.title', descriptionKey: 'inbox.description', sidebar: true, palette: true, adminOnly: false },
  { path: '/executors', labelKey: 'nav.executors', descriptionKey: 'palette.pageNav.executorsDesc', sidebar: true, palette: true, adminOnly: false, shellVisible: ['admin'] },
  { path: '/executor-packages', labelKey: 'nav.executorPackages', descriptionKey: 'palette.pageNav.executorPackagesDesc', sidebar: true, palette: true, adminOnly: true },
  { path: '/applications', labelKey: 'nav.applications', descriptionKey: 'palette.pageNav.applicationsDesc', sidebar: true, palette: true, adminOnly: false, shellVisible: ['admin'] },
  { path: '/registry', labelKey: 'nav.registry', descriptionKey: 'palette.pageNav.registryDesc', sidebar: true, palette: true, adminOnly: false, shellVisible: ['admin'] },
  { path: '/users', labelKey: 'nav.users', descriptionKey: 'palette.pageNav.usersDesc', sidebar: true, palette: true, adminOnly: true },
  { path: '/projects', labelKey: 'nav.projects', descriptionKey: 'palette.pageNav.projectsDesc', sidebar: true, palette: true, adminOnly: false, shellVisible: ['admin'] },
  { path: '/audit', labelKey: 'nav.audit', descriptionKey: 'palette.pageNav.auditDesc', sidebar: true, palette: true, adminOnly: true },
  { path: '/capabilities', labelKey: 'nav.capabilities', descriptionKey: 'palette.pageNav.capabilitiesDesc', sidebar: true, palette: true, adminOnly: true },
  { path: '/activation-stats', labelKey: 'nav.activationStats', descriptionKey: 'palette.pageNav.activationStatsDesc', sidebar: true, palette: true, adminOnly: true, shellVisible: [] },
  { path: '/notifications', labelKey: 'nav.notifications', descriptionKey: 'palette.pageNav.notificationsDesc', sidebar: true, palette: true, adminOnly: true },
  { path: '/settings', labelKey: 'nav.settings', descriptionKey: 'palette.pageNav.settingsDesc', sidebar: true, palette: true, adminOnly: false },
  { path: '/sops', labelKey: 'nav.sops', descriptionKey: 'palette.pageNav.sopsDesc', sidebar: true, palette: true, adminOnly: true },
  { path: '/agent-sessions', labelKey: 'nav.agents', descriptionKey: 'palette.pageNav.agentsDesc', sidebar: true, palette: true, adminOnly: true },
  { path: '/workbench', labelKey: 'nav.workbench', descriptionKey: 'palette.pageNav.workbenchDesc', sidebar: true, palette: true, adminOnly: false },
  // 以下页面已上线但属于深链/向导页：面板显式标记 shellVisible: [] —— ADMIN 可达，
  // 侧栏不渲染重复入口；USER 由 adminOnly 直接挡在门外。
  { path: '/sops/from-video', labelKey: 'nav.fromVideo', descriptionKey: 'palette.pageNav.fromVideoDesc', sidebar: false, palette: true, adminOnly: true, shellVisible: [] },
  { path: '/executors/install', labelKey: 'nav.executorInstall', descriptionKey: 'palette.pageNav.executorInstallDesc', sidebar: false, palette: true, adminOnly: true, shellVisible: [] },
  // 动态段用 router.tsx 的 path 模式登记；palette=false（命令面板无法给出合法的 :id）。
  { path: '/tasks/:id/edit', labelKey: 'nav.taskEdit', descriptionKey: 'palette.pageNav.taskEditDesc', sidebar: false, palette: false, adminOnly: false },
];

/** 路径 → 描述符，便于按路径查角色门槛。 */
export const ROUTE_BY_PATH: ReadonlyMap<string, RouteDescriptor> = new Map(
  ROUTES.map((route) => [route.path, route]),
);

/** 判断一条路由是否仅管理员可见（未登记的路由按「可公开导航」处理）。 */
export function isAdminOnlyRoute(path: string): boolean {
  return ROUTE_BY_PATH.get(path)?.adminOnly === true;
}

/** 判断一条路由是否存在于注册表。 */
export function isKnownRoute(path: string): boolean {
  return ROUTE_BY_PATH.has(path);
}

/** 角色可见集合：侧栏与命令面板共用的唯一入口。 */
function roleVisibleRoutes(isAdmin: boolean): readonly RouteDescriptor[] {
  return ROUTES.filter((route) => route.roles
    ? route.roles.includes(isAdmin ? 'admin' : 'user')
    : (isAdmin || !route.adminOnly));
}

/** 侧栏可见性：省略 shellVisible 时沿用 sidebar；显式数组按角色判定。 */
function shellVisibleFor(route: RouteDescriptor, isAdmin: boolean): boolean {
  if (route.shellVisible === undefined) return route.sidebar;
  if (Array.isArray(route.shellVisible)) {
    return route.shellVisible.includes(isAdmin ? 'admin' : 'user');
  }
  return route.shellVisible && route.sidebar;
}

/** 侧栏可展示的路由（按角色过滤；调用方再按自定义分组决定渲染层级）。 */
export function menuRoutes(isAdmin: boolean): readonly RouteDescriptor[] {
  return roleVisibleRoutes(isAdmin).filter((route) => route.sidebar);
}

/** 命令面板可导航的路由：与侧栏共享角色可见集合，杜绝 USER 跳进 ADMIN 死路。 */
export function paletteRoutes(isAdmin: boolean): readonly RouteDescriptor[] {
  return roleVisibleRoutes(isAdmin).filter((route) =>
    route.palette && (isAdmin || shellVisibleFor(route, false)));
}

/** admin-only 路径集合（供仍在按 key 过滤的旧代码/测试对齐，避免再写死一份）。 */
export const ADMIN_ONLY_PATHS: ReadonlySet<string> = new Set(
  ROUTES.filter((route) => route.adminOnly).map((route) => route.path),
);

/** ADMIN 外壳分组（顺序即侧栏顺序；每组最多 3 项，空组由消费方跳过）。 */
export const ADMIN_SHELL_GROUPS: ReadonlyArray<{
  key: string;
  labelKey: string;
  paths: readonly string[];
}> = [
  { key: 'g-adm-work', labelKey: 'nav.group.tasks', paths: ['/tasks', '/task-templates', '/dashboard'] },
  { key: 'g-adm-delivery', labelKey: 'nav.group.assist', paths: ['/executions', '/artifacts', '/inbox'] },
  { key: 'g-adm-nodes', labelKey: 'nav.group.executors', paths: ['/executors', '/executor-packages', '/applications'] },
  { key: 'g-adm-gov', labelKey: 'nav.group.gov', paths: ['/users', '/projects', '/audit'] },
  { key: 'g-adm-system', labelKey: 'nav.group.system', paths: ['/capabilities', '/notifications', '/settings'] },
];

/** 按角色返回真正渲染在侧栏的路由集合。 */
export function shellMenuRoutes(isAdmin: boolean): readonly RouteDescriptor[] {
  return roleVisibleRoutes(isAdmin).filter((route) => shellVisibleFor(route, isAdmin));
}

/** 首页按角色落到各自默认工作台（role 尚未补齐时按非 ADMIN 安全处理）。 */
export function homePathForRole(role: string | undefined): string {
  return role === 'admin' ? '/dashboard' : '/workbench';
}
