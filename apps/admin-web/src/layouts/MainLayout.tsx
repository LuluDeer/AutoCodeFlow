import { Layout, Menu, Button } from 'antd';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
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
} from '@ant-design/icons';
import { useAuthStore } from '../store/auth';

const { Header, Sider, Content } = Layout;

export default function MainLayout() {
  const nav = useNavigate();
  const loc = useLocation();
  const logout = useAuthStore((s) => s.logout);

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
    : loc.pathname.startsWith('/tasks')
    ? 'tasks'
    : 'dashboard';

  const items = [
    { key: 'dashboard', icon: <DashboardOutlined />, label: '数据看板', onClick: () => nav('/dashboard') },
    { key: 'tasks', icon: <UnorderedListOutlined />, label: '任务管理', onClick: () => nav('/tasks') },
    { key: 'executors', icon: <CloudServerOutlined />, label: '执行器', onClick: () => nav('/executors') },
    { key: 'users', icon: <TeamOutlined />, label: '用户管理', onClick: () => nav('/users') },
    { key: 'registry', icon: <AppstoreOutlined />, label: '包市场', onClick: () => nav('/registry') },
    { key: 'applications', icon: <CodeOutlined />, label: '应用管理', onClick: () => nav('/applications') },
    { key: 'notification', icon: <BellOutlined />, label: '通知设置', onClick: () => nav('/notification') },
    { key: 'settings', icon: <SettingOutlined />, label: '系统设置', onClick: () => nav('/settings') },
    { key: 'audit', icon: <FileTextOutlined />, label: '审计日志', onClick: () => nav('/audit') },
  ];

  const doLogout = () => { logout(); nav('/login'); };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider theme="dark" width={200}>
        <div style={{ color: '#fff', fontSize: 18, fontWeight: 700, padding: '16px 24px', borderBottom: '1px solid #333' }}>AutoFlow</div>
        <Menu theme="dark" mode="inline" selectedKeys={[selectedKey]} items={items} />
      </Sider>
      <Layout>
        <Header style={{ background: '#fff', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', paddingRight: 24 }}>
          <Button icon={<LogoutOutlined />} onClick={doLogout}>退出</Button>
        </Header>
        <Content style={{ margin: 24, background: '#fff', padding: 24, borderRadius: 8 }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
