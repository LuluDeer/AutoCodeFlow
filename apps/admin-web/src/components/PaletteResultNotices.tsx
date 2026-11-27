/**
 * UX-AUDIT / PALETTE-HONESTY: 命令面板的「结果诚实」提示。
 *
 * 1. 候选池截断：tasks 后端只回前 50、executions 前 20 条，早先静默截断，
 *    用户把「搜不到」误读成「系统里没有」。现在显式告知 + 指向完整列表。
 * 2. 分组加载失败：原状态只有一行灰字，无重试入口；现在给一个「重试」按钮，
 *    重新触发该组请求（由父组件传入 retry 回调 + retry 序号）。
 *
 * 外提为独立组件是为了守住 CommandPalette.tsx 的 check:size-caps 棘轮。
 */
import { Button, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import '../i18n';

const { Text } = Typography;

export interface PaletteCandidateTruncationProps {
  /** 候选池总命中数（服务端 total）。 */
  total: number;
  /** 本组已取回的候选数。 */
  shown: number;
  /** 指向完整列表的链接（带 query 预填）。 */
  href: string;
  label: string;
}

export function PaletteCandidateTruncation({ total, shown, href, label }: PaletteCandidateTruncationProps) {
  const { t } = useTranslation();
  if (!total || total <= shown) return null;
  return (
    <Text type="secondary" style={{ display: 'block', padding: '4px 8px', fontSize: 12 }}>
      {t('palette.candidateTruncated', { shown, total })}{' '}
      <a href={href}>{label}</a>
    </Text>
  );
}

export interface PaletteRetryProps {
  onRetry: () => void;
}

export function PaletteRetry({ onRetry }: PaletteRetryProps) {
  const { t } = useTranslation();
  return (
    <Button
      type="link"
      size="small"
      data-testid="palette-retry"
      onClick={(e) => { e.stopPropagation(); onRetry(); }}
      style={{ padding: '0 8px', fontSize: 12 }}
    >
      {t('palette.retry')}
    </Button>
  );
}
