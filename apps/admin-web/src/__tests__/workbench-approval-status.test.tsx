/**
 * ADR-045 · 工作台提交后的「发布审批三态」诚实反馈（`pages/WorkbenchPage.tsx`）。
 *
 * 判据是**渲染副作用**，不是「代码里有 approvalKey」：
 *   · submitted ⇒ success Alert + 审批卡（状态文案 / 审批单标识原文 / /inbox 入口）
 *     + 既有 /sops 深链，全部逐字保留；
 *   · failed ⇒ **warning Alert**（草稿已落但审批发起失败），无审批卡、无 /sops 链接
 *     （USER 点进去是 ADMIN-only 页 ⇒ 403），不给「已提交审批」的假象；
 *   · not_requested ⇒ 中性 info Alert，同样无审批卡、无 /sops 链接；
 *   · 三态文案全走 i18n，英文界面不得出现后端硬编码中文 `next`。
 *
 * 验收级别：单测 / 内存替身（`api/workbench` 被 mock，HTTP 边界不触网）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { setLanguage } from '../i18n';
import WorkbenchPage from '../pages/WorkbenchPage';
import { previewPlan, commitPlan } from '../api/workbench';
import type { CommitResult, PreviewPlanResult } from '../api/workbench';
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
    capabilityHints: ['读取项目列表'],
    acceptanceText: '报告包含本周新增与阻塞项',
    budget: { maxTurns: 12 },
  },
  checks: [{ field: 'goal', status: 'ok', message: '目标描述清晰' }],
  eligible: true,
  cardHash: 'card-abc123',
  policyGeneration: '9f8e7d6c5b4a3210',
};

const commitOk: CommitResult = {
  sopId: 'sop-0001',
  slug: 'workbench-card-abc1',
  status: 'draft',
  approvalStatus: 'submitted',
  // 废弃字段刻意留在 fixture：前端若仍渲染它，下面「无硬编码中文」断言会红。
  next: '请在 SOP 页面审阅并发布',
};

const APPROVAL_KEY = 'apr-11111111-1111-4111-8111-111111111111-cccccccccccccccc';

const button = (label: string): HTMLButtonElement =>
  screen.getByText(label).closest('button') as HTMLButtonElement;

async function submitCommit() {
  render(<WorkbenchPage />);
  fireEvent.change(screen.getByPlaceholderText('例如：每周汇总项目状态并生成报告'), {
    target: { value: '每周汇总项目状态' },
  });
  fireEvent.click(button('预览方案'));
  await screen.findByText(okResult.card.title);
  fireEvent.click(button('确认方案'));
  await screen.findByTestId('workbench-commit-success');
}

beforeEach(async () => {
  await setLanguage('zh');
  vi.mocked(previewPlan).mockReset().mockResolvedValue(okResult);
  vi.mocked(commitPlan).mockReset().mockResolvedValue(commitOk);
  useAuthStore.setState({ user: { id: 7, username: 'boss', role: 'admin' } });
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await setLanguage('zh');
});

describe('ADR-045 工作台提交后的四眼审批状态', () => {
  it('submitted：success Alert + 状态文案 + 审批单标识原文 + /inbox + 既有 /sops 深链', async () => {
    vi.mocked(commitPlan).mockResolvedValue({ ...commitOk, approvalKey: APPROVAL_KEY });
    await submitCommit();

    const block = screen.getByTestId('workbench-commit-approval');
    expect(withinText(block, 'workbench-approval-status')).toBe('已提交四眼审批，等待主管批准');
    expect(withinText(block, 'workbench-approval-key')).toBe(APPROVAL_KEY);
    expect(withinText(block, 'workbench-approval-link')).toBe('去待我审批');
    expect(block.querySelector('[data-testid="workbench-approval-link"]')?.getAttribute('href')).toBe('/inbox');
    // happy path 既有草稿结果与深链逐字不变
    const card = screen.getByTestId('workbench-commit-success');
    expect(card.querySelector('.ant-alert-success')).not.toBeNull();
    expect(card.textContent).toContain('sop-0001');
    expect(card.textContent).toContain('workbench-card-abc1');
    expect(card.textContent).toContain('后续步骤：方案卡已提交发布审批，待主管四眼批准');
    expect(screen.getByRole('link', { name: '去 SOP 页审阅' }).getAttribute('href')).toBe(
      '/sops?sop=sop-0001',
    );
    // 面向业务人员：不出现运行时术语
    expect(card.textContent ?? '').not.toMatch(/cron|uuid|glue|executor/i);
  });

  it('failed（审批发起异常）：warning Alert + 草稿保留 + 无 /sops 链接 + 无审批卡', async () => {
    vi.mocked(commitPlan).mockResolvedValue({ ...commitOk, approvalStatus: 'failed' });
    await submitCommit();

    const card = screen.getByTestId('workbench-commit-success');
    expect(card.querySelector('.ant-alert-warning')).not.toBeNull();
    expect(card.querySelector('.ant-alert-success')).toBeNull();
    expect(card.textContent).toContain('方案已存为草稿，但发布审批发起失败，请联系管理员后重试');
    // 草稿确实已落：draft 标签 + sopId + slug 仍在
    expect(card.textContent).toContain('草稿');
    expect(card.textContent).toContain('sop-0001');
    expect(card.textContent).toContain('workbench-card-abc1');
    // 不编造「已提交审批」，也不给 USER 指向 ADMIN-only 页的 403 链接
    expect(screen.queryByTestId('workbench-commit-approval')).toBeNull();
    expect(screen.queryByTestId('workbench-approval-status')).toBeNull();
    expect(screen.queryByTestId('workbench-approval-key')).toBeNull();
    expect(screen.queryByTestId('workbench-approval-link')).toBeNull();
    expect(card.querySelector('a[href^="/sops"]')).toBeNull();
    expect(screen.queryByRole('link', { name: '去 SOP 页审阅' })).toBeNull();
    expect(card.textContent).toContain('发布审批发起失败，请勿直接前往 SOP 页；待管理员处理后重试');
    expect(card.textContent).not.toContain('请在 SOP 页面审阅并发布');
    expect(document.body.textContent).not.toContain('已提交四眼审批');
  });

  it('not_requested（端口缺席/非 USER 上下文）：中性 Alert + 无 /sops 链接 + 无审批卡', async () => {
    vi.mocked(commitPlan).mockResolvedValue({ ...commitOk, approvalStatus: 'not_requested' });
    await submitCommit();

    const card = screen.getByTestId('workbench-commit-success');
    expect(card.querySelector('.ant-alert-info')).not.toBeNull();
    expect(card.querySelector('.ant-alert-success')).toBeNull();
    expect(card.querySelector('.ant-alert-warning')).toBeNull();
    expect(card.textContent).toContain('方案已存草稿，请联系管理员发起发布审批');
    expect(card.textContent).toContain('sop-0001');
    expect(screen.queryByTestId('workbench-commit-approval')).toBeNull();
    expect(card.querySelector('a[href^="/sops"]')).toBeNull();
    expect(card.textContent).not.toContain('请在 SOP 页面审阅并发布');
  });

  it('submitted 但 approvalKey 为空白 ⇒ 不渲染空壳审批卡', async () => {
    vi.mocked(commitPlan).mockResolvedValue({ ...commitOk, approvalKey: '   ' });
    await submitCommit();

    expect(screen.queryByTestId('workbench-commit-approval')).toBeNull();
    expect(document.body.textContent).not.toContain('已提交四眼审批');
  });

  it('英文界面 failed 态无硬编码中文：三态文案全走 i18n', async () => {
    await setLanguage('en');
    vi.mocked(commitPlan).mockResolvedValue({ ...commitOk, approvalStatus: 'failed' });
    // 英文界面下中文选择器不再成立，走英文 label 的同一条用户路径。
    render(<WorkbenchPage />);
    fireEvent.change(screen.getAllByRole('textbox')[0], {
      target: { value: 'Weekly project status summary' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview plan' }));
    await screen.findByText(okResult.card.title);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm plan' }));
    await screen.findByTestId('workbench-commit-success');

    const card = screen.getByTestId('workbench-commit-success');
    expect(card.textContent).toContain('release approval request failed');
    expect(card.textContent).not.toMatch(/[\u4e00-\u9fa5]/);
    expect(card.querySelector('a[href^="/sops"]')).toBeNull();
    expect(screen.queryByTestId('workbench-commit-approval')).toBeNull();
  });
});

function withinText(root: HTMLElement, testId: string): string {
  const node = root.querySelector(`[data-testid="${testId}"]`);
  if (!node) throw new Error(`Missing ${testId}`);
  return (node.textContent ?? '').trim();
}
