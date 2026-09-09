import { useState, useEffect, type ReactNode } from 'react';
import { Layout, Menu, Avatar, Dropdown, Badge, Typography, Space, theme, Button, Breadcrumb, Tooltip } from 'antd';
import {
  DashboardOutlined,
  AppstoreOutlined,
  ThunderboltOutlined,
  FileTextOutlined,
  ClusterOutlined,
  HistoryOutlined,
  SettingOutlined,
  UserOutlined,
  LogoutOutlined,
  BellOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  AuditOutlined,
  DatabaseOutlined,
  HomeOutlined,
  QuestionCircleOutlined,
  SearchOutlined,
  SunOutlined,
  MoonOutlined,
  DesktopOutlined,
} from '@ant-design/icons';
import { Outlet, useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuthStore } from '../store/auth';
import { authApi } from '../api/auth';
import { logoutRemote } from '../api/logout';
import CommandPalette from '../components/CommandPalette';
import { useThemeStore } from '../theme/store';
import type { ThemeMode } from '../theme/store';

const { Header, Sider, Content } = Layout;
const { Text } = Typography;

// UI-03：折叠态与分组展开态持久化键（localStorage 直存——单布尔/字符串数组，
// 无需 zustand 重量级方案；key 命名对齐 autoflow-theme 惯例）
const SIDER_COLLAPSED_KEY = 'autoflow-sider-collapsed';
const MENU_OPEN_KEYS_KEY = 'autoflow-menu-open-keys';
// 默认展开「任务」「执行」两组（计划书指定），首次进入即见高频入口
const DEFAULT_OPEN_KEYS = ['g-tasks', 'g-executions'];

