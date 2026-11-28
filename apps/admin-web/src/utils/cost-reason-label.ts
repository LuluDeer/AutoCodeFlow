/**
 * 后端 PriceReason（apps/admin-api .../price.dto.ts）五种值 → 本地化文案的
 * **读面唯一事实源**。历史上定义在 dashboard/CostPostureCard.tsx 内，因
 * ActivationStatsPage（用量页）也要消费同一映射而抽到 utils——驾驶舱瘦身
 * （task-13 切片 C1）后 CostPostureCard 不再上驾驶舱屏，但组件文件因用量页
 * 与驾驶舱测试仍需标缺语义而保留。
 *
 * 未登记的原因码（含前端哨兵 READ_FAILED / UNKNOWN 与后端未来新增值）
 * 原样回退——保持可诊断，不伪装成已知原因，也不渲染空串。
 */
type Translate = import('i18next').TFunction;

export function costReasonLabel(reason: string, t: Translate): string {
  switch (reason) {
    case 'OK':
      return t('costReason.OK');
    case 'NO_TOKEN_SAMPLE':
      return t('costReason.NO_TOKEN_SAMPLE');
    case 'PRICE_MISSING':
      return t('costReason.PRICE_MISSING');
    case 'INVALID_TOKEN_COUNT':
      return t('costReason.INVALID_TOKEN_COUNT');
    case 'INVALID_PRICE':
      return t('costReason.INVALID_PRICE');
    default:
      return reason;
  }
}
