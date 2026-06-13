import { useState } from 'react';
import { Layout, Menu, Avatar, Dropdown, Badge, Typography, Space, theme, Button, Breadcrumb } from 'antd';
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
  const { token } = theme.useToken();

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
          items={menuItems}
          onClick={({ key }) => nav(key)}
          style={{ border: 'none', marginTop: 8 }}
        />
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
            <Button
              type="text"
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed(!collapsed)}
              style={{ fontSize: 16 }}
            />
            {pathSegments.length > 1 && (
              <Breadcrumb items={breadcrumbItems} style={{ fontSize: 13 }} />
            )}
          </Space>

          <Space size={8}>
            <Badge count={0} dot>
              <Button type="text" icon={<BellOutlined />} style={{ fontSize: 16 }} />
            </Badge>

            <Dropdown
              menu={{ items: userMenuItems, onClick: handleUserMenu }}
              placement="bottomRight"
              trigger={['click']}
            >
              <Space style={{ cursor: 'pointer', padding: '4px 8px', borderRadius: 8 }}>
                <Avatar
                  size={30}
                  style={{ background: 'linear-gradient(135deg, #1677ff, #7c3aed)', fontSize: 13 }}
                >
                  {user?.username?.[0]?.toUpperCase() || 'U'}
                </Avatar>
                <Text style={{ fontSize: 13 }}>{user?.username || '用户'}</Text>
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
