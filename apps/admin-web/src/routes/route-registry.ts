/**
 * UX-AUDIT / NAV-UNIFY: 路由与角色的**单一事实源**。
 *
 * 历史上「侧边栏可见性」（MainLayout 内自持的 ADMIN_ONLY_MENU_KEYS）与
 * 「命令面板可达性」（CommandPalette 内逐项手写的 adminOnly 标志）各写一份，
 * 两边对 /artifacts、/inbox 的判断长期不一致；于是出现
 * 「侧栏能点、命令面板搜不到」或「命令面板有入口、跳转后撞 403」的死路。
 *
 * 本模块把三件事收在一处：
 *   1. 路由是否存在（`ROUTES`）；
 *   2. 能否出现在侧边栏（`sidebar: true` 且通过 `visibleInMenu` 过滤）；
 *   3. 能否通过命令面板打开（`palette: true`）；
 *   4. 是否 admin-only（`adminOnly`）。
 *
 * 渲染层只消费派生集合（isAdminOnlyRoute / menuRoutes / paletteRoutes），
 * 不再各自维护 Set 或布尔标志。新增页面时只改这里一处。
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
  /** 是否出现在侧边栏菜单。 */
  sidebar: boolean;
  /** 是否出现在命令面板「管理页面」分组。 */
  palette: boolean;
  /** 是否仅管理员可见（侧栏过滤 + 命令面板过滤 + 路由守卫口径）。 */
  adminOnly: boolean;
  /**
   * 追加的可见角色门槛（默认所有登录用户）。当前仅 adminOnly 在使用，
   * 保留字段便于未来「仅某项目角色可见」页面接入而不改消费方。
   */
  roles?: readonly Role[];
}

/**
 * 全站页面注册表。顺序即命令面板/侧栏的默认展示顺序（分组由消费方决定）。
 */
