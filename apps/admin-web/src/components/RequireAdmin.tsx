import type { ReactNode } from 'react';
import { Button, Result, Spin } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { useAuthStore, isAdminUser } from '../store/auth';
import { authApi } from '../api/auth';
import { getErrMsg } from '../utils/error';

/**
 * R5 RBAC 路由门控：包裹 ADMIN-only 路由（/executor-packages、/executors/install、
 * /audit、/users；R6 起新增 /notifications——通知渠道配置 GET/PATCH 收紧为 ADMIN），
 * 普通用户直接访问 URL 时渲染 403 提示页而非报错/白屏。
 *
 * role 来源：GET /auth/profile（登录响应只含 token，不含用户信息）。
 * role 尚未拉取到时显示加载态——MainLayout 的 profile 同步会补齐；
 * 仅在 role 确认非 admin 时才显示 403，避免管理员刷新时闪现 403。
 *
 * UX-07（本轮体验审查）：必须区分「加载中」与「加载失败」两种「role 未知」。
 * 此前只有转圈一种呈现，而 MainLayout 的 profile 同步是 `.catch(() => undefined)`
 * ——失败被完全吞掉。于是管理员刷新 /users、/audit 等页时若 profile 请求失败
 * （token 边缘态 / 网络抖动），页面**永久转圈**：既无 403、也无错误提示和重试
 * 按钮，只能手动改地址栏离开。现在失败时渲染错误态 + 重试（重发 profile），
 * 并给一条回 dashboard 的兜底出口。
 */
export default function RequireAdmin({ children }: { children: ReactNode }) {
  const nav = useNavigate();
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const profileError = useAuthStore((s) => s.profileError);
  const setUser = useAuthStore((s) => s.setUser);
  const setProfileError = useAuthStore((s) => s.setProfileError);

  // role 未知：可能是「仍在拉取」也可能是「拉取失败」——两者呈现必须不同。
  if (!user?.role) {
    if (profileError) {
      return (
        <Result
          status="warning"
          title={t('requireAdmin.profileFailTitle')}
          subTitle={profileError}
          extra={[
            <Button
              key="retry"
              type="primary"
              onClick={() => {
                // 清掉失败标记回到加载态，再重发一次 profile。
                setProfileError(null);
                authApi
                  .me()
                  .then((me) => setUser(me))
                  .catch((err: unknown) =>
                    setProfileError(getErrMsg(err, t('requireAdmin.profileFail'))),
                  );
              }}
            >
              {t('requireAdmin.retry')}
            </Button>,
            <Button key="back" onClick={() => nav('/dashboard', { replace: true })}>
              {t('requireAdmin.back')}
            </Button>,
          ]}
        />
      );
    }
    // 仍在拉取中
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
        subTitle={
          <>
            {/* P1-20（UX 审计）：403 页只说`仅管理员可见''却不告诉用户缺什么、找谁开通 */}
            {t('requireAdmin.subTitle')}
            <br />
            {t('requireAdmin.forbiddenHint')}
          </>
        }
        extra={
          <Button type="primary" onClick={() => nav('/dashboard', { replace: true })}>
            {t('requireAdmin.back')}
          </Button>
        }
      />
    );
  }

  return <>{children}</>;
}
