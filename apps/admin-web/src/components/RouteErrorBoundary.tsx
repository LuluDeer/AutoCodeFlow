import { useState } from 'react';
import { useRouteError, isRouteErrorResponse } from 'react-router-dom';
import { Button, Result, Space, Typography, message } from 'antd';
import { ReloadOutlined, CopyOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { copyErrorText } from './ErrorFallback';
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
 * NETOPT-4 路由级错误兜底（react-router 7 data router errorElement）。
 * 此前全部路由无 errorElement：页面级错误落 react-router 内部默认边界，
 * 渲染英文调试页 "Unexpected Application Error"（含 stack，对最终用户不可读）；
 * main.tsx 的 ErrorBoundary 包在 RouterProvider 外层，接不到路由内部错误。
 *
 * 两分支：
 * - 懒加载 chunk 失效 → 「版本已更新，请刷新」提示 + 刷新按钮（用户可自助恢复）；
 * - 其它错误 → 复用 ErrorFallback 的形态与 i18n 键（错误信息 + 重载 + 复制）。
 */
export default function RouteErrorBoundary() {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const error = useRouteError();

  if (isChunkLoadError(error)) {
    return (
      <Result
        status="warning"
        title={t('routerError.chunkTitle')}
        subTitle={
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('routerError.chunkDesc')}
          </Text>
        }
        extra={
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            onClick={() => window.location.reload()}
          >
            {t('routerError.refresh')}
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
    const ok = await copyErrorText(errorText);
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