export const ROUTES: readonly RouteDescriptor[] = [
  { path: '/dashboard', labelKey: 'nav.dashboard', descriptionKey: 'palette.pageNav.dashboardDesc', sidebar: true, palette: true, adminOnly: false },
  { path: '/tasks', labelKey: 'nav.tasks', descriptionKey: 'palette.pageNav.tasksDesc', sidebar: true, palette: true, adminOnly: false },
  { path: '/task-templates', labelKey: 'nav.taskTemplates', descriptionKey: 'palette.pageNav.taskTemplatesDesc', sidebar: true, palette: true, adminOnly: false },
  { path: '/artifacts', labelKey: 'nav.artifacts', descriptionKey: 'palette.pageNav.artifactsDesc', sidebar: true, palette: true, adminOnly: false },
  { path: '/executions', labelKey: 'nav.executions', descriptionKey: 'palette.pageNav.executionsDesc', sidebar: true, palette: true, adminOnly: false },
  // UX-AUDIT：/inbox 对业务人员开放（只读），此前仅命令面板可见且误标 adminOnly，
  // 侧栏无入口 ⇒ ApprovalQueueCard 把用户引到「找不到」的页面。现在统一为全角色可见。
  { path: '/inbox', labelKey: 'inbox.title', descriptionKey: 'inbox.description', sidebar: true, palette: true, adminOnly: false },
  { path: '/executors', labelKey: 'nav.executors', descriptionKey: 'palette.pageNav.executorsDesc', sidebar: true, palette: true, adminOnly: false },
  { path: '/executor-packages', labelKey: 'nav.executorPackages', descriptionKey: 'palette.pageNav.executorPackagesDesc', sidebar: true, palette: true, adminOnly: true },
  { path: '/applications', labelKey: 'nav.applications', descriptionKey: 'palette.pageNav.applicationsDesc', sidebar: true, palette: true, adminOnly: false },
  { path: '/registry', labelKey: 'nav.registry', descriptionKey: 'palette.pageNav.registryDesc', sidebar: true, palette: true, adminOnly: false },
  { path: '/users', labelKey: 'nav.users', descriptionKey: 'palette.pageNav.usersDesc', sidebar: true, palette: true, adminOnly: true },
  { path: '/projects', labelKey: 'nav.projects', descriptionKey: 'palette.pageNav.projectsDesc', sidebar: true, palette: true, adminOnly: false },
  { path: '/audit', labelKey: 'nav.audit', descriptionKey: 'palette.pageNav.auditDesc', sidebar: true, palette: true, adminOnly: true },
  { path: '/capabilities', labelKey: 'nav.capabilities', descriptionKey: 'palette.pageNav.capabilitiesDesc', sidebar: true, palette: true, adminOnly: true },
  { path: '/activation-stats', labelKey: 'nav.activationStats', descriptionKey: 'palette.pageNav.activationStatsDesc', sidebar: true, palette: true, adminOnly: true },
  { path: '/notifications', labelKey: 'nav.notifications', descriptionKey: 'palette.pageNav.notificationsDesc', sidebar: true, palette: true, adminOnly: true },
  { path: '/settings', labelKey: 'nav.settings', descriptionKey: 'palette.pageNav.settingsDesc', sidebar: true, palette: true, adminOnly: false },
  { path: '/sops', labelKey: 'nav.sops', descriptionKey: 'palette.pageNav.sopsDesc', sidebar: true, palette: true, adminOnly: true },
  { path: '/agent-sessions', labelKey: 'nav.agents', descriptionKey: 'palette.pageNav.agentsDesc', sidebar: true, palette: true, adminOnly: true },
  { path: '/workbench', labelKey: 'nav.workbench', descriptionKey: 'palette.pageNav.workbenchDesc', sidebar: true, palette: true, adminOnly: false },
  // 以下页面已上线但属于深链/向导页：进注册表是为了让角色判定与面包屑名称
  // 与侧栏、命令面板共用同一份事实源；sidebar=false 避免侧栏出现重复入口。
  { path: '/sops/from-video', labelKey: 'nav.fromVideo', descriptionKey: 'palette.pageNav.fromVideoDesc', sidebar: false, palette: true, adminOnly: true },
  { path: '/executors/install', labelKey: 'nav.executorInstall', descriptionKey: 'palette.pageNav.executorInstallDesc', sidebar: false, palette: true, adminOnly: true },
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

/** 侧栏可展示的路由（按角色过滤；调用方再按自定义分组决定渲染层级）。 */
export function menuRoutes(isAdmin: boolean): readonly RouteDescriptor[] {
  return ROUTES.filter((r) => r.sidebar && (isAdmin || !r.adminOnly));
}

/** 命令面板可导航的路由（按角色过滤）。 */
export function paletteRoutes(isAdmin: boolean): readonly RouteDescriptor[] {
  return ROUTES.filter((r) => r.palette && (isAdmin || !r.adminOnly));
}

/** admin-only 路径集合（供仍在按 key 过滤的旧代码/测试对齐，避免再写死一份）。 */
export const ADMIN_ONLY_PATHS: ReadonlySet<string> = new Set(
  ROUTES.filter((r) => r.adminOnly).map((r) => r.path),
);

/**
 * IA-ROLE：角色化导航外壳的单一事实源。
 *
 * `menuRoutes` 仍保留「全部已登记的非隐藏页面」，供既有契约/命令面板校验；
 * 侧栏渲染消费 `shellMenuRoutes`：USER 只暴露四个一级入口（无单子分组），
 * ADMIN 收敛为五个域，低频管理页藏在分组/命令面板而不是删路由。
 */
const USER_SHELL_PATHS: ReadonlySet<string> = new Set([
  '/workbench',
  '/executions',
  '/inbox',
  '/settings',
]);

/** ADMIN 外壳分组（顺序即侧栏顺序；每组最多 3 项，空组由消费方跳过）。 */
export const ADMIN_SHELL_GROUPS: ReadonlyArray<{
  key: string;
  labelKey: string;
  paths: readonly string[];
}> = [
  { key: 'g-adm-work', labelKey: 'nav.group.tasks', paths: ['/tasks', '/task-templates', '/dashboard'] },
  { key: 'g-adm-delivery', labelKey: 'nav.group.assist', paths: ['/executions', '/artifacts', '/inbox'] },
  { key: 'g-adm-nodes', labelKey: 'nav.group.executors', paths: ['/executors', '/executor-packages', '/applications'] },
  { key: 'g-adm-gov', labelKey: 'nav.group.org', paths: ['/users', '/projects', '/audit'] },
  { key: 'g-adm-system', labelKey: 'nav.group.gov', paths: ['/capabilities', '/notifications', '/settings'] },
];

const ADMIN_SHELL_PATHS: ReadonlySet<string> = new Set([
  '/workbench',
  ...ADMIN_SHELL_GROUPS.flatMap((group) => group.paths),
]);

/** 按角色返回真正渲染在侧栏的路由集合。 */
export function shellMenuRoutes(isAdmin: boolean): readonly RouteDescriptor[] {
  if (isAdmin) {
    return ROUTES.filter((r) => r.sidebar && ADMIN_SHELL_PATHS.has(r.path));
  }
  return ROUTES.filter((r) => r.sidebar && USER_SHELL_PATHS.has(r.path));
}

/** 首页按角色落到各自默认工作台（role 尚未补齐时按非 ADMIN 安全处理）。 */
export function homePathForRole(role: string | undefined): string {
  return role === 'admin' ? '/dashboard' : '/workbench';
}
