/**
 * R62（§7.17 P3 收尾）：**「后端计数自相矛盾」提示的唯一渲染点**。
 *
 * R59 在详情页落地了提示，R62 发现**列表页**是同类盲区（表格列与卡片都直接取
 * `runningTaskCount` 原始值）。为了让两处「按同一个判据、说同一句话」，把提示抽成
 * 本组件：
 *
 * · 判据来自 `utils/executor-metrics.ts::hasInconsistentMetrics`（**不复制逻辑**，
 *   归一化与 `resolveRunningCount` 同源：非有限 ⇒ 0、负数钳 0、null = 未上报 ⇒ false）；
 * · 文案共用 `executorMetrics.inconsistent`（含具体数字）+ `.tip`（成因与排查方向），
 *   两页逐字一致——同一现象在列表与详情给出不同措辞，等于制造新的不一致。
 *
 * 两种形态（同一语义，不同密度）：
 * · `tag`  —— 卡片/详情这类有横向余量的位置，整句 + 图标；
 * · `icon` —— 表格单元格这类窄列，仅警示图标，整句进 Tooltip 与 aria-label
 *   （读屏可读到完整句子，不因列宽被牺牲）。
 *
 * 判据不成立时返回 `null`：调用方无需自己写 `&&`，避免出现「判据在这里、渲染在
 * 那里」的错位（那正是本任务要消灭的那类不一致）。
 */
import { Tag, Tooltip, theme } from 'antd';
import { WarningOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';

import { hasInconsistentMetrics } from '../../utils/executor-metrics';

export interface InconsistentMetricsTagProps {
  /** 已占槽位（含 E-01 取件预留）= `runningTaskCount`。 */
  occupiedSlots: number;
  /** 执行器上报的预留槽位数（null/undefined = 旧版执行器未上报）。 */
  reservedSlots: number | null | undefined;
  /** 展示形态：`tag`（卡片/详情）或 `icon`（表格窄列）。默认 `tag`。 */
  variant?: 'tag' | 'icon';
}

export default function InconsistentMetricsTag({
  occupiedSlots,
  reservedSlots,
  variant = 'tag',
}: InconsistentMetricsTagProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();

  // 判据单一来源（R59 已建立）：不成立 ⇒ 不渲染，调用方无需再判。
  if (!hasInconsistentMetrics(occupiedSlots, reservedSlots)) return null;

  const label = t('executorMetrics.inconsistent', { reserved: reservedSlots, occupied: occupiedSlots });
  const tip = t('executorMetrics.inconsistent.tip');

  if (variant === 'icon') {
    return (
      <Tooltip title={tip}>
        {/* aria-label 挂整句：表格列宽只够放图标，读屏用户不该因此丢失信息。 */}
        <WarningOutlined aria-label={label} style={{ color: token.colorWarning, marginInlineStart: 4 }} />
      </Tooltip>
    );
  }

  return (
    <Tooltip title={tip}>
      <Tag color="warning" icon={<WarningOutlined aria-hidden="true" />} style={{ marginTop: 8, whiteSpace: 'normal' }}>
        {label}
      </Tag>
    </Tooltip>
  );
}
