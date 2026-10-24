import { useState } from 'react';
import type { FallbackProps } from 'react-error-boundary';
import { Button, Result, Space, Typography } from 'antd';
import { message } from '../utils/toast';
// react-refresh 收官：复制降级逻辑曾以 copyErrorText 名义在本文件重复实现
// （与 utils/clipboard.copyText 功能等价），为消除 only-export-components
// 告警统一并到 F-18 封装——本文件回归纯组件导出，fast-refresh 边界恢复。
import { copyText } from '../utils/clipboard';
import { ReloadOutlined, CopyOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import '../i18n';

const { Text } = Typography;

/**
 * FE-02 全局渲染错误兜底（react-error-boundary FallbackComponent，main.tsx 挂载）。
 * UI-08 错误态标准化：统一「重试 + 复制错误信息」双动作——
 * 重试=resetErrorBoundary（重渲染错误边界内子树），复制=剪贴板写入错误堆栈
 * （便于值班截图/贴群排障）。样式消费 antd 组件（双主题由 ConfigProvider 承担）。
 */
export default function ErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const err = error as Error | undefined;
  const errorText = [
    err?.message ?? t('errorFallback.unknownError'),
    err?.stack ?? '',
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
          {err?.message ?? t('errorFallback.unknownError')}
        </Text>
      }
      extra={
        <Space wrap>
          <Button type="primary" icon={<ReloadOutlined />} onClick={resetErrorBoundary}>
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
