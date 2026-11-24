/**
 * UI-04 ⑤：空态引导（B1 首体验引导适配）。
 *
 * 数据面：步骤由 hooks/useOnboardingGuide 派生——
 *   welcome（无任务）/ taskCreated（有任务无执行）/ firstRun（有执行无成功）在本卡
 *   给出下一步 CTA；completed（已有成功执行）不再渲染引导卡，收口走 dashboard 横幅。
 * 摘要未加载完成（undefined）时不渲染——避免加载闪烁误导。
 *
 * BRAND（2026-11-02）：插图用品牌狐狸；卡片本体与三步进度在 OnboardingGuideCard。
 *
 * 兼容锚点：既有 testid `dashboard-empty-guide` / `dashboard-empty-guide-create`
 * （welcome 态 CTA）与 welcome 文案键 `dashGuide.*` 一律保留。
 */
import {
  useOnboardingGuide,
  type OnboardingCounts,
  type UseOnboardingGuideResult,
} from '../../hooks/useOnboardingGuide';
import OnboardingGuideCard, { type GuideStep } from '../onboarding/OnboardingGuideCard';
// UI-10：导入 i18n 实例（模块副作用完成初始化；树内用 useTranslation 读 key）
import '../../i18n';

interface DashboardEmptyGuideProps {
  /** 任务总数（undefined = 摘要未加载，不渲染引导） */
  totalTasks: number | undefined;
  /** 执行总数（步骤派生用；缺省 0） */
  executionCount?: number;
  /** 成功执行数（步骤派生用；缺省 0） */
  successCount?: number;
  onCreateTask: () => void;
  /** taskCreated 步骤 CTA：前往任务列表 */
  onOpenTasks?: () => void;
  /** firstRun 步骤 CTA：前往执行记录 */
  onOpenExecutions?: () => void;
  /**
   * 外部已实例化的引导 hook 结果（DashboardPage 收口横幅与本卡共用同一派生态）；
   * 不传时组件内部自挂一份，保持独立可测。
   */
  guide?: UseOnboardingGuideResult;
}

/**
 * 显隐判定纯函数（导出供测试锚定）：
 * 仅 totalTasks 严格等于 0 时属于「welcome 空态」——undefined（未加载）不显示。
 * 后续步骤（taskCreated/firstRun）的显隐由 deriveStep + dismissed 口径判定。
 */
export function shouldShowEmptyGuide(totalTasks: number | undefined): boolean {
  return totalTasks === 0;
}

export default function DashboardEmptyGuide({
  totalTasks,
  executionCount = 0,
  successCount = 0,
  onCreateTask,
  onOpenTasks,
  onOpenExecutions,
  guide,
}: DashboardEmptyGuideProps) {
  const counts: OnboardingCounts | undefined = totalTasks == null
    ? undefined
    : { taskCount: totalTasks, executionCount, successCount };
  const internal = useOnboardingGuide(counts);
  const active = guide ?? internal;

  if (counts == null || active.step == null || active.step === 'completed' || active.dismissed) {
    return null;
  }

  const handlers: Record<GuideStep, () => void> = {
    welcome: onCreateTask,
    taskCreated: onOpenTasks ?? (() => undefined),
    firstRun: onOpenExecutions ?? (() => undefined),
  };

  return (
    <div data-testid="dashboard-empty-guide">
      <OnboardingGuideCard
        step={active.step}
        onCta={handlers[active.step]}
        onDismiss={active.dismiss}
        ctaTestId={active.step === 'welcome' ? 'dashboard-empty-guide-create' : undefined}
      />
    </div>
  );
}
