import { useMemo } from 'react';
import { Alert, Space, Tag, Typography, theme } from 'antd';
import { ClockCircleOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import '../../i18n';
import {
  nextCronFireTimes,
  nextFixedRateFireTimes,
  formatFireTime,
  validateTimezone,
  previewNeedsTimezoneWarning,
} from '../../utils/trigger-preview';

const { Text } = Typography;

export const TRIGGER_PREVIEW_COUNT = 5;
export const TRIGGER_PREVIEW_TESTID = 'trigger-preview';

interface TriggerPreviewProps {
  /** cron | fixed_rate | manual（manual 渲染 null，调用方可条件挂载） */
  triggerType: string;
  /** cron 表达式（triggerType=cron 时消费） */
  cronExpression?: string;
  /** fixed_rate 间隔秒（triggerType=fixed_rate 时消费） */
  fixedRate?: number | null;
  /** IANA 时区（cron 面板展示语义；空/非法回退本地时区） */
  timezone?: string;
  /** 预览基于的「当前时刻」；缺省取挂载时的 now（测试可注入固定锚点） */
  now?: Date;
}

/**
 * UI-06: 触发预览卡——cron/fixed_rate 的未来 5 次触发时刻可视化。
 *
 * 纯展示增强：计算逻辑全部在 utils/trigger-preview.ts 纯函数层（18 例测试），
 * 本组件只做取值 + 渲染分支。非法表达式/非法 interval/预览服务（无）均不影响
 * 表单校验与提交链路。
 *
 * 防抖说明：cron 表达式逐键变化时 useMemo 直接重算——解析+逐分钟扫描在
 * 典型表达式（分钟级触发）下 <1ms、最坏（稀疏表达式扫满一年）~85ms
 * （见 trigger-preview.test 极稀疏用例实测），jsdom/真机均可接受，暂不引入
 * 防抖状态（避免引入 effect 时序）；真机轮若发现输入卡顿再补 300ms 防抖。
 */
export default function TriggerPreview({
  triggerType,
  cronExpression,
  fixedRate,
  timezone,
  now,
}: TriggerPreviewProps) {
  const { t } = useTranslation();
  // F-15（DEEP_REVIEW 0ef3bbe）：虚线边框/主色图标走 antd token，暗色主题自适应。
  const { token } = theme.useToken();
  // now 只在挂载/显式注入时求值：预览是「快照」语义，不随每次 render 漂移。
  const anchor = useMemo(() => now ?? new Date(), [now]);

  const preview = useMemo(() => {
    if (triggerType === 'cron') {
      const times = nextCronFireTimes(
        cronExpression ?? '',
        TRIGGER_PREVIEW_COUNT,
        anchor,
        timezone,
      );
      const tz = validateTimezone(timezone);
      // P1-3：tz 为空/非法时浏览器推算 ≠ 服务端进程时区，不得自信渲染时刻。
      return {
        kind: 'cron' as const,
        times,
        // 已解析时区才显示具体时区名；未解析时不冒充「服务器默认时区」。
        tzLabel: tz ?? '',
        tzUnresolved: previewNeedsTimezoneWarning(timezone),
      };
    }
    if (triggerType === 'fixed_rate') {
      const times = nextFixedRateFireTimes(
        Number(fixedRate ?? NaN),
        TRIGGER_PREVIEW_COUNT,
        anchor,
      );
      return { kind: 'fixed_rate' as const, times, tzLabel: '', tzUnresolved: false };
    }
    return null;
  }, [triggerType, cronExpression, fixedRate, timezone, anchor]);

  if (!preview) return null;

  const invalid =
    preview.kind === 'cron' && !!cronExpression?.trim() && preview.times.length === 0;
  const sparse =
    preview.times.length > 0 && preview.times.length < TRIGGER_PREVIEW_COUNT;
  // P1-3：有效表达式但时区未解析——浏览器推算的时刻可能与服务端差数小时，
  // 改显警示而非自信渲染时刻。
  const tzWarn = preview.kind === 'cron' && preview.tzUnresolved && preview.times.length > 0;

  return (
    <div
      data-testid={TRIGGER_PREVIEW_TESTID}
      style={{
        margin: '12px 0 4px',
        padding: '10px 12px',
        border: `1px dashed ${token.colorBorder}`,
        borderRadius: 8,
        // O-2：原硬编码 rgba(34,197,94,0.04) 在暗色主题下与暗底不协调。
        // 改走 antd 成功底色 token，亮/暗主题均自适应（与文件头 F-15 声明一致）。
        background: token.colorSuccessBg,
      }}
    >
      <Space size={6} wrap style={{ marginBottom: preview.times.length ? 6 : 0 }}>
        <ClockCircleOutlined style={{ color: token.colorPrimary }} />
        <Text strong style={{ fontSize: 13 }}>{t('triggerPreview.title')}</Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('triggerPreview.nextCount', { count: TRIGGER_PREVIEW_COUNT })}
          {preview.kind === 'cron' && preview.tzLabel && (
            <> · {t('triggerPreview.timezone', { tz: preview.tzLabel })}</>
          )}
          {preview.kind === 'fixed_rate' && (
            <> · {t('triggerPreview.fixedRateEvery', { seconds: fixedRate })}</>
          )}
        </Text>
      </Space>

      {tzWarn ? (
        // P1-3：时区未指定/非法——时刻由服务端进程时区决定，浏览器本地推算可能不准。
        <Alert
          type="warning"
          showIcon
          title={t('triggerPreview.tzUnresolved')}
          style={{ padding: '4px 12px' }}
        />
      ) : preview.times.length > 0 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {preview.times.map((time, i) => (
            <Tag key={i} style={{ fontFamily: 'monospace', marginInlineEnd: 0 }}>
              {formatFireTime(time, preview.kind === 'cron' ? timezone : null)}
            </Tag>
          ))}
          {sparse && (
            <Text type="secondary" style={{ fontSize: 12, width: '100%' }}>
              {t('triggerPreview.sparse', { count: TRIGGER_PREVIEW_COUNT })}
            </Text>
          )}
          {preview.kind === 'fixed_rate' && (
            <Text type="secondary" style={{ fontSize: 12, width: '100%' }}>
              {t('triggerPreview.fixedRateNote')}
            </Text>
          )}
        </div>
      ) : invalid ? (
        <Alert
          type="warning"
          showIcon
          title={t('triggerPreview.unparsable')}
          style={{ padding: '4px 12px' }}
        />
      ) : (
        // P2-1：空输入不是"加载中"——去掉假的 Spin 转圈（旧实现误把空态当 loading）。
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('triggerPreview.empty')}
        </Text>
      )}
    </div>
  );
}