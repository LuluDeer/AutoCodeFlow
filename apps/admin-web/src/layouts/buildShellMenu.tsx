import type { ReactNode } from 'react';
import {
  AppstoreOutlined,
  AuditOutlined,
  BellOutlined,
  ClusterOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  HistoryOutlined,
  MailOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  UserOutlined,
} from '@ant-design/icons';
import {
  ADMIN_SHELL_GROUPS,
  shellMenuRoutes,
  type RouteDescriptor,
} from '../routes/route-registry';

export interface MenuLeaf {
  key: string;
  icon: ReactNode;
  label: string;
}

export interface MenuGroup {
  key: string;
  label: string;
  children: MenuLeaf[];
}

export type MenuEntry = MenuLeaf | MenuGroup;

const ROUTE_ICON: Readonly<Record<string, ReactNode>> = {
  '/dashboard': <DashboardOutlined />,
  '/tasks': <ThunderboltOutlined />,
  '/task-templates': <FileTextOutlined />,
  '/artifacts': <FolderOpenOutlined />,
  '/executions': <HistoryOutlined />,
  '/inbox': <MailOutlined />,
  '/executors': <ClusterOutlined />,
  '/executor-packages': <DatabaseOutlined />,
  '/applications': <AppstoreOutlined />,
  '/registry': <DatabaseOutlined />,
  '/users': <UserOutlined />,
  '/projects': <TeamOutlined />,
  '/audit': <AuditOutlined />,
  '/capabilities': <SafetyCertificateOutlined />,
  '/activation-stats': <DashboardOutlined />,
  '/notifications': <BellOutlined />,
  '/settings': <SettingOutlined />,
  '/sops': <FileTextOutlined />,
  '/agent-sessions': <RobotOutlined />,
  '/workbench': <AppstoreOutlined />,
};

/**
 * 角色化侧栏：USER 为四个平级入口；ADMIN 为固定五个域，低频页通过
 * 命令面板可达但不在侧栏再开单子项分组。分组标签复用既有 nav.group.* 词条。
 */
export function buildShellMenu(
  t: (key: string) => string,
  isAdmin: boolean,
): MenuEntry[] {
  const routes = shellMenuRoutes(isAdmin);
  if (!isAdmin) {
    return routes.map((route) => leaf(route, t));
  }

  const byPath = new Map(routes.map((route) => [route.path, route]));
  const groupedPaths = new Set(ADMIN_SHELL_GROUPS.flatMap((group) => group.paths));
  const items: MenuEntry[] = [];
  // 非分组入口（ADMIN 的 /workbench）先渲染，保证工作台处于侧栏顶部。
  for (const route of routes) {
    if (!groupedPaths.has(route.path)) items.push(leaf(route, t));
  }
  for (const group of ADMIN_SHELL_GROUPS) {
    const children = group.paths
      .map((path) => byPath.get(path))
      .filter((route): route is RouteDescriptor => !!route)
      .map((route) => leaf(route, t));
    if (children.length) {
      items.push({ key: group.key, label: t(group.labelKey), children });
    }
  }
  return items;
}

function leaf(route: RouteDescriptor, t: (key: string) => string): MenuLeaf {
  return {
    key: route.path,
    icon: ROUTE_ICON[route.path] ?? <AppstoreOutlined />,
    label: t(route.labelKey),
  };
}
