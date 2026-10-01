import { useEffect, useRef, useState } from 'react';
import { Button, Card, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore, type AuthUser } from '../store/auth';
import { authApi } from '../api/auth';
import '../i18n';

const { Title, Text } = Typography;

const ERROR_HINTS: Record<string, string> = {
  state_invalid: 'sso.error.state',
  nonce_invalid: 'sso.error.nonce',
  signature_invalid: 'sso.error.signature',
  account_not_linked: 'sso.error.notLinked',
  account_disabled: 'sso.error.disabled',
  missing: 'sso.error.missing',
};

/** 后端 OIDC 回调对 IdP 侧错误的重定向约定：#error=idp_error:<原始码>（oidc.controller.ts fail）。 */
export const IDP_ERROR_PREFIX = 'idp_error:';

/**
 * 常见 OAuth2/OIDC IdP 错误码 → 指引文案。未列出的码（Keycloak/Okta 等私有码）
 * 走 generic 兜底并附原始码，运维可据此检索 IdP 日志。
 */
const IDP_ERROR_HINTS: Record<string, string> = {
  access_denied: 'sso.error.idp.accessDenied',
  login_required: 'sso.error.idp.loginRequired',
  interaction_required: 'sso.error.idp.interactionRequired',
  consent_required: 'sso.error.idp.consentRequired',
  invalid_scope: 'sso.error.idp.invalidScope',
  server_error: 'sso.error.idp.serverError',
  temporarily_unavailable: 'sso.error.idp.unavailable',
};

export interface ErrorHint {
  key: string;
  params?: Record<string, unknown>;
}

/**
 * 稳定错误码 → i18n key。已知平台码直取；idp_error: 前缀提取原始 IdP 错误码
 * 按常见码映射；未知码回退 generic 并把原始码作为插值参数透出。
 */
export function resolveErrorHint(errorCode: string): ErrorHint {
  const stable = ERROR_HINTS[errorCode];
  if (stable) return { key: stable };
  if (errorCode.startsWith(IDP_ERROR_PREFIX)) {
    const raw = errorCode.slice(IDP_ERROR_PREFIX.length).trim();
    const mapped = raw ? IDP_ERROR_HINTS[raw] : undefined;
    if (mapped) return { key: mapped };
    if (raw) return { key: 'sso.error.idpUnknown', params: { code: raw } };
  }
  return { key: 'sso.error.generic' };
}

/**
 * AUTH-04：OIDC 回调落地页（/auth/sso/complete）。
 *
 * 后端 /auth/oidc/callback 完成换码/验签/建号后 302 回本页，token 放在
 * URL #fragment（浏览器不发送 fragment——不进服务器/代理日志）。本页解析
 * fragment → 写入 auth store → 跳 dashboard；#error= 分支展示稳定错误码
 * 对应的指引文案（不展示原始错误，避免泄露内部细节）。
 */
export default function SsoCompletePage() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [error, setError] = useState<string | null>(null);
  const handledRef = useRef(false);

  useEffect(() => {
    // React StrictMode 双跑 effect：fragment 消费必须幂等（useRef 门闩）
    if (handledRef.current) return;
    handledRef.current = true;

    const fragment = window.location.hash.startsWith('#')
      ? window.location.hash.slice(1)
      : '';
    const params = new URLSearchParams(fragment);
    const errorCode = params.get('error');
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    const username = params.get('username') ?? '';

    // 无论成功失败，fragment 一旦消费即从地址栏抹掉（防历史记录/剪贴板残留）
    window.history.replaceState(null, '', window.location.pathname);

    if (errorCode) {
      setError(errorCode);
      return;
    }
    if (!accessToken || !refreshToken) {
      setError('missing');
      return;
    }

    // 与本地登录同款：token 入 store；profile 拉取失败不阻塞进入
    //（MainLayout 的既有 profile 兜底会处理 401）
    const user: AuthUser = { id: 0, username };
    setAuth(accessToken, refreshToken, user);
    authApi
      .me()
      .then((me) => setAuth(accessToken, refreshToken, { ...user, ...me }))
      .catch(() => undefined);
    nav('/dashboard', { replace: true });
  }, [nav, setAuth, t]);

  const hintInfo = error ? resolveErrorHint(error) : null;
  const hint = hintInfo ? t(hintInfo.key, hintInfo.params) : '';
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px 16px',
      }}
    >
      <Card style={{ width: '100%', maxWidth: 420, textAlign: 'center' }} role="status">
        <Title level={4} style={{ margin: '0 0 12px' }}>{t('sso.title')}</Title>
        {error ? (
          <>
            <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>{hint}</Text>
            <Button type="primary" onClick={() => nav('/login', { replace: true })}>
              {t('sso.backToLogin')}
            </Button>
          </>
        ) : (
          <Text type="secondary">{t('sso.completing')}</Text>
        )}
      </Card>
    </div>
  );
}
