import type { ReactNode } from 'react';
import { Button, Result, Spin } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useAuthStore, isAdminUser } from '../store/auth';

/**
 * R5 RBAC 路由门控：包裹 ADMIN-only 路由（/executor-packages、/executors/install、
 * /audit、/users），普通用户直接访问 URL 时渲染 403 提示页而非报错/白屏。
 *
 * role 来源：GET /auth/profile（登录响应只含 token，不含用户信息）。
 * role 尚未拉取到时显示加载态——MainLayout 的 profile 同步会补齐；
 * 仅在 role 确认非 admin 时才显示 403，避免管理员刷新时闪现 403。
 */
export default function RequireAdmin({ children }: { children: ReactNode }) {
  const nav = useNavigate();
  const user = useAuthStore((s) => s.user);

  // role 未知：profile 仍在拉取中（或拉取失败），先显示加载态
  if (!user?.role) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }

  if (!isAdminUser(user)) {
    return (
      <Result
        status="403"
        title="403"
        subTitle="抱歉，您没有权限访问该页面，此页面仅管理员可见。"
        extra={
          <Button type="primary" onClick={() => nav('/dashboard', { replace: true })}>
            返回控制台
          </Button>
        }
      />
    );
  }

  return <>{children}</>;
}
