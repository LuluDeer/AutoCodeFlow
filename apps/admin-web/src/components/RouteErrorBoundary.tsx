import { useState } from 'react';
import { useRouteError, isRouteErrorResponse } from 'react-router-dom';
import { Button, Result, Space, Typography } from 'antd';
import { message } from '../utils/toast';
import { ReloadOutlined, CopyOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { copyText } from '../utils/clipboard';
import '../i18n';

const { Text } = Typography;

/**
 * 懒加载 chunk 拉取失败判定（NETOPT-4，发版后旧 hash 场景）：
 * 浏览器把旧页面缓存的 <script> hash 指到已删除的 chunk，动态 import 即抛错。
 * 已知形态：Vite 原生 ESM 在 Chrome 报 "Failed to fetch dynamically exported
 * module"、Safari 报 "Importing a module script failed"；webpack 生态报
 * "Loading chunk N failed"。按三类已知形态匹配，未匹配形态走普通错误兜底。
 */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed|dynamically imported module/i.test(
    error.message,
  );
}

/**
 * F-45（UIUX 审计 P2-3）：离线探测。
 *
 * chunk 拉取失败有两种截然不同的成因：① 发版后旧 hash（在线，刷新即恢复）；
 * ② 网络断开（离线，刷新不可能成功——把「应用已发布新版本」当文案只会误导
 * 用户反复刷新）。`navigator.onLine` 是同步可用的第一道判据（错误边界的渲染
 * 是同步的，异步 fetch 探测插不进分支）；它对「有网但被墙」会误报在线，方向
 * 安全——最坏情况回落到「版本已更新」的既有文案。真机断网场景已实证分流正确。
 */
export function isOfflineNow(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/**
 * NETOPT-4 路由级错误兜底（react-router 7 data router errorElement）。
 * 此前全部路由无 errorElement：页面级错误落 react-router 内部默认边界，
 * 渲染英文调试页 "Unexpected Application Error"（含 stack，对最终用户不可读）；
 * main.tsx 的 ErrorBoundary 包在 RouterProvider 外层，接不到路由内部错误。
 *
 * chunk 失效分支按在线性细分（F-45）：
 * - 在线（发版后旧 hash）→ 「版本已更新，请刷新」提示 + 刷新按钮（自助恢复）；
 * - 离线 → 「网络连接已断开」提示 + 重试按钮（网络恢复后重试生效）；
 * - 其它错误 → 复用 ErrorFallback 的形态与 i18n 键（错误信息 + 重载 + 复制）。
 */
export default function RouteErrorBoundary() {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const error = useRouteError();

  if (isChunkLoadError(error)) {
    // F-45：断网时刷新不可能拉到任何 chunk——把网络故障当发版提示是误导
    // （真机审计：offline 断网切页 → 全屏「应用已发布新版本…刷新页面」）。
    // navigator.onLine=false 时改报「网络连接已断开」，恢复网络后点重试重载。
    const offline = isOfflineNow();
    return (
      <Result
        status="warning"
        // 键保持静态字面量三元（i18n 静态键守卫可判），不做 t(变量) 动态取键
        title={offline ? t('routerError.offlineTitle') : t('routerError.chunkTitle')}
        subTitle={
          <Text type="secondary" style={{ fontSize: 12 }}>
            {offline ? t('routerError.offlineDesc') : t('routerError.chunkDesc')}
          </Text>
        }
        extra={
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            onClick={() => window.location.reload()}
          >
            {offline ? t('routerError.offlineRetry') : t('routerError.refresh')}
          </Button>
        }
      />
    );
  }

  let messageText = t('errorFallback.unknownError');
  if (isRouteErrorResponse(error)) {
    messageText = `${error.status} ${error.statusText ?? ''}`.trim();
  } else if (error instanceof Error) {
    messageText = error.message;
  }
  const errorText = [
    messageText,
    error instanceof Error ? (error.stack ?? '') : '',
  ]
    .filter(Boolean)
    .join('\n');

  const handleCopy = async () => {
    const ok = await copyText(errorText);
    if (ok) {
      setCopied(true);
      message.success(t('errorFallback.copySuccess'));
      // 短暂回显「已复制」后恢复按钮文案
      setTimeout(() => setCopied(false), 2000);
    } else {
      message.error(t('errorFallback.copyFailed'));
    }
  };

  return (
    <Result
      status="error"
      title={t('errorFallback.title')}
      subTitle={
        <Text type="secondary" style={{ fontSize: 12 }}>
          {messageText}
        </Text>
      }
      extra={
        <Space wrap>
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            onClick={() => window.location.reload()}
          >
            {t('errorFallback.reload')}
          </Button>
          <Button icon={copied ? undefined : <CopyOutlined />} onClick={handleCopy}>
            {copied ? t('errorFallback.copied') : t('errorFallback.copy')}
          </Button>
        </Space>
      }
    />
  );
}
