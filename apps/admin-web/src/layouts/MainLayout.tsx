import { useState, useEffect } from 'react';
import { Layout, Menu, Avatar, Dropdown, Badge, Typography, Space, theme, Button, Breadcrumb, Tooltip } from 'antd';
import {
  DashboardOutlined,
  AppstoreOutlined,
  ThunderboltOutlined,
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
} from '@ant-design/icons';
import { Outlet, useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuthStore } from '../store/auth';

const { Header, Sider, Content } = Layout;
const { Text } = Typography;

const menuItems = [
  { key: '/dashboard', icon: <DashboardOutlined />, label: '控制台' },
  { key: '/applications', icon: <AppstoreOutlined />, label: '应用管理' },
  { key: '/tasks', icon: <ThunderboltOutlined />, label: '任务调度' },
  { key: '/executions', icon: <HistoryOutlined />, label: '执行记录' },
  { key: '/executors', icon: <ClusterOutlined />, label: '执行器' },
  { key: '/executor-packages', icon: <DatabaseOutlined />, label: '执行器包' },
  { key: '/registry', icon: <DatabaseOutlined />, label: '包注册中心' },
  {
    key: 'system',
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

export default function MainLayout() {
  const nav = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuthStore();
  const [collapsed, setCollapsed] = useState(false);
  const [currentTime, setCurrentTime] = useState(new Date());
  const { token } = theme.useToken();

  // 实时时钟
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const selectedKey = '/' + location.pathname.split('/')[1];

  // Build breadcrumb items from the current path
  const ROUTE_NAMES: Record<string, string> = {
    dashboard: '控制台',
    applications: '应用管理',
    tasks: '任务调度',
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
          <div style={{ fontSize: 12, color: '#8c8c8c' }}>{user?.role === 'admin' ? '管理员' : '普通用户'}</div>
        </div>
      ),
      disabled: true,
    },
    { type: 'divider' as const },
    {
      key: 'profile',
      icon: <UserOutlined />,
      label: '个人信息',
    },
    { type: 'divider' as const },
    {
      key: 'logout',
      icon: <LogoutOutlined />,
      label: '退出登录',
      danger: true,
    },
  ];

  const handleUserMenu = ({ key }: { key: string }) => {
    if (key === 'logout') {
      logout();
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
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        trigger={null}
        width={220}
        style={{
          background: token.colorBgContainer,
          borderRight: `1px solid ${token.colorBorderSecondary}`,
          boxShadow: '2px 0 8px rgba(0,0,0,0.04)',
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
              background: 'linear-gradient(135deg, #1677ff 0%, #7c3aed 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              boxShadow: '0 2px 8px rgba(22,119,255,0.3)',
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
          defaultOpenKeys={['system']}
          items={menuItemsWithTooltip}
          onClick={({ key }) => nav(key)}
          style={{ border: 'none', marginTop: 8 }}
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
            height: 56,
            position: 'sticky',
            top: 0,
            zIndex: 100,
            boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
          }}
        >
          <Space size={12}>
            {pathSegments.length > 1 && (
              <Breadcrumb items={breadcrumbItems} style={{ fontSize: 13 }} />
            )}
          </Space>

          <Space size={4}>
            {/* 时间显示 */}
            <div style={{ textAlign: 'right', marginRight: 8, lineHeight: 1.3 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: token.colorText }}>{timeStr}</div>
              <div style={{ fontSize: 11, color: token.colorTextSecondary }}>{dateStr}</div>
            </div>

            {/* 帮助按钮 */}
            <Tooltip title="帮助文档">
              <Button type="text" icon={<QuestionCircleOutlined />} style={{ fontSize: 16, color: token.colorTextSecondary }} />
            </Tooltip>

            {/* 通知按钮 */}
            <Tooltip title="通知">
              <Badge count={0} dot>
                <Button type="text" icon={<BellOutlined />} style={{ fontSize: 16 }} onClick={() => nav('/notifications')} />
              </Badge>
            </Tooltip>

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
                  style={{ background: 'linear-gradient(135deg, #1677ff, #7c3aed)', fontSize: 13, flexShrink: 0 }}
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
    </Layout>
  );
}
