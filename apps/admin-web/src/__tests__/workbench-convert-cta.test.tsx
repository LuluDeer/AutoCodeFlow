/**
 * 切片 E1（task-16）：workbench→SOP 直连的 CTA（单测 / 内存替身级）。
 *
 * 判据是**渲染副作用**，不是「代码里有 convertSessionToSop」：
 *   · commit submitted + 运行草稿会话已启动 ⇒ 次要 CTA「转为 SOP 草稿并指派」出现；
 *   · 点击 ⇒ convertSessionToSop(sessionId, {cadence})，成功后 message + 结果行
 *     （USER：slug + 可复制深链，不自动跳 ADMIN-only 的 /sops）；
 *     ADMIN：直接 navigate 到 /sops?sop=<id>；
 *   · 审批未 consumed（409 WORKBENCH_CONVERT_APPROVAL_NOT_CONSUMED）⇒ 内联错误
 *     按生成词条 err.WORKBENCH_* 渲染可读文案；
 *   · failed/not_requested 或未启动会话 ⇒ CTA 不出现。
 *
 * HTTP 边界不触网：api/workbench 全 mock；导航用真实 MemoryRouter + Route 探针
 * 断言（/workbench ↔ /sops），比 mock useNavigate 更接近真实用户路径。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { setLanguage } from '../i18n';
import WorkbenchPage from '../pages/WorkbenchPage';
import { openLegacyFlow } from './workbench-legacy-helper';
import {
  previewPlan,
  commitPlan,
  createWorkbenchSession,
  getWorkbenchSession,
  listWorkbenchSessions,
  convertSessionToSop,
  type CommitResult,
  type PreviewPlanResult,
} from '../api/workbench';
import { useAuthStore } from '../store/auth';

vi.mock('../api/workbench', () => ({
  previewPlan: vi.fn(),
  commitPlan: vi.fn(),
  createWorkbenchSession: vi.fn(),
  getWorkbenchSession: vi.fn(),
  listWorkbenchSessions: vi.fn(),
  convertSessionToSop: vi.fn(),
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

const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const CONV_SOP_ID = '55555555-5555-4555-8555-555555555555';

const okResult: PreviewPlanResult = {
  card: {
    title: 'weekly report',
    triggerText: 'every monday',
    capabilityHints: ['read projects'],
    acceptanceText: 'report contains blockers',
    budget: { maxTurns: 12 },
  },
  checks: [{ field: 'goal', status: 'ok', message: 'clear' }],
  eligible: true,
  cardHash: 'abcdef0123456789',
  policyGeneration: '0123456789abcdef',
};

const commitOk: CommitResult = {
  sopId: '11111111-1111-4111-8111-111111111111',
  slug: 'workbench-abcdef01',
  status: 'draft',
  approvalStatus: 'submitted',
};

const detail = {
  sessionId: SESSION_ID,
  kind: 'sop_authoring',
  status: 'running',
  stepCount: 1,
  steps: [{ seq: 1, role: 'assistant', contentPreview: 'draft step' }],
  toolCallCount: 0,
  toolCalls: [],
  approvals: {},
  approvalItems: [],
  artifacts: [],
};

const convertOk = {
  slug: 'weekly-report-sop',
  sopId: CONV_SOP_ID,
  status: 'draft' as const,
  published: false,
  deeplink: `/sops?sop=${CONV_SOP_ID}`,
};

function button(label: string): HTMLButtonElement {
  return screen.getByText(label).closest('button') as HTMLButtonElement;
}

/** 真实路由探针：/workbench 挂页面，/sops 挂着陆标记——ADMIN 成功后可断言真的跳了。 */
function renderPage() {
  render(
    <MemoryRouter initialEntries={['/workbench']}>
      <Routes>
        <Route path="/workbench" element={<WorkbenchPage />} />
        <Route path="/sops" element={<div data-testid="sops-landing" />} />
        <Route path="*" element={<div data-testid="other-landing" />} />
      </Routes>
    </MemoryRouter>,
  );
  openLegacyFlow();
}

