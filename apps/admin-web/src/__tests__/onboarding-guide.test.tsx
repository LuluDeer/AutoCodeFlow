/**
 * B1 首体验引导回归：
 *  · deriveStep 状态机矩阵；
 *  · localStorage 信封读写 / 坏值降级 / 版本不符回落；
 *  · dismiss 持久化、步骤推进后旧压制自动失效重显；
 *  · 会话内迁入 completed 弹一次横幅并落 completedAt；老用户挂载即 completed 静默补写、不弹横幅；
 *  · DashboardEmptyGuide 各步骤 CTA 出口导航。
 *
 * 测试隔离：test-setup 不清 localStorage，本套件 beforeEach/afterEach 自行清理。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, render, screen, cleanup, fireEvent } from '@testing-library/react';
import {
  deriveStep,
  parseOnboardingEnvelope,
  readOnboardingEnvelope,
  writeOnboardingEnvelope,
  useOnboardingGuide,
  ONBOARDING_STORAGE_KEY,
  type OnboardingCounts,
} from '../hooks/useOnboardingGuide';
import DashboardEmptyGuide from '../components/dashboard/DashboardEmptyGuide';

const WELCOME: OnboardingCounts = { taskCount: 0, executionCount: 0, successCount: 0 };
const TASK_CREATED: OnboardingCounts = { taskCount: 1, executionCount: 0, successCount: 0 };
const FIRST_RUN: OnboardingCounts = { taskCount: 1, executionCount: 1, successCount: 0 };
const COMPLETED: OnboardingCounts = { taskCount: 1, executionCount: 1, successCount: 1 };

beforeEach(() => {
  cleanup();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('deriveStep 状态机矩阵', () => {
  it.each([
    [WELCOME, 'welcome'],
    [TASK_CREATED, 'taskCreated'],
    [FIRST_RUN, 'firstRun'],
    [COMPLETED, 'completed'],
    // 有执行即 firstRun，哪怕任务数为 0（历史脏数据口径：执行记录先于任务存在）
    [{ taskCount: 0, executionCount: 5, successCount: 0 }, 'firstRun'],
    // 有成功即 completed，压过执行/任务计数
    [{ taskCount: 2, executionCount: 0, successCount: 3 }, 'completed'],
    [{ taskCount: 0, executionCount: 0, successCount: 1 }, 'completed'],
  ])('%o → %s', (counts, expected) => {
    expect(deriveStep(counts)).toBe(expected);
  });
});

describe('信封读写与坏值降级', () => {
  it('缺省键 / 空串 / 坏 JSON / 版本不符 / 形状不对 → 缺省信封，不抛错', () => {
    expect(parseOnboardingEnvelope(null)).toEqual({ version: 1, dismissedStep: null, completedAt: null });
    expect(parseOnboardingEnvelope('')).toEqual({ version: 1, dismissedStep: null, completedAt: null });
    expect(parseOnboardingEnvelope('{not-json')).toEqual({ version: 1, dismissedStep: null, completedAt: null });
    expect(parseOnboardingEnvelope('{"version":2,"dismissedStep":"welcome","completedAt":1}'))
      .toEqual({ version: 1, dismissedStep: null, completedAt: null });
    expect(parseOnboardingEnvelope('"just-a-string"')).toEqual({ version: 1, dismissedStep: null, completedAt: null });
  });

  it('合法信封往返；非法 dismissedStep / completedAt 字段被归一为 null', () => {
    writeOnboardingEnvelope({ version: 1, dismissedStep: 'taskCreated', completedAt: 1700000000000 });
    expect(readOnboardingEnvelope()).toEqual({
      version: 1, dismissedStep: 'taskCreated', completedAt: 1700000000000,
    });

    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      version: 1, dismissedStep: 'bogus-step', completedAt: NaN,
    }));
    expect(readOnboardingEnvelope()).toEqual({ version: 1, dismissedStep: null, completedAt: null });
  });

  it('storage 不可用（访问抛错）→ 写返回 false，读回落缺省信封，不冒泡', () => {
    const spy = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('denied');
    });
    try {
      expect(writeOnboardingEnvelope({ version: 1, dismissedStep: 'welcome', completedAt: null })).toBe(false);
      expect(readOnboardingEnvelope()).toEqual({ version: 1, dismissedStep: null, completedAt: null });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('useOnboardingGuide hook', () => {
  it('welcome：步骤 welcome，未压制，无横幅', () => {
    const { result } = renderHook(() => useOnboardingGuide(WELCOME));
    expect(result.current.step).toBe('welcome');
    expect(result.current.dismissed).toBe(false);
    expect(result.current.showCompleteBanner).toBe(false);
    expect(result.current.completedAt).toBeNull();
  });

  it('dismiss 落盘 dismissedStep；重新挂载仍被压制', () => {
    const first = renderHook(() => useOnboardingGuide(WELCOME));
    act(() => first.result.current.dismiss());
    expect(first.result.current.dismissed).toBe(true);
    const env = readOnboardingEnvelope();
    expect(env.dismissedStep).toBe('welcome');
    expect(env.completedAt).toBeNull();

    // 重新挂载：信封已落盘，welcome 态仍被压制
    first.unmount();
    const remounted = renderHook(() => useOnboardingGuide(WELCOME));
    expect(remounted.result.current.dismissed).toBe(true);
  });

  it('步骤推进后旧 dismissedStep 自动失效，引导重新出现', () => {
    const { result, rerender } = renderHook(
      ({ counts }: { counts: OnboardingCounts | undefined }) => useOnboardingGuide(counts),
      { initialProps: { counts: WELCOME } },
    );
    act(() => result.current.dismiss());
    expect(result.current.dismissed).toBe(true);

    rerender({ counts: TASK_CREATED });
    expect(result.current.step).toBe('taskCreated');
    expect(result.current.dismissed).toBe(false);
  });

  it('会话内由非 completed 迁入 completed：弹一次横幅并落 completedAt', () => {
    const { result, rerender } = renderHook(
      ({ counts }: { counts: OnboardingCounts | undefined }) => useOnboardingGuide(counts),
      { initialProps: { counts: FIRST_RUN } },
    );
    expect(result.current.showCompleteBanner).toBe(false);

    rerender({ counts: COMPLETED });
    expect(result.current.step).toBe('completed');
    expect(result.current.showCompleteBanner).toBe(true);
    expect(result.current.completedAt).not.toBeNull();
    expect(readOnboardingEnvelope().completedAt).not.toBeNull();

    // 关闭横幅后不影响收口落盘；横幅不再自动复弹
    act(() => result.current.closeCompleteBanner());
    expect(result.current.showCompleteBanner).toBe(false);
  });

  it('老用户挂载即 completed：静默补写 completedAt，不弹横幅', () => {
    const { result } = renderHook(() => useOnboardingGuide(COMPLETED));
    expect(result.current.step).toBe('completed');
    expect(result.current.showCompleteBanner).toBe(false);
    expect(result.current.completedAt).not.toBeNull();
    expect(readOnboardingEnvelope().completedAt).not.toBeNull();
  });

  it('counts 未就绪（undefined）：不派生、不落盘、不压制', () => {
    const { result } = renderHook(() => useOnboardingGuide(undefined));
    expect(result.current.step).toBeNull();
    expect(result.current.dismissed).toBe(false);
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBeNull();
  });
});

describe('DashboardEmptyGuide 适配层 CTA 出口', () => {
  function renderGuide(counts: OnboardingCounts, handlers: { onCreateTask?: () => void; onOpenTasks?: () => void; onOpenExecutions?: () => void } = {}) {
    return render(
      <DashboardEmptyGuide
        totalTasks={counts.taskCount}
        executionCount={counts.executionCount}
        successCount={counts.successCount}
        onCreateTask={handlers.onCreateTask ?? vi.fn()}
        onOpenTasks={handlers.onOpenTasks}
        onOpenExecutions={handlers.onOpenExecutions}
      />,
    );
  }

  it('welcome：渲染引导卡，CTA 走 onCreateTask（既有 testid 锚点保留）', () => {
    const onCreateTask = vi.fn();
    renderGuide(WELCOME, { onCreateTask });
    expect(screen.getByTestId('dashboard-empty-guide')).toBeTruthy();
    fireEvent.click(screen.getByTestId('dashboard-empty-guide-create'));
    expect(onCreateTask).toHaveBeenCalledTimes(1);
  });

  it('taskCreated：CTA 走 onOpenTasks', () => {
    const onOpenTasks = vi.fn();
    renderGuide(TASK_CREATED, { onOpenTasks });
    fireEvent.click(screen.getByTestId('onboarding-guide-cta'));
    expect(onOpenTasks).toHaveBeenCalledTimes(1);
  });

  it('firstRun：CTA 走 onOpenExecutions', () => {
    const onOpenExecutions = vi.fn();
    renderGuide(FIRST_RUN, { onOpenExecutions });
    fireEvent.click(screen.getByTestId('onboarding-guide-cta'));
    expect(onOpenExecutions).toHaveBeenCalledTimes(1);
  });

  it('completed：不渲染引导卡', () => {
    renderGuide(COMPLETED);
    expect(screen.queryByTestId('dashboard-empty-guide')).toBeNull();
  });

  it('当前步骤已被 dismiss 压制：不渲染引导卡', () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      version: 1, dismissedStep: 'welcome', completedAt: null,
    }));
    renderGuide(WELCOME);
    expect(screen.queryByTestId('dashboard-empty-guide')).toBeNull();
  });
});
