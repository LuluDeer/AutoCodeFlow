/**
 * UX-AUDIT：登录页 SSO 可用性检测（公开端点），失败给提示 + 重试入口。
 * 从 LoginPage 外提是因为该函数体已顶到 check:size-caps 的天花板（324 行），
 * SSO 探测与登录表单正交，独立成 hook 更清晰。
 */
import { useCallback, useEffect, useState } from 'react';
import { message } from '../utils/toast';
import { useTranslation } from 'react-i18next';
import { authApi } from '../api/auth';
import '../i18n';

export interface UseSsoStatusResult {
  enabled: boolean;
  checkFailed: boolean;
  retry: () => void;
}

export function useSsoStatus(): UseSsoStatusResult {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    authApi
      .oidcStatus()
      .then((r) => { setEnabled(!!r.enabled); setCheckFailed(false); })
      .catch(() => {
        // UX-AUDIT：此前静默移除 SSO 入口，用户既不知道检测失败也没有重试路径。
        setEnabled(false);
        setCheckFailed(true);
        message.warning(t('login.ssoCheckFailed'));
      });
  }, [t, retryToken]);

  const retry = useCallback(() => setRetryToken((n) => n + 1), []);

  return { enabled, checkFailed, retry };
}
