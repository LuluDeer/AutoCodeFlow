/**
 * ADR-045 · 工作台提交成功后的「已提交四眼审批」区块（`pages/WorkbenchPage.tsx`）。
 *
 * 判据是**渲染副作用**，不是「代码里有 approvalKey」：
 *   · commit 回带 `approvalKey` ⇒ 区块在场，状态文案 / 审批单标识原文 / `/inbox` 入口可见；
 *   · `approvalKey` 缺席（后端 `required: false`，= 审批发起失败）⇒ **整块不渲染**，
 *     绝不编造「已提交审批」；
 *   · 原有草稿结果（sopId / slug / 后续步骤 / 去 SOP 页审阅）逐字不变。
 *
 * 验收级别：单测 / 内存替身（`api/workbench` 被 mock，HTTP 边界不触网）。
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

const commitOk: CommitResult = {
  sopId: 'sop-0001',
  slug: 'workbench-card-abc1',
  status: 'draft',
  next: '请在 SOP 页面审阅并发布',
};

const APPROVAL_KEY = 'apr-11111111-1111-4111-8111-111111111111-cccccccccccccccc';

/**
 * commit 响应 + ADR-045 的 `approvalKey`。
 *
 * `api/workbench.ts` 的 `CommitResult` 尚未登记该字段（本轮写域不含该文件），
 * 故测试侧用同一形状收窄——与 `WorkbenchPage` 的本地扩展类型逐字一致。
 */
type CommitResultWithApproval = CommitResult & { approvalKey?: string | null };

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

beforeEach(() => {
  vi.mocked(previewPlan).mockReset().mockResolvedValue(okResult);
  vi.mocked(commitPlan).mockReset().mockResolvedValue(commitOk);
  useAuthStore.setState({ user: { id: 7, username: 'boss', role: 'admin' } });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ADR-045 工作台提交后的四眼审批状态', () => {
  it('有 approvalKey：状态文案 + 审批单标识原文 + 去 /inbox 入口', async () => {
    vi.mocked(commitPlan).mockResolvedValue({ ...commitOk, approvalKey: APPROVAL_KEY } as CommitResultWithApproval);
    await submitCommit();

    const block = screen.getByTestId('workbench-commit-approval');
    expect(withinText(block, 'workbench-approval-status')).toBe('已提交四眼审批，等待主管批准');
    expect(withinText(block, 'workbench-approval-key')).toBe(APPROVAL_KEY);
    expect(withinText(block, 'workbench-approval-link')).toBe('去待我审批');
    expect(block.querySelector('[data-testid="workbench-approval-link"]')?.getAttribute('href')).toBe('/inbox');
    // 原有草稿结果逐字不变
    expect(block.ownerDocument.body.textContent).toContain('sop-0001');
    expect(block.ownerDocument.body.textContent).toContain('workbench-card-abc1');
    expect(block.ownerDocument.body.textContent).toContain('去 SOP 页审阅');
    // 面向业务人员：不出现运行时术语
    expect(block.ownerDocument.body.textContent ?? '').not.toMatch(/cron|uuid|glue|executor/i);
  });

  it('无 approvalKey（审批发起失败）⇒ 整块不渲染，也不编造「已提交审批」', async () => {
    vi.mocked(commitPlan).mockResolvedValue(commitOk);
    await submitCommit();

    expect(screen.queryByTestId('workbench-commit-approval')).toBeNull();
    expect(screen.queryByTestId('workbench-approval-status')).toBeNull();
    expect(screen.queryByTestId('workbench-approval-key')).toBeNull();
    expect(screen.queryByTestId('workbench-approval-link')).toBeNull();
    expect(document.body.textContent).not.toContain('已提交四眼审批');
    // 草稿结果照常（提交本身成功，只是审批发起失败）
    expect(screen.getByTestId('workbench-commit-success').textContent).toContain('sop-0001');
  });

  it('approvalKey 为空串 ⇒ 视同缺席（不渲染空壳区块）', async () => {
    vi.mocked(commitPlan).mockResolvedValue({ ...commitOk, approvalKey: '   ' } as CommitResultWithApproval);
    await submitCommit();

    expect(screen.queryByTestId('workbench-commit-approval')).toBeNull();
    expect(document.body.textContent).not.toContain('已提交四眼审批');
  });
});

function withinText(root: HTMLElement, testId: string): string {
  const node = root.querySelector(`[data-testid="${testId}"]`);
  if (!node) throw new Error(`Missing ${testId}`);
  return (node.textContent ?? '').trim();
}