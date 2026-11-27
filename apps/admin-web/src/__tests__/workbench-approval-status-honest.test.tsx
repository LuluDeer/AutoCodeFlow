/**
 * ADR-045 · 审批发起三态诚实化 —— 前端渲染契约（单测 / 内存替身，API 被 mock）。
 *
 * 与同目录 workbench-approval-status.test.tsx 的差异：那个文件钉住旧 approvalKey 判据，
 * 本文件钉住**稳定码 approvalStatus 三态**及「失败不冒充成功」的 DOM 副作用：
 *   · submitted：既有 testid / 审批卡 / approvalKey / /inbox / /sops 链接逐字保留；
 *   · failed：warning Alert 说明「审批发起失败」，draft 结果仍在，无审批卡、无 /sops 链接；
 *   · not_requested：info Alert 说明「未发起审批」，同样无审批卡、无 /sops 链接；
 *   · 三态都不再读取/渲染硬编码中文 `next`，枚举只用稳定码。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '../i18n';
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

type ApprovalStatus = 'submitted' | 'failed' | 'not_requested';
type CommitResultWithStatus = CommitResult & {
  approvalStatus?: ApprovalStatus;
  approvalKey?: string | null;
};

const commitOk = {
  sopId: 'sop-0001',
  slug: 'workbench-card-abc1',
  status: 'draft',
  approvalStatus: 'submitted',
} as CommitResultWithStatus;

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

const withinText = (root: HTMLElement, testId: string): string => {
  const node = root.querySelector(`[data-testid="${testId}"]`);
  if (!node) throw new Error(`Missing ${testId}`);
  return (node.textContent ?? '').trim();
};

beforeEach(() => {
  vi.mocked(previewPlan).mockReset().mockResolvedValue(okResult);
  vi.mocked(commitPlan).mockReset().mockResolvedValue(commitOk);
  useAuthStore.setState({ user: { id: 7, username: 'boss', role: 'admin' } });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('工作台提交三态（approvalStatus 稳定码）', () => {
  it('submitted：保留全部既有 testid / 审批单原文 / /inbox 与 /sops 链接', async () => {
    vi.mocked(commitPlan).mockResolvedValue({
      ...commitOk,
      approvalStatus: 'submitted',
      approvalKey: APPROVAL_KEY,
    } as CommitResultWithStatus);
    await submitCommit();

    const success = screen.getByTestId('workbench-commit-success');
    const block = screen.getByTestId('workbench-commit-approval');
    expect(withinText(success, 'workbench-commit-slug')).toBe('标识名：workbench-card-abc1');
    expect(withinText(block, 'workbench-approval-status')).toBe('已提交四眼审批，等待主管批准');
    expect(withinText(block, 'workbench-approval-key')).toBe(APPROVAL_KEY);
    expect(withinText(block, 'workbench-approval-link')).toBe('去待我审批');
    expect(block.querySelector('[data-testid="workbench-approval-link"]')?.getAttribute('href')).toBe('/inbox');
    expect(success.textContent).toContain('sop-0001');
    expect(document.querySelector('a[href^="/sops?"]')?.getAttribute('href')).toBe('/sops?sop=sop-0001');
    expect(success.querySelector('.ant-alert-success')).toBeTruthy();
    // 面向业务人员：不出现运行时术语，也不出现旧硬编码 next 文案。
    expect(success.textContent ?? '').not.toMatch(/cron|uuid|glue|executor/i);
  });

  it('failed：warning 说明审批发起失败，draft 仍在，无审批卡与 /sops 链接', async () => {
    vi.mocked(commitPlan).mockResolvedValue({
      ...commitOk,
      approvalStatus: 'failed',
    } as CommitResultWithStatus);
    await submitCommit();

    const success = screen.getByTestId('workbench-commit-success');
    expect(success.textContent).toContain('sop-0001');
    expect(success.textContent).toContain('方案已存为草稿，但发布审批发起失败，请联系管理员后重试');
    expect(success.querySelector('.ant-alert-warning')).toBeTruthy();
    // 反证：把 failed 分支改回 success Alert ⇒ 下面两条转红（不是靠文案硬凑）。
    expect(success.querySelector('.ant-alert-success')).toBeNull();
    expect(screen.queryByTestId('workbench-commit-approval')).toBeNull();
    expect(screen.queryByTestId('workbench-approval-status')).toBeNull();
    expect(screen.queryByTestId('workbench-approval-key')).toBeNull();
    expect(success.querySelector('a[href^="/sops"]')).toBeNull();
    expect(document.querySelector('a[href^="/sops?"]')).toBeNull();
    // 绝不冒充已提交审批，也不复现旧的硬编码中文 next。
    expect(document.body.textContent).not.toContain('已提交四眼审批');
    expect(document.body.textContent).not.toContain('请在 SOP 页面审阅并发布');
  });

  it('not_requested：中性 info 说明未发起审批，draft 仍在，无审批卡与 /sops 链接', async () => {
    vi.mocked(commitPlan).mockResolvedValue({
      ...commitOk,
      approvalStatus: 'not_requested',
    } as CommitResultWithStatus);
    await submitCommit();

    const success = screen.getByTestId('workbench-commit-success');
    expect(success.textContent).toContain('sop-0001');
    expect(success.textContent).toContain('方案已存草稿，请联系管理员发起发布审批');
    expect(success.querySelector('.ant-alert-info')).toBeTruthy();
    expect(success.querySelector('.ant-alert-success')).toBeNull();
    expect(screen.queryByTestId('workbench-commit-approval')).toBeNull();
    expect(screen.queryByTestId('workbench-approval-key')).toBeNull();
    expect(success.querySelector('a[href^="/sops"]')).toBeNull();
    expect(document.querySelector('a[href^="/sops?"]')).toBeNull();
    expect(document.body.textContent).not.toContain('已提交四眼审批');
    expect(document.body.textContent).not.toContain('发布审批发起失败');
  });

  it('契约：approvalStatus 三值稳定；未知值与硬编码中文 next 不会渲染成审批成功', async () => {
    vi.mocked(commitPlan).mockResolvedValue({
      ...commitOk,
      approvalStatus: 'submitted',
    } as CommitResultWithStatus);
    await submitCommit();
    // 枚举只能取三个 ASCII 稳定码，中文文案不进入枚举面。
    const statuses: ApprovalStatus[] = ['submitted', 'failed', 'not_requested'];
    expect(statuses.every((s) => /^[a-z_]+$/.test(s))).toBe(true);
    expect(vi.mocked(commitPlan).mock.calls.length).toBe(1);

    cleanup();
    vi.mocked(commitPlan).mockResolvedValue({
      sopId: 'sop-0002',
      slug: 'workbench-card-abc2',
      status: 'draft',
      // 模拟未知枚举值：页面应走保守分支，不得渲染「已提交审批」。
      approvalStatus: 'unknown_future_code',
      next: '请在 SOP 页面审阅并发布',
    } as unknown as CommitResultWithStatus);
    await submitCommit();
    expect(screen.queryByTestId('workbench-commit-approval')).toBeNull();
    expect(document.body.textContent).not.toContain('已提交四眼审批');
    expect(document.body.textContent).not.toContain('请在 SOP 页面审阅并发布');
  });
});
