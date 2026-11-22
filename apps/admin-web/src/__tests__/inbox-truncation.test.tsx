/**
 * R278 · 待办收件箱**页面**的截断 / 降级渲染（U2/D2/D3）。
 *
 * 钉死的三条（brief §五 S2 栏）：
 *  ② `truncated: true` ⇒ 小节标题与尾部都渲染「显示前 N 条（共 M 条）」；
 *  ③ `total: null` ⇒ 标题显示 **「—」**（不是 0），并带独立的降级提示；
 *  ④ 有上限但**没有** `total` 字段的小节 ⇒ 只加「最多显示 N 条」的静态说明，
 *     不编造总数（U4：后端未提供 total 时不许假装知道一共有多少条）。
 *
 * 页面用既有 `loadInbox` mock 注入小节状态，**不依赖后端**；断言只看用户可见文案。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '../i18n';
import InboxPage from '../pages/InboxPage';
import { loadInbox, SECTION_PAGE_SIZE } from '../api/inbox';
import { useAuthStore } from '../store/auth';
import type { InboxItem, InboxSectionState, InboxSections } from '../api/inbox';

vi.mock('../api/inbox', { spy: true });

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

const approvalRow = (key: string): InboxItem => ({
  id: `apr-${key}`,
  section: 'agentApprovals',
  title: '会话 A',
  subtitle: 'shell',
  waitingSince: '2026-01-01T00:00:00Z',
  detailUrl: `/agent-sessions?session=s1&tab=approvals&approvalKey=${key}`,
  session: { id: 's1', title: '会话 A' } as never,
  approval: { approvalKey: key, toolName: 'shell', status: 'pending', reason: '' } as never,
});

const ready = (key: InboxSectionState['key'], items: InboxItem[], extra: Partial<InboxSectionState> = {}): InboxSectionState => ({
  key,
  status: 'ready',
  items,
  error: null,
  ...extra,
});

const sections = (overrides: Partial<InboxSections> = {}): InboxSections => ({
  deployments: ready('deployments', []),
  agentApprovals: ready('agentApprovals', []),
  agentWaiting: ready('agentWaiting', []),
  agentFailures: ready('agentFailures', [], { total: 0 }),
  sopClarifications: ready('sopClarifications', [], { total: 0 }),
  sopBlocked: ready('sopBlocked', [], { total: 0 }),
  stalled: ready('stalled', []),
  backlogged: ready('backlogged', []),
  queueStall: ready('queueStall', []),
  recentFailures: ready('recentFailures', []),
  ...overrides,
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/inbox']}>
      <Routes>
        <Route path="/inbox" element={<InboxPage />} />
        <Route path="/agent-sessions" element={<div />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(loadInbox).mockReset();
  useAuthStore.setState({ user: { id: 1, username: 'admin', role: 'admin' } });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('R278/U2 截断可见', () => {
  it('② truncated:true ⇒ 小节标题与提示都渲染「显示前 N 条（共 M 条）」', async () => {
    vi.mocked(loadInbox).mockResolvedValue(
      sections({
        agentApprovals: ready('agentApprovals', [approvalRow('k1'), approvalRow('k2')], {
          total: 37,
          returned: 2,
          truncated: true,
        }),
      }),
    );
    renderPage();

    const section = within(await screen.findByTestId('inbox-section-agentApprovals'));
    expect(screen.getByTestId('inbox-count-agentApprovals').textContent)
      .toContain('显示前 2 条（共 37 条）');
    expect(section.getByTestId('inbox-truncated-agentApprovals').textContent).toContain('共 37 条');
  });

  it('未截断时显示「共 M 条」，不出截断提示', async () => {
    vi.mocked(loadInbox).mockResolvedValue(
      sections({
        agentApprovals: ready('agentApprovals', [approvalRow('k1')], { total: 1, returned: 1, truncated: false }),
      }),
    );
    renderPage();
    await screen.findByTestId('inbox-section-agentApprovals');
    expect(screen.getByTestId('inbox-count-agentApprovals').textContent).toContain('共 1 条');
    expect(screen.queryByTestId('inbox-truncated-agentApprovals')).toBeNull();
  });

  it('U4：有上限但无 total 字段的小节，满页时只说明「最多显示 N 条」，不编造总数', async () => {
    const many = Array.from({ length: SECTION_PAGE_SIZE }, (_, i) => approvalRow(`k${i}`));
    vi.mocked(loadInbox).mockResolvedValue(
      sections({ agentApprovals: ready('agentApprovals', many, { returned: many.length }) }),
    );
    renderPage();
    const section = within(await screen.findByTestId('inbox-section-agentApprovals'));
    const capped = section.getByTestId('inbox-capped-agentApprovals');
    expect(capped.textContent).toContain(`最多显示 ${SECTION_PAGE_SIZE} 条`);
    // 不得出现任何「共 N 条」形式的**伪造**总数。
    expect(screen.getByTestId('inbox-count-agentApprovals').textContent).not.toContain('共');
  });
});

describe('R278/D3 降级不许伪装成 0', () => {
  it('③ total:null ⇒ 标题显示「—」，绝不显示 0，并出独立降级提示', async () => {
    vi.mocked(loadInbox).mockResolvedValue(
      sections({
        agentApprovals: ready('agentApprovals', [], { total: null, returned: 0, degraded: true }),
      }),
    );
    renderPage();

    const count = await screen.findByTestId('inbox-count-agentApprovals');
    expect(count.textContent).toContain('—');
    expect(count.textContent).not.toContain('0');
    expect(count.textContent).toContain('计数不可用');
    const section = within(screen.getByTestId('inbox-section-agentApprovals'));
    expect(section.getByTestId('inbox-degraded-agentApprovals')).toBeTruthy();
  });

  it('degraded:true 但 total 已知 ⇒ 仍提示「计数可能不一致」（下界不是事实）', async () => {
    vi.mocked(loadInbox).mockResolvedValue(
      sections({
        deployments: ready('deployments', [], { total: 4, returned: 0, degraded: true }),
      }),
    );
    renderPage();
    const section = within(await screen.findByTestId('inbox-section-deployments'));
    expect(section.getByTestId('inbox-degraded-deployments').textContent).toContain('可能不一致');
  });

  it('总数已知且未降级 ⇒ 不渲染降级/截断提示（不制造假红）', async () => {
    const dep: InboxItem = {
      id: 'dep-1',
      section: 'deployments',
      title: 'App A',
      waitingSince: '2026-01-01T00:00:00Z',
      detailUrl: '/applications/app-1',
      deployment: { id: 'dep-1', applicationId: 'app-1' } as never,
    };
    vi.mocked(loadInbox).mockResolvedValue(
      sections({ deployments: ready('deployments', [dep], { total: 1, returned: 1, truncated: false }) }),
    );
    renderPage();
    await screen.findByTestId('inbox-section-deployments');
    expect(screen.queryByTestId('inbox-degraded-deployments')).toBeNull();
    expect(screen.queryByTestId('inbox-truncated-deployments')).toBeNull();
    expect(screen.getByTestId('inbox-count-deployments').textContent).toContain('共 1 条');
  });

  it('R278/D3：全部小节计数读不到 + 无条目 ⇒ **不**渲染「当前没有待你处理的事项」', async () => {
    const unknownAll = (key: InboxSectionState['key']): InboxSectionState =>
      ready(key, [], { total: null, returned: 0, degraded: true });
    vi.mocked(loadInbox).mockResolvedValue({
      deployments: unknownAll('deployments'),
      agentApprovals: unknownAll('agentApprovals'),
      agentWaiting: unknownAll('agentWaiting'),
      agentFailures: unknownAll('agentFailures'),
      sopClarifications: unknownAll('sopClarifications'),
      sopBlocked: unknownAll('sopBlocked'),
      stalled: unknownAll('stalled'),
      backlogged: unknownAll('backlogged'),
      queueStall: ready('queueStall', []),
      recentFailures: unknownAll('recentFailures'),
    });
    renderPage();
    await screen.findByTestId('inbox-section-agentApprovals');
    // 「清零」必须是被证实的事实：计数读不到 ⇒ 不许谎报全空。
    expect(screen.queryByText('当前没有待你处理的事项')).toBeNull();
    expect(within(screen.getByTestId('inbox-section-agentApprovals'))
      .getByText(/不能据此认为「没有待办」/)).toBeTruthy();
  });
});

describe('R278/U4 部署小节请求上限', () => {
  it('loadDeployments 显式传 pageSize=100（旧实现不传 ⇒ 后端默认 20）', async () => {
    const { client } = await import('../api/client');
    const get = vi.spyOn(client, 'get').mockImplementation(async (url) => {
      if (url === '/app-deployments/approvals/pending') {
        return {
          data: [{ id: 'dep-1', applicationId: 'app-1', application: { name: 'App' } }],
          total: 42,
        };
      }
      if (url === '/agent/approvals/pending') {
        return { items: [], total: 0, sessionTotal: 0, returned: 0, truncated: false, degraded: false };
      }
      if (url === '/agent/sessions') return { items: [], total: 0 };
      if (url === '/agent/sessions/backlogged') return { sessionIds: [], count: 0, probed: 0, truncated: false };
      if (url === '/agent/sessions/queue-stall') {
        return { stalled: false, reason: null, pendingJobs: 0, degraded: false, degradedCounts: false, workersKnown: true };
      }
      if (url === '/metrics/failures') return [];
      throw new Error(`Unexpected request: ${url}`);
    });

    const result = await loadInbox();
    const depCall = get.mock.calls.find(([url]) => url === '/app-deployments/approvals/pending');
    expect(depCall?.[1]?.params).toMatchObject({ pageSize: SECTION_PAGE_SIZE });
    // 后端确实返回 total ⇒ 截断可如实标记（37 条里只取了 1 条）。
    expect(result.deployments.total).toBe(42);
    expect(result.deployments.truncated).toBe(true);
  });
});