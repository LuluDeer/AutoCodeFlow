/**
 * B1 首次体验引导（TTFV 北极星）——状态机 + localStorage 收口。
 *
 * 步骤（纯数据派生，不存步骤本身）：
 *   welcome（无任务）→ taskCreated（有任务无执行）→ firstRun（有执行无成功）→ completed（有成功执行）。
 *
 * 持久化信封键 `autoflow-onboarding:v1`：
 *   `{ version: 1, dismissedStep: OnboardingStep | null, completedAt: number | null }`
 *
 * 语义：
 *   · dismissedStep 仅压制「写入时的当前步骤」；步骤一旦推进，旧的 dismissedStep
 *     与新步骤不匹配即自动失效，不残留压制。
 *   · completedAt 首次派生到 completed 时落盘；老用户挂载即 completed（已有成功
 *     数据）时静默补写，不弹收口横幅。横幅仅在本会话内由非 completed 迁入
 *     completed 时展示一次。
 *   · 坏 JSON / 版本不符 / 形状不对 → 回落缺省信封，不抛错（与 useDraft 同范式）。
 *
 * 写域纪律：本模块只碰 localStorage，不读后端、不发请求、不动表单提交流。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type OnboardingStep = 'welcome' | 'taskCreated' | 'firstRun' | 'completed';

export interface OnboardingCounts {
  taskCount: number;
  executionCount: number;
  successCount: number;
}

export const ONBOARDING_STORAGE_KEY = 'autoflow-onboarding:v1';
export const ONBOARDING_SCHEMA_VERSION = 1;

export interface OnboardingEnvelope {
  version: number;
  /** 被用户压制的步骤；仅对该步骤有效，推进后自动失效。 */
  dismissedStep: OnboardingStep | null;
  /** 首次进入 completed 的时间戳；null = 尚未收口。 */
  completedAt: number | null;
}

const DEFAULT_ENVELOPE: OnboardingEnvelope = {
  version: ONBOARDING_SCHEMA_VERSION,
  dismissedStep: null,
  completedAt: null,
};

const STEPS: readonly OnboardingStep[] = ['welcome', 'taskCreated', 'firstRun', 'completed'];

function normalizeStep(value: unknown): OnboardingStep | null {
  return typeof value === 'string' && (STEPS as readonly string[]).includes(value)
    ? (value as OnboardingStep)
    : null;
}

/** 取 localStorage；SSR / 无 window / 被策略禁用（隐私模式访问即抛）→ null。 */
function getStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * 解析持久化信封；任何异常（无值/坏 JSON/版本不符/形状不对）→ 缺省信封。
 * 纯函数导出供测试锚定。
 */
export function parseOnboardingEnvelope(raw: string | null): OnboardingEnvelope {
  if (typeof raw !== 'string' || raw.length === 0) return { ...DEFAULT_ENVELOPE };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_ENVELOPE };
    const env = parsed as Partial<OnboardingEnvelope>;
    if (env.version !== ONBOARDING_SCHEMA_VERSION) return { ...DEFAULT_ENVELOPE };
    const dismissedStep = normalizeStep(env.dismissedStep);
    const completedAt =
      typeof env.completedAt === 'number' && Number.isFinite(env.completedAt) && env.completedAt >= 0
        ? env.completedAt
        : null;
    return { version: ONBOARDING_SCHEMA_VERSION, dismissedStep, completedAt };
  } catch {
    return { ...DEFAULT_ENVELOPE };
  }
}

/** 读取信封（无值/坏值/版本不符 → 缺省信封）。不抛错。 */
export function readOnboardingEnvelope(): OnboardingEnvelope {
  const storage = getStorage();
  if (!storage) return { ...DEFAULT_ENVELOPE };
  try {
    return parseOnboardingEnvelope(storage.getItem(ONBOARDING_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_ENVELOPE };
  }
}

/** 写入信封。返回是否真的写成功（quota 满 / 隐私模式 → false）。不抛错。 */
export function writeOnboardingEnvelope(env: OnboardingEnvelope): boolean {
  const storage = getStorage();
  if (!storage) return false;
  try {
    storage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(env));
    return true;
  } catch {
    return false;
  }
}