/** 读取持久化折叠态（非法值/缺席按未折叠处理） */
export function readCollapsedPreference(): boolean {
  try {
    return window.localStorage.getItem(SIDER_COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

/** 读取持久化分组展开键（过滤掉已不存在的分组键，防止 IA 调整后残留脏值） */
export function readMenuOpenKeys(validKeys: string[]): string[] {
  try {
    const raw = window.localStorage.getItem(MENU_OPEN_KEYS_KEY);
    if (!raw) return DEFAULT_OPEN_KEYS;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_OPEN_KEYS;
    const valid = new Set(validKeys);
    return parsed.filter((k): k is string => typeof k === 'string' && valid.has(k));
  } catch {
    return DEFAULT_OPEN_KEYS;
  }
}

// UI-02：主题三态切换按钮的图标/文案/aria 标签（light → dark → system 循环）
const THEME_BUTTON_META: Record<ThemeMode, { icon: ReactNode; label: string; aria: string }> = {
  light: { icon: <SunOutlined />, label: '亮色', aria: '切换主题（当前亮色，点击切换到暗色）' },
  dark: { icon: <MoonOutlined />, label: '暗色', aria: '切换主题（当前暗色，点击切换为跟随系统）' },
  system: { icon: <DesktopOutlined />, label: '跟随系统', aria: '切换主题（当前跟随系统，点击切换到亮色）' },
};

// UI-03：菜单分组结构（新导航 IA：概览/任务/执行/执行器/应用/系统）——
// 渲染时按角色过滤（R5 RBAC），分组键不带 '/'，页面键以路由开头。
// 分组用 antd Menu 的 submenu 形态（非 type:'group'），保证分组可折叠/展开并持久化。
const allMenuItems = [
  {
    key: 'g-overview',
    icon: <DashboardOutlined />,
    label: '概览',
    children: [{ key: '/dashboard', icon: <DashboardOutlined />, label: '控制台' }],
  },
  {
    key: 'g-tasks',
    icon: <ThunderboltOutlined />,
    label: '任务',
    children: [
      { key: '/tasks', icon: <ThunderboltOutlined />, label: '任务调度' },
      { key: '/task-templates', icon: <FileTextOutlined />, label: '任务模板' },
    ],
  },
  {
    key: 'g-executions',
    icon: <HistoryOutlined />,
    label: '执行',
    children: [{ key: '/executions', icon: <HistoryOutlined />, label: '执行记录' }],
  },
  {
    key: 'g-executors',
    icon: <ClusterOutlined />,
    label: '执行器',
    children: [
      { key: '/executors', icon: <ClusterOutlined />, label: '执行器列表' },
      { key: '/executor-packages', icon: <DatabaseOutlined />, label: '执行器包' },
    ],
  },
  {
    key: 'g-applications',
    icon: <AppstoreOutlined />,
    label: '应用',
    children: [
      { key: '/applications', icon: <AppstoreOutlined />, label: '应用管理' },
      { key: '/registry', icon: <DatabaseOutlined />, label: '包注册中心' },
    ],
  },
  {
    key: 'g-system',
    icon: <SettingOutlined />,
    label: '系统',
    children: [
      { key: '/users', icon: <UserOutlined />, label: '用户管理' },
      { key: '/notifications', icon: <BellOutlined />, label: '通知设置' },
      { key: '/audit', icon: <AuditOutlined />, label: '审计日志' },
      { key: '/settings', icon: <SettingOutlined />, label: '系统设置' },
    ],
  },
];

// ADMIN-only 菜单入口：普通用户不渲染（后端对应接口均 @Roles(ADMIN)）
// R6：/notifications 收紧——GET/PATCH /notification/channels 为 ADMIN-only
const ADMIN_ONLY_MENU_KEYS = new Set(['/executor-packages', '/audit', '/users', '/notifications']);

export default function MainLayout() {
  const nav = useNavigate();
  const location = useLocation();
  const { user, setUser } = useAuthStore();
  const isAdmin = user?.role === 'admin';
  // UI-03：折叠态持久化到 localStorage（跨会话记忆用户偏好）
  const [collapsed, setCollapsedState] = useState<boolean>(() => readCollapsedPreference());
  const setCollapsed = (v: boolean) => {
    setCollapsedState(v);
    try {
      window.localStorage.setItem(SIDER_COLLAPSED_KEY, String(v));
    } catch {
      /* 隐私模式等 localStorage 不可用时静默降级为会话内记忆 */
    }
  };
  const [currentTime, setCurrentTime] = useState(new Date());
  // FEAT-09: 全局命令面板（⌘K / Ctrl+K 唤起，头部搜索按钮同快捷键行为）
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { token } = theme.useToken();
  // UI-02：主题三态——mode 为用户意愿（按钮图标/文案随态变化）
  const themeMode = useThemeStore((s) => s.mode);
  const cycleThemeMode = useThemeStore((s) => s.cycleMode);
  const themeMeta = THEME_BUTTON_META[themeMode];

  // R5: 登录响应只含 token，role 需从 GET /auth/profile 补齐。
  // 覆盖两种场景：刚登录（store 里 user 为空）+ 旧 localStorage 会话（user 无 role）。
  useEffect(() => {
    if (!user?.role) {
      authApi
        .me()
        .then((me) => setUser(me))
        .catch(() => undefined);
    }
  }, [user?.role, setUser, user]);

  // 实时时钟
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // 按角色过滤菜单：ADMIN-only 项对普通用户隐藏（UI-03：顶层恒为分组，逐层过滤）。
  // R6 回归守卫：isAdmin 放行条件必须在分组化改造后保留——无条件过滤会把
  // 「通知设置/用户管理/审计日志/执行器包」对管理员一并藏掉（e2e-17 实证）。
  const menuItems = allMenuItems
    .map((group) => ({
      ...group,
      children: isAdmin
        ? group.children
        : group.children.filter((c) => !ADMIN_ONLY_MENU_KEYS.has(c.key)),
    }))
    .filter((group) => group.children.length > 0);



  // UI-03：分组折叠/展开持久化——受控 openKeys + onOpenKeys 回写 localStorage。
  // 初始值读持久化（残留脏键被 readMenuOpenKeys 过滤），否则默认展开任务/执行。
  const [openKeys, setOpenKeysState] = useState<string[]>(() => readMenuOpenKeys(menuItems.map((g) => g.key)));
  const setOpenKeys = (keys: string[]) => {
    setOpenKeysState(keys);
    try {
      window.localStorage.setItem(MENU_OPEN_KEYS_KEY, JSON.stringify(keys));
    } catch {
      /* localStorage 不可用时静默降级为会话内记忆 */
    }
  };

  // UI-09：移动端（≤768px）侧边栏抽屉态——纯 CSS 媒体查询承载（见 index.css），
  // 仅切换一个类名；桌面端 .mobile-sider-mask 恒 display:none，零影响。
  const [mobileSiderOpen, setMobileSiderOpen] = useState(false);
  // 路由变化后自动收起抽屉（手机选中菜单项即回到内容区）
  useEffect(() => {
    setMobileSiderOpen(false);
  }, [location.pathname]);

  const selectedKey = '/' + location.pathname.split('/')[1];

  // Build breadcrumb items from the current path
  const ROUTE_NAMES: Record<string, string> = {
    dashboard: '控制台',
    applications: '应用管理',
    tasks: '任务调度',
    'task-templates': '任务模板',
    executions: '执行记录',
    executors: '执行器',
    'executor-packages': '执行器包',
    registry: '包注册中心',
    users: '用户管理',
    notifications: '通知设置',
    audit: '审计日志',
    settings: '系统设置',
    install: '安装向导',
    new: '新建',
    edit: '编辑',
  };
  const pathSegments = location.pathname.split('/').filter(Boolean);
  const breadcrumbItems = [
    { title: <Link to="/dashboard"><HomeOutlined /></Link> },
    ...pathSegments.map((seg, idx) => {
      const isLast = idx === pathSegments.length - 1;
      const path = '/' + pathSegments.slice(0, idx + 1).join('/');
      const label = ROUTE_NAMES[seg] || (seg.length <= 12 ? seg : `${seg.slice(0, 8)}…`);
      return isLast
        ? { title: label }
        : { title: <Link to={path}>{label}</Link> };
    }),
  ];

  const userMenuItems = [
    {
      key: 'info',
      label: (
        <div style={{ padding: '4px 0' }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{user?.username || '用户'}</div>
          <div style={{ fontSize: 12, color: token.colorTextTertiary }}>{user?.role === 'admin' ? '管理员' : '普通用户'}</div>
        </div>
      ),
      disabled: true,
    },
    { type: 'divider' as const },
    // W8：已移除「个人信息」死项——handleUserMenu 只处理 logout，原条目点击无任何行为
    {
      key: 'logout',
      icon: <LogoutOutlined />,
      label: '退出登录',
      danger: true,
    },
  ];

  const handleUserMenu = async ({ key }: { key: string }) => {
    if (key === 'logout') {
      await logoutRemote();
      nav('/login');
    }
  };

  // 渲染带 tooltip 的菜单项（折叠时）
  const menuItemsWithTooltip = collapsed
    ? menuItems.map(item => ({
        ...item,
        label: <Tooltip placement="right" title={item.label}>{item.label}</Tooltip>,
        children: item.children?.map(child => ({
          ...child,
          label: <Tooltip placement="right" title={child.label}>{child.label}</Tooltip>,
        })),
      }))
    : menuItems;

  const timeStr = currentTime.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const dateStr = currentTime.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });

  return (
    // UI-09：mobile-sider-open 挂根 Layout——CSS 媒体查询据此滑入侧边栏并显示遮罩
    <Layout className={mobileSiderOpen ? 'mobile-sider-open' : undefined} style={{ minHeight: '100vh' }}>
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        trigger={null}
        width={220}
        style={{
          background: token.colorBgContainer,
          borderRight: `1px solid ${token.colorBorderSecondary}`,
          boxShadow: 'var(--shadow-sm)',
        }}
      >
        {/* Logo */}
        <div
          style={{
            height: 56,
            display: 'flex',
            alignItems: 'center',
            padding: collapsed ? '0 24px' : '0 20px',
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
            cursor: 'pointer',
            transition: 'padding 0.2s',
          }}
          onClick={() => nav('/dashboard')}
        >
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              // UI-01：强调色 #22C55E 渐变（MASTER.md Accent/CTA）
              background: 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              boxShadow: '0 2px 8px rgba(34, 197, 94, 0.3)',
            }}
          >
            <ThunderboltOutlined style={{ color: '#fff', fontSize: 14 }} />
          </div>
          {!collapsed && (
            <Text
              strong
              style={{ marginLeft: 10, fontSize: 15, color: token.colorText, whiteSpace: 'nowrap' }}
            >
              AutoCodeFlow
            </Text>
          )}
        </div>

        <Menu
          mode="inline"
          selectedKeys={[selectedKey]}
          openKeys={openKeys}
          onOpenChange={setOpenKeys}
          items={menuItemsWithTooltip}
          onClick={({ key }) => nav(key)}
          style={{ border: 'none', marginTop: 8, paddingBottom: 56 }}
        />

        {/* 侧边栏底部折叠按钮 */}
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: 48,
            display: 'flex',
            alignItems: 'center',
            justifyContent: collapsed ? 'center' : 'flex-end',
            padding: collapsed ? 0 : '0 16px',
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            cursor: 'pointer',
            transition: 'all 0.2s',
          }}
          onClick={() => setCollapsed(!collapsed)}
        >
          <Tooltip title={collapsed ? '展开菜单' : '收起菜单'} placement="right">
            <Button
              type="text"
              data-testid="sider-toggle"
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              style={{ fontSize: 15, color: token.colorTextSecondary }}
            />
          </Tooltip>
        </div>
      </Sider>

      <Layout>
        <Header
          style={{
            background: token.colorBgContainer,
            padding: '0 20px',
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            height: 56,
            position: 'sticky',
            top: 0,
            zIndex: 100,
            boxShadow: 'var(--shadow-sm)',
          }}
        >
          {/* UI-09：移动端汉堡入口（≤768px 显示，桌面 display:none）——
              手机值班场景侧边栏抽屉化后的唯一导航开关 */}
          <Button
            type="text"
            className="mobile-menu-toggle"
            aria-label="打开导航菜单"
            data-testid="mobile-menu-toggle"
            icon={mobileSiderOpen ? <MenuFoldOutlined /> : <MenuUnfoldOutlined />}
            onClick={() => setMobileSiderOpen((v) => !v)}
            style={{ fontSize: 18, color: token.colorTextSecondary }}
          />
          <Space size={12} className="header-breadcrumb">
            {pathSegments.length > 1 && (
              <Breadcrumb items={breadcrumbItems} style={{ fontSize: 13 }} />
            )}
          </Space>

          <Space size={4}>
            {/* 时间显示（UI-09：≤768px 隐藏——头部仅留高频操作按钮） */}
            <div className="header-time" style={{ textAlign: 'right', marginRight: 8, lineHeight: 1.3 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: token.colorText }}>{timeStr}</div>
              <div style={{ fontSize: 11, color: token.colorTextSecondary }}>{dateStr}</div>
            </div>

            {/* UI-02：明暗主题切换——light → dark → system 三态循环，
                图标随当前态变化，aria-label 随态更新（可达性） */}
            <Tooltip title={`主题：${themeMeta.label}（点击切换）`}>
              <Button
                type="text"
                icon={themeMeta.icon}
                aria-label={themeMeta.aria}
                data-testid="theme-toggle"
                style={{ fontSize: 16, color: token.colorTextSecondary }}
                onClick={cycleThemeMode}
              />
            </Tooltip>

            {/* FEAT-09: 全局搜索入口——点击行为与 ⌘K/Ctrl+K 一致（再按切换） */}
            <Tooltip title="Ctrl K">
              <Button
                type="text"
                icon={<SearchOutlined />}
                aria-label="全局搜索"
                style={{ fontSize: 16, color: token.colorTextSecondary }}
                onClick={() => setPaletteOpen((v) => !v)}
              />
            </Tooltip>

            {/* 帮助按钮 */}
            <Tooltip title="帮助文档">
              <Button type="text" icon={<QuestionCircleOutlined />} style={{ fontSize: 16, color: token.colorTextSecondary }} />
            </Tooltip>

            {/* 通知按钮：R6 起 /notifications 为 ADMIN-only（路由门控），
                对普通用户隐藏该快捷入口，避免点击后落入 403 页 */}
            {isAdmin && (
              <Tooltip title="通知">
                <Badge count={0} dot>
                  <Button type="text" icon={<BellOutlined />} style={{ fontSize: 16 }} onClick={() => nav('/notifications')} />
                </Badge>
              </Tooltip>
            )}

            {/* 用户头像下拉 */}
            <Dropdown
              menu={{ items: userMenuItems, onClick: handleUserMenu }}
              placement="bottomRight"
              trigger={['click']}
            >
              <Space
                style={{
                  cursor: 'pointer',
                  padding: '4px 8px',
                  borderRadius: 8,
                  transition: 'background 0.2s',
                }}
                className="user-dropdown-trigger"
              >
                <Avatar
                  size={30}
                  style={{ background: 'linear-gradient(135deg, #22c55e, #16a34a)', fontSize: 13, flexShrink: 0 }}
                >
                  {user?.username?.[0]?.toUpperCase() || 'U'}
                </Avatar>
                <div style={{ lineHeight: 1.3 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: token.colorText }}>{user?.username || '用户'}</div>
                  <div style={{ fontSize: 11, color: token.colorTextSecondary }}>{user?.role === 'admin' ? '管理员' : '普通用户'}</div>
                </div>
              </Space>
            </Dropdown>
          </Space>
        </Header>

        <Content
          style={{
            padding: '20px 24px',
            background: token.colorBgLayout,
            minHeight: 'calc(100vh - 56px)',
            overflow: 'auto',
          }}
        >
          <Outlet />
        </Content>
      </Layout>

      {/* FEAT-09: 全局命令面板——⌘K/Ctrl+K 或头部搜索按钮唤起 */}
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />

      {/* UI-09：移动端抽屉遮罩（≤768px 且抽屉展开时显示，点击收起） */}
      <div
        className="mobile-sider-mask"
        data-testid="mobile-sider-mask"
        onClick={() => setMobileSiderOpen(false)}
      />
    </Layout>
  );
}
