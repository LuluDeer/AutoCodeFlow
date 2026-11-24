/**
 * B1 首体验引导在 dashboard 的接线区：一次性收口横幅 + 空态引导卡。
 *
 * 职责切分：
 *   · 状态派生与 localStorage 收口 —— hooks/useOnboardingGuide.ts；
 *   · 引导卡本体（fox / 文案 / CTA / 三步进度）—— OnboardingGuideCard.tsx；
 *   · 本组件只做 hook 实例化、两块 JSX 组装与导航回调出口，DashboardPage 仅留一行挂载。
 */
import { Alert } from 'antd';
import { useTranslation } from 'react-i18next';
import { useOnboardingGuide } from '../../hooks/useOnboardingGuide';
import DashboardEmptyGuide from '../dashboard/DashboardEmptyGuide';
// UI-10：导入 i18n 实例（模块副作用完成初始化；树内用 useTranslation 读 key）
import '../../i18n';

interface DashboardOnboardingSectionProps {
  totalTasks?: number;
  executionCount?: number;
  successCount?: number;
  onCreateTask: () => void;
  onOpenTasks: () => void;
  onOpenExecutions: () => void;
}

export default function DashboardOnboardingSection({
  totalTasks,
  executionCount,
  successCount,
  onCreateTask,
  onOpenTasks,
  onOpenExecutions,
}: DashboardOnboardingSectionProps) {
  const { t } = useTranslation();
  const guide = useOnboardingGuide(
    totalTasks == null
      ? undefined
      : {
        taskCount: totalTasks,
        executionCount: executionCount ?? 0,
        successCount: successCount ?? 0,
      },
  );

  return (
    <>
      {/* 本会话首次跑通后的一次性收口横幅（老用户挂载即 completed 不弹） */}
      {guide.showCompleteBanner && (
        <Alert
          data-testid="onboarding-complete-banner"
          type="success"
          showIcon
          closable
          onClose={guide.closeCompleteBanner}
          message={t('onboarding.complete.title')}
          description={t('onboarding.complete.subtitle')}
        />
      )}
      <DashboardEmptyGuide
        guide={guide}
        totalTasks={totalTasks}
        executionCount={executionCount}
        successCount={successCount}
        onCreateTask={onCreateTask}
        onOpenTasks={onOpenTasks}
        onOpenExecutions={onOpenExecutions}
      />
    </>
  );
}
