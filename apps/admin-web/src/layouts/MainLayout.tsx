import { useState } from 'react';
import { Layout, Menu, Button, Space, Typography, Breadcrumb } from 'antd';
import { Outlet, useNavigate, useLocation, Link } from 'react-router-dom';
import {
  UnorderedListOutlined,
  CloudServerOutlined,
  LogoutOutlined,
  TeamOutlined,
  DashboardOutlined,
  AppstoreOutlined,
  SettingOutlined,
  FileTextOutlined,
  BellOutlined,
  CodeOutlined,
  HistoryOutlined,
  UserOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  BookOutlined,
} from '@ant-design/icons';
import { useAuthStore } from '../store/auth';

const { Header, Sider, Content } = Layout;

// Maps path segments to human-readable labels
const PATH_LABELS: Record<string, string> = {
  dashboard: '数据看板',
  tasks: '任务管理',
  new: '新建任务',
  edit: '编辑',
  executions: '执行记录',
  executors: '执行器',
  users: '用户管理',
  registry: '包市场',
  applications: '应用管理',
  notification: '通知设置',
  settings: '系统设置',
  audit: '审计日志',
};

function buildBreadcrumbs(pathname: string) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length === 0) return [{ title: '数据看板', href: '/dashboard' }];

  const crumbs: { title: string; href?: string }[] = [];
  let accumulated = '';

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    accumulated += '/' + part;
    const label = PATH_LABELS[part];
    const isLast = i === parts.length - 1;

    if (label) {
      crumbs.push({ title: label, href: isLast ? undefined : accumulated });
    } else if (/^[0-9a-f-]{8,}$/i.test(part)) {
      // UUID — show as 'ID详情' for the parent context
      const parentLabel = crumbs[crumbs.length - 1]?.title ?? '';
      crumbs.push({ title: `${parentLabel}详情`, href: isLast ? undefined : accumulated });
    } else {
      crumbs.push({ title: part, href: isLast ? undefined : accumulated });
    }
  }

  return crumbs;
}

export default function MainLayout() {
  const nav = useNavigate();
  const loc = useLocation();
  const logout = useAuthStore((s) => s.logout);
  const user = useAuthStore((s) => s.user);
  const [collapsed, setCollapsed] = useState(false);

  const selectedKey = loc.pathname.startsWith('/executors')
    ? 'executors'
    : loc.pathname.startsWith('/users')
    ? 'users'
    : loc.pathname.startsWith('/registry')
    ? 'registry'
    : loc.pathname.startsWith('/settings')
    ? 'settings'
    : loc.pathname.startsWith('/notification')
    ? 'notification'
    : loc.pathname.startsWith('/audit')
    ? 'audit'
    : loc.pathname.startsWith('/applications')
    ? 'applications'
    : loc.pathname.startsWith('/executions')
    ? 'executions'
    : loc.pathname.startsWith('/tasks')
    ? 'tasks'
    : 'dashboard';

  const items = [
    { key: 'dashboard', icon: <DashboardOutlined />, label: '数据看板', onClick: () => nav('/dashboard') },
    { key: 'tasks', icon: <UnorderedListOutlined />, label: '任务管理', onClick: () => nav('/tasks') },
    { key: 'executors', icon: <CloudServerOutlined />, label: '执行器', onClick: () => nav('/executors') },
    { key: 'executions', icon: <HistoryOutlined />, label: '执行记录', onClick: () => nav('/executions') },
    { key: 'applications', icon: <CodeOutlined />, label: '应用管理', onClick: () => nav('/applications') },
    { key: 'registry', icon: <AppstoreOutlined />, label: '包市场', onClick: () => nav('/registry') },
    { key: 'notification', icon: <BellOutlined />, label: '通知设置', onClick: () => nav('/notification') },
    { key: 'users', icon: <TeamOutlined />, label: '用户管理', onClick: () => nav('/users') },
    { key: 'settings', icon: <SettingOutlined />, label: '系统设置', onClick: () => nav('/settings') },
    { key: 'audit', icon: <FileTextOutlined />, label: '审计日志', onClick: () => nav('/audit') },
  ];

  const doLogout = () => { logout(); nav('/login'); };

  const breadcrumbs = buildBreadcrumbs(loc.pathname);

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        theme="dark"
        width={200}
        collapsible
        collapsed={collapsed}
        trigger={null}
        breakpoint="md"
        onBreakpoint={(broken) => setCollapsed(broken)}
        collapsedWidth={0}
        style={{ overflow: 'auto', height: '100vh', position: 'sticky', top: 0, left: 0 }}
      >
        {!collapsed && (
          <div style={{ color: '#fff', fontSize: 16, fontWeight: 700, padding: '16px 24px', borderBottom: '1px solid #333', whiteSpace: 'nowrap', overflow: 'hidden' }}>
            AutoCodeFlow
          </div>
        )}
        <Menu theme="dark" mode="inline" selectedKeys={[selectedKey]} items={items} />
      </Sider>
      <Layout style={{ minWidth: 0 }}>
        <Header style={{
          background: '#fff',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingLeft: 16,
          paddingRight: 24,
          borderBottom: '1px solid #f0f0f0',
          position: 'sticky',
          top: 0,
          zIndex: 100,
        }}>
          <Space>
            <Button
              type="text"
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed(!collapsed)}
              style={{ fontSize: 16 }}
            />
            <Breadcrumb
              items={breadcrumbs.map((c) =>
                c.href
                  ? { title: <Link to={c.href}>{c.title}</Link> }
                  : { title: c.title }
              )}
            />
          </Space>
          <Space>
            {user && (
              <Space style={{ color: '#666' }}>
                <UserOutlined />
                <Typography.Text>{user.username}</Typography.Text>
              </Space>
            )}
            <Button
              icon={<BookOutlined />}
              type="text"
              href="/docs"
              target="_blank"
              rel="noopener noreferrer"
            >
              文档
            </Button>
            <Button icon={<LogoutOutlined />} onClick={doLogout}>退出</Button>
          </Space>
        </Header>
        <Content style={{ margin: 24, background: '#fff', padding: 24, borderRadius: 8, minWidth: 0, overflow: 'auto' }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
