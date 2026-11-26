import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '../i18n';
import WorkbenchPage from '../pages/WorkbenchPage';
import { previewPlan, commitPlan } from '../api/workbench';
import type { PreviewPlanResult, CommitResult } from '../api/workbench';
import { useAuthStore } from '../store/auth';

vi.mock('../api/workbench', () => ({
  previewPlan: vi.fn(),
  commitPlan: vi.fn(),
}));

const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const okResult: PreviewPlanResult = {
  card: {
    title: '每周项目状态汇总',
    triggerText: '每周一上午生成状态报告',
    capabilityHints: ['读取项目列表', '生成报告摘要'],
    acceptanceText: '报告包含本周新增与阻塞项',
    budget: { maxTurns: 12 },
  },
  checks: [
    { field: 'goal', status: 'ok', message: '目标描述清晰' },
    { field: 'cadence', status: 'warn', message: '频率已设置' },
  ],
  eligible: true,
  cardHash: 'card-abc123',
  policyGeneration: '9f8e7d6c5b4a3210',
};

const commitOk: CommitResult = {
  sopId: 'sop-0001',
  slug: 'workbench-card-abc1',
  status: 'draft',
  next: '请在 SOP 页面审阅并发布',
};

const button = (label: string): HTMLButtonElement =>
  screen.getByText(label).closest('button') as HTMLButtonElement;

async function previewWithGoal(goal = '每周汇总项目状态') {
  render(<WorkbenchPage />);
  fireEvent.change(screen.getByPlaceholderText('例如：每周汇总项目状态并生成报告'), {
    target: { value: goal },
  });
  fireEvent.click(button('预览方案'));
  await screen.findByText(okResult.card.title);
}

beforeEach(() => {
  vi.mocked(previewPlan).mockReset().mockResolvedValue(okResult);
  vi.mocked(commitPlan).mockReset().mockResolvedValue(commitOk);
  useAuthStore.setState({ user: null });
});

afterEach(() => {
  cleanup();
});

