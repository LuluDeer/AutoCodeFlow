import { Space, Typography, Button, message } from 'antd';
import { CopyOutlined, ReloadOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useThemeStore, selectResolvedTheme } from '../theme/store';
import { LIGHT_TOKENS, DARK_TOKENS } from '../theme/tokens';
import { copyErrorText } from './ErrorFallback';
import '../i18n';

const { Text } = Typography;

export interface StateErrorProps {
  /** 错误对象或任意 unknown（useRequest/React Query 的 error 字段直接透传） */
  error: unknown;
  /** 重试回调（刷新当前查询/请求），不传则不渲染重试按钮 */
  onRetry?: () => void;
  /** 自定义标题（默认「加载失败」） */
  title?: string;
  /** 居中展示（默认 false=块级左对齐，嵌入页内任意位置） */
  centered?: boolean;
  style?: React.CSSProperties;
}

/**
 * UI-08 页内错误态标准块：Alert 形态 + 「重试 + 复制错误信息」双动作。
 * 与 ErrorBoundary 的整页 ErrorFallback（Result 形态）分层：页内数据请求失败
 * 不必炸整页，用本组件在页内原位呈现并给重试入口。
 * 样式消费 antd 组件 + theme tokens（双主题跟随）。
 */
export default function StateError({
  error,
  onRetry,
  title,
  centered = false,
  style,
}: StateErrorProps) {
  const { t } = useTranslation();
  const resolvedTitle = title ?? t('stateError.loadingFailed');
  const dark = useThemeStore(selectResolvedTheme) === 'dark';
  const border = dark ? DARK_TOKENS.border : LIGHT_TOKENS.border;
  const textSecondary = dark ? DARK_TOKENS.textSecondary : LIGHT_TOKENS.textSecondary;

  const msg =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : t('stateError.requestFailed');

  const handleCopy = async () => {
    const ok = await copyErrorText(msg);
    if (ok) message.success(t('stateError.copySuccess'));
    else message.error(t('stateError.copyFailed'));
  };

  return (
    <div
      role="alert"
      data-testid="state-error"
      style={{
        padding: 24,
        textAlign: centered ? 'center' : 'left',
        border: `1px solid ${border}`,
        borderRadius: 8,
        background: dark ? DARK_TOKENS.muted : LIGHT_TOKENS.muted,
        ...style,
      }}
    >
      <Text type="danger" strong style={{ display: 'block', marginBottom: 4 }}>
        {resolvedTitle}
      </Text>
      <Text type="secondary" style={{ fontSize: 12, wordBreak: 'break-all' }}>
        {msg}
      </Text>
      {(onRetry || msg) && (
        <Space style={{ marginTop: 12, display: centered ? 'flex' : undefined, justifyContent: centered ? 'center' : undefined }} wrap>
          {onRetry && (
            <Button size="small" icon={<ReloadOutlined />} onClick={onRetry}>
              {t('stateError.retry')}
            </Button>
          )}
          <Button size="small" icon={<CopyOutlined />} onClick={handleCopy}>
            {t('stateError.copy')}
          </Button>
        </Space>
      )}
      {/* textSecondary 消费点标记（防止空指针样式失联）：currentColor 占位 */}
      <span style={{ color: textSecondary, display: 'none' }} aria-hidden="true" />
    </div>
  );
}
