/**
 * B1 首次体验引导卡（共享 UI）：fox 插图 + 标题/副标题 + 步骤 CTA + 三步进度 +
 * 压制入口。文案与 CTA 按步骤映射；completed 态不由本卡承载（收口走 dashboard 横幅）。
 *
 * 数据面与持久化在 `hooks/useOnboardingGuide.ts`；本组件只管渲染与回调出口。
 *
 * i18n 纪律：所有 t() 实参均为字面量（不做查表式动态键），键集由 i18n-source-guard
 * 与 i18n-key-check 静态锚定，无需登记动态键基线。
 */
import type { ReactNode } from 'react';
import { Button, Typography } from 'antd';
import {
  RocketOutlined, ThunderboltOutlined, EyeOutlined, CloseOutlined, CheckOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import BrandFox from '../BrandFox';
import type { OnboardingStep } from '../../hooks/useOnboardingGuide';
// UI-10：导入 i18n 实例（模块副作用完成初始化；树内用 useTranslation 读 key）
import '../../i18n';

const { Text } = Typography;

/** 本卡承载的三个未收口步骤；completed 走一次性横幅，不进此卡。 */
export type GuideStep = Exclude<OnboardingStep, 'completed'>;

/** 三步进度中的当前位（0/1/2）。 */
const STEP_INDEX: Record<GuideStep, number> = { welcome: 0, taskCreated: 1, firstRun: 2 };

function StepDot({ done, active, label, testId }: { done: boolean; active: boolean; label: string; testId: string }) {
  return (
    <span
      data-testid={testId}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 12,
        color: active ? 'var(--color-accent)' : undefined,
      }}
    >
      {done ? <CheckOutlined /> : (
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: active ? 'var(--color-accent)' : 'var(--color-border)',
            display: 'inline-block',
          }}
        />
      )}
      {label}
    </span>
  );
}

export interface OnboardingGuideCardProps {
  step: GuideStep;
  onCta: () => void;
  onDismiss: () => void;
  /** CTA 按钮 testid（welcome 态沿用既有 `dashboard-empty-guide-create` 锚点）。 */
  ctaTestId?: string;
  /**
   * 品牌形象位（默认狐狸）。调用方显式传入时由调用方持有品牌判据，
   * 便于「空态」这类形象位在自己的文件里被品牌守卫逐字锚定。
   */
  illustration?: ReactNode;
}

export default function OnboardingGuideCard({
  step,
  onCta,
  onDismiss,
  ctaTestId = 'onboarding-guide-cta',
  illustration,
}: OnboardingGuideCardProps) {
  const { t } = useTranslation();
  const activeIndex = STEP_INDEX[step];

  let title: string;
  let subtitle: string;
  let cta: string;
  let icon: ReactNode;
  if (step === 'welcome') {
    title = t('dashGuide.title');
    subtitle = t('dashGuide.subtitle');
    cta = t('dashGuide.createFirst');
    icon = <RocketOutlined />;
  } else if (step === 'taskCreated') {
    title = t('onboarding.taskCreated.title');
    subtitle = t('onboarding.taskCreated.subtitle');
    cta = t('onboarding.taskCreated.cta');
    icon = <ThunderboltOutlined />;
  } else {
    title = t('onboarding.firstRun.title');
    subtitle = t('onboarding.firstRun.subtitle');
    cta = t('onboarding.firstRun.cta');
    icon = <EyeOutlined />;
  }

  return (
    <div
      data-testid="onboarding-guide-card"
      style={{
        position: 'relative',
        display: 'flex',
        justifyContent: 'center',
        padding: '48px 0',
        background: 'var(--color-muted)',
        borderRadius: 10,
        border: '1px dashed var(--color-border)',
      }}
    >
      <Button
        type="text"
        size="small"
        aria-label={t('onboarding.dismiss')}
        data-testid="onboarding-guide-dismiss"
        icon={<CloseOutlined />}
        onClick={onDismiss}
        style={{ position: 'absolute', top: 8, right: 8 }}
      />
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, maxWidth: 480, padding: '0 16px' }}>
        {illustration ?? <BrandFox size={96} style={{ marginBottom: 8 }} />}
        <Text strong style={{ fontSize: 14 }}>{title}</Text>
        <Text type="secondary" style={{ fontSize: 12, textAlign: 'center' }}>{subtitle}</Text>
        <Button
          type="primary"
          data-testid={ctaTestId}
          icon={icon}
          onClick={onCta}
          style={{ marginTop: 12 }}
        >
          {cta}
        </Button>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            marginTop: 16,
            flexWrap: 'wrap',
            justifyContent: 'center',
          }}
        >
          <StepDot done={0 < activeIndex} active={0 === activeIndex} label={t('onboarding.steps.1')} testId="onboarding-step-1" />
          <StepDot done={1 < activeIndex} active={1 === activeIndex} label={t('onboarding.steps.2')} testId="onboarding-step-2" />
          <StepDot done={2 < activeIndex} active={2 === activeIndex} label={t('onboarding.steps.3')} testId="onboarding-step-3" />
        </div>
      </div>
    </div>
  );
}
