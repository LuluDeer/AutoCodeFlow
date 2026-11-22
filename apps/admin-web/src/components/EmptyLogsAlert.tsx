/**
 * R284-LOGPURGE-01：日志区为空时的**三态**空态卡片。
 *
 * ## 为什么必须有三态（而不是一条「切日志级别」）
 *
 * 日志行留 `logRetention.days`（默认 30 天），执行行留 90 天 ⇒ 翻 31~90 天前的
 * 执行详情，日志区是一个空 `<pre>`。此前唯一的提示讲的是「切日志级别」，于是
 * 用户读成「这条执行没输出 / 采集坏了」，复盘里写「没有证据」——**真相是证据
 * 已按策略删除**。这三条文案是**三个不同的事实**，不可互相替代：
 *
 * | 态 | 事实 | 用户该做什么 |
 * |---|---|---|
 * | `purged`  | 已按保留期清理（带截止时刻） | 调保留期，或接受「证据已删」 |
 * | `empty`   | 本次确实没有输出 | 查任务逻辑/派发（不是数据丢失） |
 * | `unknown` | 判不出来（读失败/后端无该字段） | 先刷新重试，别下结论 |
 *
 * ## 为什么单独成组件
 *
 * 渲染函数已在体量上限（`check:size-caps` 的 functionLines 棘轮）——这三张卡片
 * 与日志渲染毫无关系，只是「把三态照出来」。抽出来顺带让三态文案有**单一出口**：
 * 断言三态互不相同只需针对本文件，不必穿过整个日志子系统。
 */
import { Alert } from 'antd';
import type { TFunction } from 'i18next';
import type { EmptyLogsVerdict } from '../hooks/useEmptyLogsVerdict';
// 清理截止时刻按全仓统一口径格式化（调用方无需再传，避免每个调用点各接一次）
import { formatDateTime } from '../utils/timeFormat';

export interface EmptyLogsAlertProps {
  verdict: EmptyLogsVerdict;
  /** 翻译函数（不在此处引 i18n 单例——由调用方注入，便于测试固定语言） */
  t: TFunction;
  /** 清理截止时刻的格式化（缺省用 `formatDateTime`；测试可注入固定实现） */
  formatAt?: (iso: string) => string;
}

/** 三态各自的 data-testid（与测试共用同一常量，避免字面量各写一份）。 */
const EMPTY_LOGS_TESTID = {
  purged: 'log-empty-purged',
  empty: 'log-empty-no-output',
  unknown: 'log-empty-unknown',
} as const;

export default function EmptyLogsAlert({
  verdict,
  t,
  formatAt = formatDateTime,
}: EmptyLogsAlertProps) {
  // `null` = 尚未/无需判定（有日志、运行中）⇒ 什么都不挂，避免误报。
  if (!verdict) return null;

  if (verdict.state === 'purged') {
    return (
      <Alert
        type="warning"
        showIcon
        data-testid={EMPTY_LOGS_TESTID.purged}
        title={t('execDetail.log.purgedTitle')}
        description={t('execDetail.log.purgedDesc', {
          at: verdict.at
            ? formatAt(verdict.at)
            : t('execDetail.log.purgedAtUnknown'),
        })}
        style={{ marginBottom: 12 }}
      />
    );
  }

  if (verdict.state === 'empty') {
    return (
      <Alert
        type="info"
        showIcon
        data-testid={EMPTY_LOGS_TESTID.empty}
        title={t('execDetail.log.emptyTitle')}
        description={t('execDetail.log.emptyDesc')}
        style={{ marginBottom: 12 }}
      />
    );
  }

  return (
    <Alert
      type="error"
      showIcon
      data-testid={EMPTY_LOGS_TESTID.unknown}
      title={t('execDetail.log.unknownTitle')}
      description={t('execDetail.log.unknownDesc')}
      style={{ marginBottom: 12 }}
    />
  );
}