describe('工作台最小验证页', () => {
  it('表单只呈现业务字段，不出现运行时术语', () => {
    render(<WorkbenchPage />);
    expect(screen.getByText('业务目标')).toBeTruthy();
    expect(screen.getByText('执行频率')).toBeTruthy();
    expect(screen.getByText('可选参数')).toBeTruthy();
    expect(screen.getByText('每天')).toBeTruthy();
    expect(document.body.textContent ?? '').not.toMatch(/cron|uuid|glue|executor/i);
  });

  it('预览成功渲染方案卡的标题、触发、能力、验收、预算与核查项', async () => {
    await previewWithGoal();
    expect(document.body.textContent).toContain('触发节奏：每周一上午生成状态报告');
    expect(screen.getByText('读取项目列表')).toBeTruthy();
    expect(screen.getByText('生成报告摘要')).toBeTruthy();
    expect(document.body.textContent).toContain('报告包含本周新增与阻塞项');
    expect(document.body.textContent).toContain('预算上限：最多 12 轮');
    expect(document.body.textContent).toContain('目标描述清晰');
    expect(vi.mocked(previewPlan).mock.calls[0][0]).toEqual({
      goal: '每周汇总项目状态',
      cadence: 'daily',
    });
  });

  it('核查项出现未通过时禁用确认', async () => {
    vi.mocked(previewPlan).mockResolvedValue({
      ...okResult,
      checks: [{ field: 'goal', status: 'fail', message: '目标过于笼统' }],
    });
    await previewWithGoal();
    expect(document.body.textContent).toContain('目标过于笼统');
    expect(button('确认方案').disabled).toBe(true);
  });

  it('不可执行时明确提示并禁止确认', async () => {
    vi.mocked(previewPlan).mockResolvedValue({ ...okResult, eligible: false });
    await previewWithGoal();
    expect(
      screen.getByText('当前方案尚不满足执行条件，请调整业务信息后重新预览。'),
    ).toBeTruthy();
    expect(button('确认方案').disabled).toBe(true);
  });

  it('确认调用提交端点并原样回填 expectedCardHash 与策略代际，展示草稿结果与审阅链接', async () => {
    useAuthStore.setState({ user: { id: 7, username: 'tester', role: 'admin' } });
    await previewWithGoal();
    fireEvent.click(button('确认方案'));

    expect(await screen.findByTestId('workbench-commit-success')).toBeTruthy();
    expect(vi.mocked(commitPlan)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(commitPlan).mock.calls[0][0]).toEqual({
      goal: '每周汇总项目状态',
      cadence: 'daily',
      expectedCardHash: okResult.cardHash,
      expectedPolicyGeneration: okResult.policyGeneration,
    });

    const success = screen.getByTestId('workbench-commit-success');
    expect(success.textContent).toContain(commitOk.sopId);
    expect(success.textContent).toContain(commitOk.slug);
    expect(success.textContent).toContain('草稿');
    expect(success.textContent).toContain('已存为草稿');
    expect(screen.getByRole('link', { name: '去 SOP 页审阅' }).getAttribute('href')).toBe(
      `/sops?sop=${commitOk.sopId}`,
    );
    // 本地留痕作为 UX 反馈仍在
    const record = await screen.findByTestId('workbench-confirm-record');
    expect(record.textContent).toContain(okResult.cardHash);
    expect(record.textContent).toContain(okResult.policyGeneration.slice(0, 8));
    expect(record.getAttribute('data-generation')).toBe(okResult.policyGeneration);
    expect(record.textContent).toContain('tester');
  });

  it('反证：commit 回带新 policyGeneration 时确认记录锚定放行值，且不误报策略竞态', async () => {
    const bumpedGeneration = 'ffffffffffffffff';
    vi.mocked(commitPlan).mockResolvedValueOnce({
      ...commitOk,
      policyGeneration: bumpedGeneration,
    });
    await previewWithGoal();
    fireEvent.click(button('确认方案'));

    expect(await screen.findByTestId('workbench-commit-success')).toBeTruthy();
    // 提交锚点仍取 preview 值：后端第三闸按它校验，不能被回带值污染。
    expect(vi.mocked(commitPlan).mock.calls[0][0].expectedPolicyGeneration).toBe(
      okResult.policyGeneration,
    );
    // 成功路径不弹错误、不回滚留痕：不制造「成功却报错」的矛盾。
    expect(screen.queryByText(/确认失败/)).toBeNull();
    const record = await screen.findByTestId('workbench-confirm-record');
    expect(record.getAttribute('data-generation')).toBe(bumpedGeneration);
    expect(record.textContent).toContain(bumpedGeneration.slice(0, 8));
    expect(record.textContent).not.toContain(okResult.policyGeneration.slice(0, 8));
  });

  it('确认失败显示内联错误且不展示成功区', async () => {
    vi.mocked(commitPlan).mockRejectedValueOnce(new Error('boom'));
    await previewWithGoal();
    fireEvent.click(button('确认方案'));

    expect(await screen.findByText('确认失败，方案未能保存为草稿，请稍后重试。')).toBeTruthy();
    expect(screen.queryByTestId('workbench-commit-success')).toBeNull();
    expect(screen.queryByTestId('workbench-confirm-record')).toBeNull();
  });

  it('generation 失配时内联展示后端 detail 的中文原因', async () => {
    vi.mocked(commitPlan).mockRejectedValueOnce({
      code: 'POLICY_GENERATION_MISMATCH',
      detail: '方案策略已变更，请重新预览后再确认。',
      __status: 409,
    });
    await previewWithGoal();
    fireEvent.click(button('确认方案'));

    expect(
      await screen.findByText('确认失败：方案策略已变更，请重新预览后再确认。'),
    ).toBeTruthy();
    expect(screen.queryByTestId('workbench-commit-success')).toBeNull();
  });

  it('提交中按钮进入 loading 且重复点击只发一次请求', async () => {
    let resolveCommit!: (value: CommitResult) => void;
    vi.mocked(commitPlan).mockImplementation(
      () => new Promise<CommitResult>((resolve) => { resolveCommit = resolve; }),
    );
    await previewWithGoal();
    const confirm = button('确认方案');
    fireEvent.click(confirm);
    // 第一次点击后按钮应处于 loading/disabled
    await waitFor(() => expect(button('确认方案').disabled).toBe(true));
    fireEvent.click(button('确认方案'));
    expect(vi.mocked(commitPlan)).toHaveBeenCalledTimes(1);

    resolveCommit(commitOk);
    expect(await screen.findByTestId('workbench-commit-success')).toBeTruthy();
    expect(vi.mocked(commitPlan)).toHaveBeenCalledTimes(1);
  });

  it('缺少 cardHash 时不发写请求并给出提示', async () => {
    vi.mocked(previewPlan).mockResolvedValue({ ...okResult, cardHash: '' });
    await previewWithGoal();
    fireEvent.click(button('确认方案'));

    expect(await screen.findByText('方案缺少标识，请重新预览后再确认。')).toBeTruthy();
    expect(vi.mocked(commitPlan)).not.toHaveBeenCalled();
  });
});