/**
 * 步骤派生纯函数（导出供测试锚定）：
 *   success > 0 → completed；exec > 0 → firstRun；task > 0 → taskCreated；否则 welcome。
 */
export function deriveStep({ taskCount, executionCount, successCount }: OnboardingCounts): OnboardingStep {
  if (successCount > 0) return 'completed';
  if (executionCount > 0) return 'firstRun';
  if (taskCount > 0) return 'taskCreated';
  return 'welcome';
}

export interface UseOnboardingGuideResult {
  /** 当前派生步骤；counts 未就绪（undefined）时为 null。 */
  step: OnboardingStep | null;
  /** 当前步骤是否已被用户压制（dismissedStep 与当前步骤一致才成立）。 */
  dismissed: boolean;
  /** 压制当前步骤（落盘 dismissedStep，保留 completedAt）。 */
  dismiss: () => void;
  /** 本会话内首次由非 completed 迁入 completed：一次性收口横幅是否展示。 */
  showCompleteBanner: boolean;
  /** 关闭横幅（completedAt 已在迁入时落盘，此处只关会话内显示态）。 */
  closeCompleteBanner: () => void;
  completedAt: number | null;
}

/**
 * 引导 hook。counts 传 undefined 表示摘要尚未加载——不派生、不落盘、不压制，
 * 避免加载闪烁期间把空态写成「用户已忽略」。
 */
export function useOnboardingGuide(counts: OnboardingCounts | undefined): UseOnboardingGuideResult {
  const step = useMemo(() => (counts ? deriveStep(counts) : null), [counts]);
  const [envelope, setEnvelope] = useState<OnboardingEnvelope>(() => readOnboardingEnvelope());
  const prevStepRef = useRef<OnboardingStep | null>(null);
  const [bannerVisible, setBannerVisible] = useState(false);

  // 老用户静默补写：挂载即 completed 且无 completedAt → 落盘收口时间，不弹横幅。
  useEffect(() => {
    if (step !== 'completed' || envelope.completedAt != null) return;
    const next: OnboardingEnvelope = { ...envelope, completedAt: Date.now() };
    if (writeOnboardingEnvelope(next)) setEnvelope(next);
  }, [step, envelope]);

  // 会话内迁入 completed：落盘 completedAt + 弹一次横幅。prevStepRef 为 null
  // （首次挂载）时不触发——那是老用户补写路径，由上面的 effect 兜底。
  // envelope 入参：completedAt 落盘后 effect 重跑，但 prevStepRef 已是 completed，
  // 迁入条件不再成立，横幅不会重复弹。
  useEffect(() => {
    const prev = prevStepRef.current;
    prevStepRef.current = step;
    if (prev != null && prev !== 'completed' && step === 'completed') {
      if (envelope.completedAt == null) {
        const next: OnboardingEnvelope = { ...envelope, completedAt: Date.now() };
        if (writeOnboardingEnvelope(next)) setEnvelope(next);
      }
      setBannerVisible(true);
    }
  }, [step, envelope]);

  const dismiss = useCallback(() => {
    if (step == null) return;
    setEnvelope((prev) => {
      const next: OnboardingEnvelope = { ...prev, dismissedStep: step };
      writeOnboardingEnvelope(next);
      return next;
    });
  }, [step]);

  const closeCompleteBanner = useCallback(() => setBannerVisible(false), []);

  const dismissed = step != null && envelope.dismissedStep === step;

  return useMemo(
    () => ({
      step,
      dismissed,
      dismiss,
      showCompleteBanner: bannerVisible,
      closeCompleteBanner,
      completedAt: envelope.completedAt,
    }),
    [step, dismissed, dismiss, bannerVisible, closeCompleteBanner, envelope.completedAt],
  );
}

export default useOnboardingGuide;
