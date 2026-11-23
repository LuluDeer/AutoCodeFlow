/**
 * R278 · 待办收件箱「口径 + 截断 + 降级」回归（U1/U2/U4/U5）。
 *
 * 本轮要钉死的四条（对应 brief §五 S2 栏）：
 *   ① 一会话两单 ⇒ 徽标显示「待审批 2 单」，而 `agentWaiting` 仍是 **1 会话**
 *      （旧实现把审批单当成会话的第二份计数，或干脆把审批单数报成 null）；
 *   ② `truncated: true` ⇒ 渲染出「共 M 条」；
 *   ③ `total: null` ⇒ 显示「—」而不是 **0**（读不到 ≠ 没有）；
 *   ④ `loadAgentWaiting` 只发 **1** 个 approvals 请求（`toHaveBeenCalledTimes(1)`
 *      钉死，防 N+1 回归——旧实现是「拉 50 个会话 + 逐个 listApprovals」）。
 *
 * 夹具原则：所有计数都用 mock 注入，**不依赖后端**；断言只看用户可见文案与请求次数。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../i18n';
import InboxBadge from '../components/InboxBadge';
import {
  loadInbox,
  loadInboxCounts,
  summarizeInboxCounts,
  splitInboxCounts,
  agentApi,
  type InboxCountMap,
} from '../api/inbox';
import { client } from '../api/client';

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

const counts = (overrides: Partial<InboxCountMap> = {}): InboxCountMap => ({
  deployments: 0,
  agentApprovals: null,
  agentWaiting: 0,
  agentFailures: 0,
  sopClarifications: 0,
  sopBlocked: 0,
  stalled: 0,
  backlogged: 0,
  queueStall: 0,
  recentFailures: null,
  ...overrides,
});

beforeEach(() => {
  vi.mocked(loadInboxCounts).mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('R278/U1 徽标双口径：审批单 ≠ 会话', () => {
  it('① 一个会话两张审批单 ⇒ 徽标「待审批 2 单」，会话仍只算 1 条', async () => {
    vi.mocked(loadInboxCounts).mockResolvedValue(counts({ agentApprovals: 2, agentWaiting: 1 }));
    render(<MemoryRouter><InboxBadge /></MemoryRouter>);

    const approvals = await screen.findByTestId('inbox-badge-approvals');
    await waitFor(() => expect(approvals.textContent).toBe('待审批 2 单'));
    // 会话口径独立显示，且**不被审批单放大**（同一会话的两张单不能变成 2 会话）。
    await waitFor(() => expect(screen.getByTestId('inbox-badge-waiting').textContent).toBe('等待输入 1 会话'));
    // 徽标数字仍是会话去重求和：审批单不参与求和（否则同一会话被算两次）。
    await waitFor(() => expect(screen.getByTestId('inbox-badge').textContent).toContain('1'));
  });

  it('两口径措辞不同：单 / 会话 各自成句，可共存', async () => {
    vi.mocked(loadInboxCounts).mockResolvedValue(counts({ agentApprovals: 2, agentWaiting: 1 }));
    render(<MemoryRouter><InboxBadge /></MemoryRouter>);
    // 徽标在 loading 阶段就先渲染「—」（计数是后续异步落地的）。断言必须等 ready
    // 那一拍，否则「已落地」与「仍在 loading」会互相竞态（CI 上偶发假红）。
    // R279：第三格「会话失败」同理——本用例把它钉成 0（事实为零 ⇒ 不占位）。
    const units = await screen.findByTestId('inbox-badge-units');
    await waitFor(() => expect(units.textContent).toContain('待审批 2 单'));
    expect(units.textContent).toContain('等待输入 1 会话');
    expect(units.textContent).not.toContain('会话失败');
    expect(screen.getByTestId('inbox-badge-approvals').textContent)
      .not.toBe(screen.getByTestId('inbox-badge-waiting').textContent);
  });

  it('summarizeInboxCounts：审批单不参与求和，但仍单独可显示（不再是 null 占位）', () => {
    const c = counts({ deployments: 1, agentApprovals: 5, agentWaiting: 2 });
    expect(summarizeInboxCounts(c)).toBe(3); // 1 + 2，审批单 5 不算进来
    // R279：`failed` 是新增的**独立显示项**，同样不参与 total。
    // R280：`sopClarifications` 同理（与「一会话」没有共同的去重单位）。
    // R286：`sopBlocked` 是第四个独立显示项，同样不进 total。
    expect(splitInboxCounts(c)).toEqual({
      approvals: 5, waiting: 2, failed: 0, sopClarifications: 0, sopBlocked: 0, total: 3,
    });
  });

  it('审批单数未知（null）⇒ 只影响缺口提示，不把总数算成 0', async () => {
    vi.mocked(loadInboxCounts).mockResolvedValue(counts({ agentApprovals: null, agentWaiting: 2 }));
    render(<MemoryRouter><InboxBadge /></MemoryRouter>);
    const approvals = await screen.findByTestId('inbox-badge-approvals');
    expect(approvals.textContent).toBe('待审批 — 单');
    await waitFor(() => expect(screen.getByTestId('inbox-badge-waiting').textContent).toBe('等待输入 2 会话'));
    expect(summarizeInboxCounts(counts({ agentApprovals: null, agentWaiting: 2 }))).toBe(2);
  });

  it('③ 计数整体读不到 ⇒ 徽标显示「—」而不是 0（不伪装成「没有待办」）', async () => {
    vi.mocked(loadInboxCounts).mockResolvedValue(counts({ deployments: null, agentWaiting: null }));
    render(<MemoryRouter><InboxBadge /></MemoryRouter>);
    const badge = await screen.findByTestId('inbox-badge');
    expect(badge.textContent).toContain('—');
    expect(badge.textContent).not.toContain('0');
    // 降级标记挂在徽标容器上（计数读不到 ⇒ 不是「没有待办」）。
    expect(badge.getAttribute('data-degraded')).toBe('true');
  });
});

describe('R278 会话无标题：不退化成 uuid', () => {
  it('sessionTitle:null ⇒ 行标题留空串由页面层回落未命名文案，**不**退回 uuid 当标题', async () => {
    const pending = vi.spyOn(agentApi, 'listPendingApprovals').mockResolvedValue({
      items: [{
        approvalKey: 'k1', sessionId: 'sess-abc', sessionTitle: null, toolName: 'shell',
        reason: null, createdAt: '2026-01-01T00:00:00Z', preview: null, argsDigest: null,
      }],
      total: 1, sessionTotal: 1, returned: 1, truncated: false, degraded: false,
    });
    vi.spyOn(agentApi, 'listApprovals').mockResolvedValue([]);
    vi.spyOn(agentApi, 'list').mockImplementation(async (params) =>
      params?.status === 'waiting_input'
        ? { items: [], total: 0 }
        : { items: [], total: 0 },
    );

    const sections = await loadInbox();
    expect(pending).toHaveBeenCalledTimes(1);
    expect(sections.agentApprovals.items).toHaveLength(1);
    // 契约要求 sessionTitle 为 null 时**不**退回 uuid 当作「标题」：会话对象里
    // title 仍是 null（未知）；loader 层标题留空串，由页面层回落「未命名会话」文案。
    // sessionId 仍保留在 detailUrl 供深链定位，不丢失可定位性。
    expect(sections.agentApprovals.items[0].session?.title).toBeNull();
    expect(sections.agentApprovals.items[0].title).toBe('');
    expect(sections.agentApprovals.items[0].detailUrl).toContain('sess-abc');
  });

  it('会话标题存在时行标题用它（不回落 id）', async () => {
    vi.spyOn(agentApi, 'listPendingApprovals').mockResolvedValue({
      items: [{
        approvalKey: 'k1', sessionId: 'sess-abc', sessionTitle: '构建发布', toolName: 'shell',
        reason: null, createdAt: '2026-01-01T00:00:00Z', preview: null, argsDigest: null,
      }],
      total: 1, sessionTotal: 1, returned: 1, truncated: false, degraded: false,
    });
    vi.spyOn(agentApi, 'listApprovals').mockResolvedValue([]);
    vi.spyOn(agentApi, 'list').mockResolvedValue({ items: [], total: 0 } as never);

    const sections = await loadInbox();
    expect(sections.agentApprovals.items[0].title).toBe('构建发布');
    expect(sections.agentApprovals.items[0].session?.title).toBe('构建发布');
  });
});

describe('R278/U1 计数只发 1 个请求（防 N+1 / 429 回归）', () => {
  it('④ loadAgentWaiting 只发 1 个 approvals 请求，且不再逐会话 listApprovals', async () => {
    const pendingApprovals = vi.spyOn(agentApi, 'listPendingApprovals').mockResolvedValue({
      items: [
        { approvalKey: 'k1', sessionId: 's1', sessionTitle: 'T1', toolName: 'shell', reason: 'r', createdAt: '2026-01-01T00:00:00Z', preview: null, argsDigest: null },
        { approvalKey: 'k2', sessionId: 's1', sessionTitle: 'T1', toolName: 'write', reason: null, createdAt: '2026-01-01T00:00:01Z', preview: null, argsDigest: null },
      ],
      total: 2,
      sessionTotal: 1,
      returned: 2,
      truncated: false,
      degraded: false,
    });
    const listApprovals = vi.spyOn(agentApi, 'listApprovals').mockResolvedValue([]);
    const list = vi.spyOn(agentApi, 'list').mockImplementation(async (params) => {
      if (params?.status === 'waiting_input') {
        return { items: [{ id: 's1', status: 'waiting_input', title: 'T1' } as never], total: 1 };
      }
      return { items: [], total: 0 };
    });

    const sections = await loadInbox();

    // 聚合层允许其他小节失败（本用例只注入 agent 两个源），但 agent 口径必须成立。
    expect(pendingApprovals).toHaveBeenCalledTimes(1);
    expect(listApprovals).not.toHaveBeenCalled();
    // 会话列表仍只发**一次**（等待输入），不是「每会话每审批单一次」。
    expect(list.mock.calls.filter(([p]) => p?.status === 'waiting_input')).toHaveLength(1);
    expect(sections.agentApprovals.items).toHaveLength(2);
    expect(sections.agentApprovals.total).toBe(2);
    expect(sections.agentApprovals.truncated).toBe(false);
    // 同一会话两张单 ⇒ 会话小节仍只有 1 条。
    expect(sections.agentWaiting.items).toHaveLength(1);
  });

  it('loadInboxCounts 只发 1 个 inbox/counts 请求（不再 5 个分散计数请求）', async () => {
    const get = vi.spyOn(client, 'get').mockImplementation(async (url) => {
      if (url === '/agent/inbox/counts') {
        return {
          pendingApprovals: 4, waitingSessions: 2, stalled: 1, backlogged: 0,
          backlogTruncated: false, deployments: 3, queueStall: 0, degraded: false,
        };
      }
      // R286：两个独立读面（澄清 / 阻塞工单）。本用例关心的是主聚合**只发一次**，
      // 故它们照常回 0（真事实为零）。
      if (url === '/sop/clarifications/pending') {
        return { items: [], total: 0, returned: 0, truncated: false, degraded: false };
      }
      if (url === '/sop/assignments/lagging') {
        return { items: [], total: 0, returned: 0, truncated: false, degraded: false };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const map = await loadInboxCounts();
    expect(map).toEqual({
      deployments: 3,
      agentApprovals: 4,
      agentWaiting: 2,
      // R279：契约新增字段；mock 没给 ⇒ null（读不到），绝不是 0。
      agentFailures: null,
      // R280/R286：不在 inbox/counts 里，来自各自读面的 total（这里回 0）。
      sopClarifications: 0,
      sopBlocked: 0,
      stalled: 1,
      backlogged: 0,
      queueStall: 0,
      recentFailures: null,
    });
    // 计数从**三个**端点来：主聚合一次 + 待答复澄清的 total + 阻塞工单的 total
    // （后两者是独立读面，后端没有把它们塞进 inbox/counts）。三路各发一次，没有 N+1。
    expect(get).toHaveBeenCalledTimes(3);
    expect(get.mock.calls.map(([url]) => url).sort()).toEqual([
      '/agent/inbox/counts',
      '/sop/assignments/lagging',
      '/sop/clarifications/pending',
    ]);
  });

  it('inbox/counts 整体 503 ⇒ 全部 null（未知），绝不回落 0', async () => {
    vi.spyOn(client, 'get').mockRejectedValue(new Error('503'));
    const map = await loadInboxCounts();
    expect(Object.values(map).filter((v) => v !== null)).toEqual([]);
    expect(summarizeInboxCounts(map)).toBeNull();
  });
});