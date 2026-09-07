import { useState } from 'react';
import type { FallbackProps } from 'react-error-boundary';
import { Button, Result, Space, Typography, message } from 'antd';
import { ReloadOutlined, CopyOutlined } from '@ant-design/icons';

const { Text } = Typography;

/**
 * 复制错误信息到剪贴板（UI-08 错误态标准动作之二）。
 * 优先 navigator.clipboard（需 secure context），失败降级到
 * document.execCommand('copy') 的隐藏 textarea 方案（http 内网部署场景），
 * 两路都失败时返回 false 由调用方提示。
 */
export async function copyErrorText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to legacy path
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * FE-02 全局渲染错误兜底（react-error-boundary FallbackComponent，main.tsx 挂载）。
 * UI-08 错误态标准化：统一「重试 + 复制错误信息」双动作——
 * 重试=resetErrorBoundary（重渲染错误边界内子树），复制=剪贴板写入错误堆栈
 * （便于值班截图/贴群排障）。样式消费 antd 组件（双主题由 ConfigProvider 承担）。
 */
export default function ErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  const [copied, setCopied] = useState(false);
  const err = error as Error | undefined;
  const errorText = [
    err?.message ?? '未知错误',
    err?.stack ?? '',
  ]
    .filter(Boolean)
    .join('\n');

  const handleCopy = async () => {
    const ok = await copyErrorText(errorText);
    if (ok) {
      setCopied(true);
      message.success('错误信息已复制到剪贴板');
      // 短暂回显「已复制」后恢复按钮文案
      setTimeout(() => setCopied(false), 2000);
    } else {
      message.error('复制失败，请手动截图错误信息');
    }
  };

  return (
    <Result
      status="error"
      title="页面出错了"
      subTitle={
        <Text type="secondary" style={{ fontSize: 12 }}>
          {err?.message ?? '未知错误'}
        </Text>
      }
      extra={
        <Space wrap>
          <Button type="primary" icon={<ReloadOutlined />} onClick={resetErrorBoundary}>
            重新加载
          </Button>
          <Button icon={copied ? undefined : <CopyOutlined />} onClick={handleCopy}>
            {copied ? '已复制' : '复制错误信息'}
          </Button>
        </Space>
      }
    />
  );
}