async function commitAndStartSession() {
  renderPage();
  fireEvent.change(screen.getByPlaceholderText('例如：每周汇总项目状态并生成报告'), {
    target: { value: 'weekly report' },
  });
  fireEvent.click(button('预览方案'));
  await screen.findByText(okResult.card.title);
  fireEvent.click(button('确认方案'));
  await screen.findByTestId('workbench-commit-success');
  // CTA 需要 sessionId（convert 端点以会话为锚）：先运行草稿再等 CTA 出现。
  fireEvent.click(screen.getByTestId('workbench-run-draft'));
  await screen.findByTestId('workbench-session-panel');
  await screen.findByTestId('workbench-convert-cta');
}

beforeEach(async () => {
  await setLanguage('zh');
  window.localStorage.clear();
  window.history.replaceState({}, '', '/workbench');
  useAuthStore.setState({ user: { id: 42, username: 'alice', role: 'user' } });
  vi.mocked(previewPlan).mockReset().mockResolvedValue(okResult);
  vi.mocked(commitPlan).mockReset().mockResolvedValue(commitOk);
  vi.mocked(createWorkbenchSession).mockReset().mockResolvedValue({
    sessionId: SESSION_ID,
    status: 'pending',
  });
  vi.mocked(getWorkbenchSession).mockReset().mockResolvedValue(detail as never);
  vi.mocked(listWorkbenchSessions).mockReset().mockResolvedValue({ items: [], total: 0 });
  vi.mocked(convertSessionToSop).mockReset().mockResolvedValue(convertOk);
});

afterEach(async () => {
  cleanup();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
  await setLanguage('zh');
});

describe('切片 E1：工作台会话转 SOP 草稿 CTA', () => {
  it('commit submitted + 会话已启动 ⇒ CTA 出现；USER 点击成功 ⇒ message + slug 结果行，不自动跳 /sops', async () => {
    await commitAndStartSession();

    expect(screen.getByTestId('workbench-convert-cta').textContent).toContain('转为 SOP 草稿并指派');
    fireEvent.click(screen.getByTestId('workbench-convert-cta'));

    await screen.findByTestId('workbench-convert-result');
    // 表单未改节奏 ⇒ 用默认 cadence（daily）回带；params 为空时按后端契约省略字段
    expect(convertSessionToSop).toHaveBeenCalledWith(SESSION_ID, { cadence: 'daily' });
    const resultLine = screen.getByTestId('workbench-convert-result');
    expect(resultLine.textContent).toContain('weekly-report-sop');
    // USER 不自动跳 ADMIN-only 页（403 墙纪律）；深链由 copyable 文本承载
    expect(screen.queryByTestId('sops-landing')).toBeNull();
    // CTA 稳定态不再 loading
    expect(screen.getByTestId('workbench-convert-cta').getAttribute('aria-busy')).not.toBe('true');
  });

  it('ADMIN 点击成功 ⇒ navigate 到 /sops?sop=<id>（Route 探针命中）', async () => {
    useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
    await commitAndStartSession();

    fireEvent.click(screen.getByTestId('workbench-convert-cta'));

    await screen.findByTestId('sops-landing');
    expect(convertSessionToSop).toHaveBeenCalledTimes(1);
  });

  it('审批未 consumed（409 稳定码）⇒ 内联错误渲染生成词条文案，草稿不落', async () => {
    vi.mocked(convertSessionToSop).mockReset().mockRejectedValue({
      errorCode: 'WORKBENCH_CONVERT_APPROVAL_NOT_CONSUMED',
      message: 'release approval not consumed',
      params: null,
    });
    await commitAndStartSession();

    fireEvent.click(screen.getByTestId('workbench-convert-cta'));

    const error = await screen.findByTestId('workbench-convert-error');
    expect(error.textContent).toContain('发布审批尚未完成');
    expect(error.textContent).toContain('完成主管四眼审批后才能转为 SOP 草稿');
    expect(screen.queryByTestId('workbench-convert-result')).toBeNull();
  });

  it('commit 未发起审批（not_requested）⇒ CTA 整块不出现', async () => {
    vi.mocked(commitPlan).mockReset().mockResolvedValue({
      ...commitOk,
      approvalStatus: 'not_requested',
    });
    renderPage();
    fireEvent.change(screen.getByPlaceholderText('例如：每周汇总项目状态并生成报告'), {
      target: { value: 'weekly report' },
    });
    fireEvent.click(button('预览方案'));
    await screen.findByText(okResult.card.title);
    fireEvent.click(button('确认方案'));
    await screen.findByTestId('workbench-commit-success');
    expect(screen.queryByTestId('workbench-convert-cta')).toBeNull();
  });
});
