/**
 * R289：SOP 单条取消 + 收件箱精准深链（`/inbox` → `/sops?sop=<id>&assignment=<aid>`）贯通回归。
 *
 * 覆盖四类核心契约（全部在底层 `client` HTTP 边界打桩，真实运行 `api/inbox.ts` / `api/sops.ts` / `InboxPage` / `SopsPage`）：
 *   A. 端到端贯通：`/inbox` 阻塞工单深链 → 自动切指派 Tab + 高亮定位 + 澄清联动 → 二次确认带/不带原因取消 → 行翻已取消 + 重派现身 + 澄清回复隐藏 + 派发 `INBOX_REFRESH_EVENT`；
 *   B. 深链边界：跨页 `sopsApi.get` 单取、同 SOP 切换不同 `assignmentId`、失效 `assignmentId` 静默降级无残留高亮、兼容仅 `?sop=<id>`；
 *   C. 七态门控矩阵：4 个活跃非终态（含 `stalled`）可取消、3 态（`failed|stalled|cancelled`）可重派、`cancelled|completed` 隐藏澄清回复（放行 `failed`）；
 *   D. 并发与错误：HTTP 400 `SOP_ASSIGNMENT_TERMINAL` 自动关窗并刷新、500 保留弹窗不丢输入、`detailSeq` 阻断过期慢响应覆写取消后状态。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { Modal } from 'antd';
import '../i18n';
import InboxPage from '../pages/InboxPage';
import SopsPage from '../pages/SopsPage';
import { client } from '../api/client';
import { INBOX_REFRESH_EVENT } from '../api/inbox';
import type { Sop, SopAssignment, SopClarification } from '../api/sops';
import { useAuthStore } from '../store/auth';

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

const SOP_ID = '7c2e1b90-aaaa-4bcd-9ef0-000000000001';
const SOP_OTHER_ID = '7c2e1b90-aaaa-4bcd-9ef0-000000000099';
const ASG_BLOCKED_ID = '7c2e1b90-bbbb-4bcd-9ef0-000000000011';
const ASG_SECOND_ID = '7c2e1b90-bbbb-4bcd-9ef0-000000000022';
const CLAR_ID = '7c2e1b90-cccc-4bcd-9ef0-000000000033';

const hoursAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();

const makeSop = (over: Partial<Sop> = {}): Sop => ({
  id: SOP_ID,
  slug: 'r289-blocked-sop',
  title: 'R289 阻塞处置 SOP',
  status: 'published',
  currentVersion: '1.0.0',
  applicationId: null,
  frontMatterJson: { goal: 'test' },
  bodyMarkdown: '# Body',
  createdBy: 'user:1',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-19T00:00:00.000Z',
  ...over,
});

const makeAssignment = (over: Partial<SopAssignment> = {}): SopAssignment => ({
  id: ASG_BLOCKED_ID,
  sopId: SOP_ID,
  sopVersion: '1.0.0',
  targetExecutorId: 'exec-1',
  targetAgentSessionId: null,
  status: 'blocked',
  clarificationRound: 5,
  maxRounds: 5,
  resultJson: null,
  parentSessionId: null,
  pulledAt: '2026-11-19T00:00:00.000Z',
  lastProgressAt: null,
  progressJson: null,
  attempt: 1,
  lastReplyDeliveredAt: null,
  capabilitySnapshotJson: null,
  permissionProfileAtPull: null,
  assignedBy: 'user:1',
  createdAt: '2026-11-19T00:00:00.000Z',
  updatedAt: hoursAgo(30),
  ...over,
});

const makeClarification = (over: Partial<SopClarification> = {}): SopClarification => ({
  id: CLAR_ID,
  clientClarificationId: null,
  assignmentId: ASG_BLOCKED_ID,
  round: 6,
  question: 'R289 触顶澄清问题：是否终止并换机？',
  questionContextJson: null,
  answer: null,
  resolution: 'escalated_to_human',
  newSopVersion: null,
  mediaRefsJson: null,
  reviewSessionId: null,
  createdAt: hoursAgo(30),
  updatedAt: hoursAgo(30),
  ...over,
});

interface MockBackendState {
  sops: Sop[];
  extraSops?: Record<string, Sop>;
  assignmentsBySop: Record<string, SopAssignment[]>;
  clarificationsByAsg: Record<string, SopClarification[]>;
  laggingItems?: Array<Record<string, unknown>>;
  onCancelPost?: (url: string, body: unknown) => Promise<unknown>;
  onAssignmentsGet?: (sopId: string) => Promise<SopAssignment[]>;
}

/** 仅拦截底层 `client.get` / `client.post`，让真实 `api/inbox.ts` 与 `api/sops.ts` 完整运行。 */
function installHttpBackend(state: MockBackendState) {
  const getSpy = vi.spyOn(client, 'get').mockImplementation(async (url) => {
    if (url === '/app-deployments') return { data: [], total: 0 };
    if (url === '/agent/approvals/pending') return { items: [], total: 0 };
    if (url === '/agent/sessions') return { items: [], total: 0 };
    if (url === '/agent/sessions/backlogged') return { sessionIds: [], total: 0, truncated: false, limit: 100 };
    if (url === '/agent/sessions/queue-stall') return { stalled: false, pendingJobs: 0, degraded: false };
    if (url === '/tasks/recent-failures') return [];
    if (url === '/agent/inbox/counts') {
      return {
        pendingApprovals: 0,
        waitingSessions: 0,
        stalled: 0,
        backlogged: 0,
        backlogTruncated: false,
        failed: 0,
        failedWindowHours: 24,
      };
    }
    if (url === '/sop/clarifications/pending') {
      return { items: [], total: 0, returned: 0, truncated: false, degraded: false };
    }
    if (url === '/sop/assignments/lagging') {
      const items = state.laggingItems ?? [];
      return { items, total: items.length, returned: items.length, truncated: false, degraded: false };
    }
    if (url === '/sop') return { items: state.sops, total: state.sops.length };

    const versionsMatch = /^\/sop\/([^/]+)\/versions$/.exec(url);
    if (versionsMatch) return [];

    const assignmentsMatch = /^\/sop\/([^/]+)\/assignments$/.exec(url);
    if (assignmentsMatch) {
      const sopId = assignmentsMatch[1];
      if (state.onAssignmentsGet) return state.onAssignmentsGet(sopId);
      return state.assignmentsBySop[sopId] ?? [];
    }

    const mediaMatch = /^\/sop\/assignments\/([^/]+)\/media$/.exec(url);
    if (mediaMatch) return [];

    const detailMatch = /^\/sop\/assignments\/([^/]+)$/.exec(url);
    if (detailMatch) {
      const asgId = detailMatch[1];
      const allAsgs = Object.values(state.assignmentsBySop).flat();
      const found = allAsgs.find((a) => a.id === asgId) ?? makeAssignment({ id: asgId });
      return { assignment: found, clarifications: state.clarificationsByAsg[asgId] ?? [] };
    }

    const singleSopMatch = /^\/sop\/([^/]+)$/.exec(url);
    if (singleSopMatch) {
      const id = singleSopMatch[1];
      const hit = state.sops.find((s) => s.id === id) ?? state.extraSops?.[id];
      if (!hit) throw new Error('404');
      return hit;
    }

    throw new Error(`Unexpected GET ${url}`);
  });

  const postSpy = vi.spyOn(client, 'post').mockImplementation(async (url, body) => {
    if (state.onCancelPost && /^\/sop\/assignments\/[^/]+\/cancel$/.test(url)) {
      return state.onCancelPost(url, body);
    }
    throw new Error(`Unexpected POST ${url}`);
  });

  return { getSpy, postSpy };
}

function liveModal(): HTMLElement {
  const modals = Array.from(document.querySelectorAll('.ant-modal')) as HTMLElement[];
  const open = modals.filter((m) => !m.className.includes('ant-zoom-leave'));
  expect(open.length, '未找到活跃 Modal').toBeGreaterThan(0);
  return open[open.length - 1];
}

function modalIsClosed(): boolean {
  const modals = Array.from(document.querySelectorAll('.ant-modal')) as HTMLElement[];
  return modals.every((m) => m.className.includes('ant-zoom-leave'));
}

beforeEach(() => {
  useAuthStore.setState({
    user: { id: 1, username: 'admin', role: 'admin', email: 'a@b.c' } as never,
  });
});

afterEach(() => {
  Modal.destroyAll();
  cleanup();
  vi.restoreAllMocks();
});

describe('R289 A：/inbox → /sops?sop=<id>&assignment=<aid> → 单条取消贯通', () => {
  it('真 client→api/inbox→InboxPage 点击阻塞工单深链直达 SopsPage 指派 Tab、高亮并带原因取消', async () => {
    const asg = makeAssignment({ id: ASG_BLOCKED_ID, status: 'blocked' });
    const state: MockBackendState = {
      sops: [makeSop()],
      assignmentsBySop: { [SOP_ID]: [asg] },
      clarificationsByAsg: { [ASG_BLOCKED_ID]: [makeClarification()] },
      laggingItems: [
        {
          assignmentId: ASG_BLOCKED_ID,
          sopId: SOP_ID,
          sopName: 'R289 阻塞处置 SOP',
          status: 'blocked',
          blockedSince: hoursAgo(30),
          staleClarificationId: CLAR_ID,
          round: 6,
        },
      ],
      onCancelPost: async () => {
        const cancelled: SopAssignment = { ...asg, status: 'cancelled' };
        state.assignmentsBySop[SOP_ID] = [cancelled];
        return { assignment: cancelled, previousStatus: 'blocked' };
      },
    };
    const { postSpy } = installHttpBackend(state);

    let refreshCount = 0;
    const onRefresh = () => { refreshCount += 1; };
    window.addEventListener(INBOX_REFRESH_EVENT, onRefresh);

    try {
      render(
        <MemoryRouter initialEntries={['/inbox']}>
          <Routes>
            <Route path="/inbox" element={<InboxPage />} />
            <Route path="/sops" element={<SopsPage />} />
          </Routes>
        </MemoryRouter>,
      );

      // 1. 收件箱渲染阻塞行并生成带 assignment 的深链
      const inboxRow = within(await screen.findByTestId('inbox-row-sopBlocked'));
      const link = inboxRow.getByRole('link');
      expect(link.getAttribute('href')).toBe(`/sops?sop=${SOP_ID}&assignment=${ASG_BLOCKED_ID}`);

      // 2. 点击深链跳转 /sops → 自动打开抽屉直达「指派与澄清」Tab、高亮目标行与关联澄清
      fireEvent.click(link);
      const targetRow = await waitFor(() => {
        const el = document.getElementById(`sop-assignment-${ASG_BLOCKED_ID}`);
        expect(el).toBeTruthy();
        expect(el?.getAttribute('data-highlighted')).toBe('true');
        return el!;
      });
      const clarCard = await screen.findByTestId(`sop-clarification-${CLAR_ID}`);
      expect(clarCard.getAttribute('data-highlighted')).toBe('true');
      expect(within(clarCard).getByRole('button', { name: /回\s*复/ })).toBeTruthy();

      // 3. 点击「取消指派」打开二次确认弹窗，按可见标签填含前后空格的原因并提交
      fireEvent.click(within(targetRow).getByTestId(`sop-assignment-cancel-${ASG_BLOCKED_ID}`));
      const reasonInput = await screen.findByLabelText('取消原因（可选）');
      fireEvent.change(reasonInput, { target: { value: '  换机重派  ' } });
      const okBtn = within(liveModal()).getByRole('button', { name: '确认取消指派' });
      fireEvent.click(okBtn);

      // 4. 验证真实 HTTP POST 路径与 trim 后载荷
      await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));
      expect(postSpy).toHaveBeenCalledWith(`/sop/assignments/${ASG_BLOCKED_ID}/cancel`, {
        reason: '换机重派',
      });

      // 5. 取消后终态：行翻「已取消」、出现「重派」、取消按钮与澄清「回复」均消失、派发 INBOX_REFRESH_EVENT
      await waitFor(() => {
        const refreshedRow = document.getElementById(`sop-assignment-${ASG_BLOCKED_ID}`);
        expect(refreshedRow?.textContent).toContain('已取消');
        expect(within(refreshedRow!).getByTestId(`sop-assignment-reassign-${ASG_BLOCKED_ID}`)).toBeTruthy();
        expect(within(refreshedRow!).queryByTestId(`sop-assignment-cancel-${ASG_BLOCKED_ID}`)).toBeNull();
      });
      expect(within(screen.getByTestId(`sop-clarification-${CLAR_ID}`)).queryByRole('button', { name: /回\s*复/ })).toBeNull();
      expect(refreshCount).toBeGreaterThanOrEqual(1);
    } finally {
      window.removeEventListener(INBOX_REFRESH_EVENT, onRefresh);
    }
  });

  it('仅填空白取消原因时不携带 reason 键（发 `{}`）', async () => {
    const asg = makeAssignment({ id: ASG_BLOCKED_ID, status: 'blocked' });
    const state: MockBackendState = {
      sops: [makeSop()],
      assignmentsBySop: { [SOP_ID]: [asg] },
      clarificationsByAsg: {},
      onCancelPost: async () => {
        const cancelled: SopAssignment = { ...asg, status: 'cancelled' };
        state.assignmentsBySop[SOP_ID] = [cancelled];
        return { assignment: cancelled, previousStatus: 'blocked' };
      },
    };
    const { postSpy } = installHttpBackend(state);

    render(
      <MemoryRouter initialEntries={[`/sops?sop=${SOP_ID}&assignment=${ASG_BLOCKED_ID}`]}>
        <SopsPage />
      </MemoryRouter>,
    );

    const cancelBtn = await screen.findByTestId(`sop-assignment-cancel-${ASG_BLOCKED_ID}`);
    fireEvent.click(cancelBtn);
    fireEvent.change(await screen.findByLabelText('取消原因（可选）'), { target: { value: '   ' } });
    fireEvent.click(within(liveModal()).getByRole('button', { name: '确认取消指派' }));

    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));
    expect(postSpy).toHaveBeenCalledWith(`/sop/assignments/${ASG_BLOCKED_ID}/cancel`, {});
  });
});

describe('R289 B：深链定位边界与安全降级', () => {
  it('跨页 SOP（不在首页 items）走 GET /sop/:id 单取并高亮目标行；同 SOP 切换不同 assignmentId 重触发定位', async () => {
    const remoteSop = makeSop({ id: SOP_OTHER_ID, slug: 'remote-sop', title: '远程页 SOP' });
    const a1 = makeAssignment({ id: ASG_BLOCKED_ID, sopId: SOP_OTHER_ID, status: 'blocked' });
    const a2 = makeAssignment({ id: ASG_SECOND_ID, sopId: SOP_OTHER_ID, status: 'in_progress' });
    const state: MockBackendState = {
      sops: [makeSop()],
      extraSops: { [SOP_OTHER_ID]: remoteSop },
      assignmentsBySop: { [SOP_OTHER_ID]: [a1, a2] },
      clarificationsByAsg: {},
    };
    const { getSpy } = installHttpBackend(state);

    let nav!: ReturnType<typeof useNavigate>;
    function NavCapture() {
      nav = useNavigate();
      return null;
    }

    render(
      <MemoryRouter initialEntries={[`/sops?sop=${SOP_OTHER_ID}&assignment=${ASG_BLOCKED_ID}`]}>
        <NavCapture />
        <SopsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(document.getElementById(`sop-assignment-${ASG_BLOCKED_ID}`)?.getAttribute('data-highlighted')).toBe('true');
      expect(document.getElementById(`sop-assignment-${ASG_SECOND_ID}`)?.getAttribute('data-highlighted')).toBeNull();
    });
    expect(getSpy).toHaveBeenCalledWith(`/sop/${SOP_OTHER_ID}`);

    // 同 SOP 切到第二条 assignmentId，高亮必须切换且旧高亮清除
    nav(`/sops?sop=${SOP_OTHER_ID}&assignment=${ASG_SECOND_ID}`);
    await waitFor(() => {
      expect(document.getElementById(`sop-assignment-${ASG_SECOND_ID}`)?.getAttribute('data-highlighted')).toBe('true');
      expect(document.getElementById(`sop-assignment-${ASG_BLOCKED_ID}`)?.getAttribute('data-highlighted')).toBeNull();
    });
  });

  it('失效或跨 SOP 的 assignmentId 静默降级停在指派 Tab，不报错且无残留高亮', async () => {
    const state: MockBackendState = {
      sops: [makeSop()],
      assignmentsBySop: { [SOP_ID]: [makeAssignment({ id: ASG_BLOCKED_ID, status: 'blocked' })] },
      clarificationsByAsg: {},
    };
    installHttpBackend(state);

    render(
      <MemoryRouter initialEntries={[`/sops?sop=${SOP_ID}&assignment=nonexistent-asg-id`]}>
        <SopsPage />
      </MemoryRouter>,
    );

    const row = await waitFor(() => {
      const el = document.getElementById(`sop-assignment-${ASG_BLOCKED_ID}`);
      expect(el).toBeTruthy();
      return el!;
    });
    expect(row.getAttribute('data-highlighted')).toBeNull();
    expect(document.querySelectorAll('[data-highlighted="true"]')).toHaveLength(0);
  });

  it('G1：合法 UUID 但不在当前指派列表 → 指派 Tab 顶部呈现「目标指派不存在」中性提示，无残留高亮', async () => {
    const missingId = '7c2e1b90-bbbb-4bcd-9ef0-000000000099';
    const state: MockBackendState = {
      sops: [makeSop()],
      assignmentsBySop: { [SOP_ID]: [makeAssignment({ id: ASG_BLOCKED_ID, status: 'blocked' })] },
      clarificationsByAsg: {},
    };
    installHttpBackend(state);

    render(
      <MemoryRouter initialEntries={[`/sops?sop=${SOP_ID}&assignment=${missingId}`]}>
        <SopsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(document.getElementById(`sop-assignment-${ASG_BLOCKED_ID}`)).toBeTruthy();
    });
    const alert = await screen.findByTestId('sop-assignment-deeplink-missing');
    expect(alert.textContent).toContain('深链指向的指派工单在当前列表中不存在');
    expect(document.querySelectorAll('[data-highlighted="true"]')).toHaveLength(0);
  });
});

describe('R289 C：七态按钮门控与澄清答复隐藏', () => {
  it('assigned/in_progress/blocked/stalled 可取消，failed/stalled/cancelled 可重派，cancelled/completed 隐藏澄清回复且放行 failed', async () => {
    const statuses: SopAssignment['status'][] = [
      'assigned',
      'in_progress',
      'blocked',
      'stalled',
      'completed',
      'failed',
      'cancelled',
    ];
    const asgs = statuses.map((status) => makeAssignment({ id: `asg-${status}`, status }));
    const clars: Record<string, SopClarification[]> = {
      'asg-blocked': [makeClarification({ id: 'clar-blocked', assignmentId: 'asg-blocked' })],
      'asg-failed': [makeClarification({ id: 'clar-failed', assignmentId: 'asg-failed' })],
      'asg-cancelled': [makeClarification({ id: 'clar-cancelled', assignmentId: 'asg-cancelled' })],
      'asg-completed': [makeClarification({ id: 'clar-completed', assignmentId: 'asg-completed' })],
    };
    installHttpBackend({
      sops: [makeSop()],
      assignmentsBySop: { [SOP_ID]: asgs },
      clarificationsByAsg: clars,
    });

    render(
      <MemoryRouter initialEntries={[`/sops?sop=${SOP_ID}&assignment=asg-blocked`]}>
        <SopsPage />
      </MemoryRouter>,
    );

    await screen.findByTestId('sop-assignment-cancel-asg-blocked');

    // 4 个活跃非终态（含 stalled）必须出现「取消指派」
    for (const s of ['assigned', 'in_progress', 'blocked', 'stalled'] as const) {
      expect(screen.getByTestId(`sop-assignment-cancel-asg-${s}`)).toBeTruthy();
    }
    // 3 个终态不得出现「取消指派」
    for (const s of ['completed', 'failed', 'cancelled'] as const) {
      expect(screen.queryByTestId(`sop-assignment-cancel-asg-${s}`)).toBeNull();
    }
    // failed / stalled / cancelled 出现「重派」（stalled 同时有取消与重派）
    for (const s of ['failed', 'stalled', 'cancelled'] as const) {
      expect(screen.getByTestId(`sop-assignment-reassign-asg-${s}`)).toBeTruthy();
    }
    expect(screen.queryByTestId('sop-assignment-reassign-asg-completed')).toBeNull();

    // 澄清答复按钮：blocked & failed 显示；cancelled & completed 隐藏
    expect(within(await screen.findByTestId('sop-clarification-clar-blocked')).getByRole('button', { name: /回\s*复/ })).toBeTruthy();
    expect(within(screen.getByTestId('sop-clarification-clar-failed')).getByRole('button', { name: /回\s*复/ })).toBeTruthy();
    expect(within(screen.getByTestId('sop-clarification-clar-cancelled')).queryByRole('button', { name: /回\s*复/ })).toBeNull();
    expect(within(screen.getByTestId('sop-clarification-clar-completed')).queryByRole('button', { name: /回\s*复/ })).toBeNull();
  });
});

describe('R289 D：并发终态 400 SOP_ASSIGNMENT_TERMINAL 与 detailSeq 竞态守卫', () => {
  it('取消遇 HTTP 400 SOP_ASSIGNMENT_TERMINAL（非 409）自动关闭弹窗、刷新抽屉并派发 INBOX_REFRESH_EVENT', async () => {
    const asg = makeAssignment({ id: ASG_BLOCKED_ID, status: 'blocked' });
    const state: MockBackendState = {
      sops: [makeSop()],
      assignmentsBySop: { [SOP_ID]: [asg] },
      clarificationsByAsg: {},
      onCancelPost: async () => {
        // 模拟另一管理员已先一步取消：服务端已变为 cancelled，本次返回 HTTP 400 + SOP_ASSIGNMENT_TERMINAL
        state.assignmentsBySop[SOP_ID] = [{ ...asg, status: 'cancelled' }];
        throw Object.assign(new Error('Request failed with status code 400'), {
          response: {
            status: 400,
            data: {
              errorCode: 'SOP_ASSIGNMENT_TERMINAL',
              params: { status: 'cancelled' },
              message: '指派已是终态（cancelled）',
            },
          },
        });
      },
    };
    installHttpBackend(state);

    let refreshCount = 0;
    const onRefresh = () => { refreshCount += 1; };
    window.addEventListener(INBOX_REFRESH_EVENT, onRefresh);

    try {
      render(
        <MemoryRouter initialEntries={[`/sops?sop=${SOP_ID}&assignment=${ASG_BLOCKED_ID}`]}>
          <SopsPage />
        </MemoryRouter>,
      );

      fireEvent.click(await screen.findByTestId(`sop-assignment-cancel-${ASG_BLOCKED_ID}`));
      fireEvent.click(within(liveModal()).getByRole('button', { name: '确认取消指派' }));

      await waitFor(() => expect(modalIsClosed()).toBe(true));
      await waitFor(() => {
        const row = document.getElementById(`sop-assignment-${ASG_BLOCKED_ID}`);
        expect(row?.textContent).toContain('已取消');
      });
      expect(refreshCount).toBeGreaterThanOrEqual(1);
    } finally {
      window.removeEventListener(INBOX_REFRESH_EVENT, onRefresh);
    }
  });

  it('取消遇 HTTP 500 保留弹窗与已填原因，不丢失用户输入且不误刷新收件箱', async () => {
    const asg = makeAssignment({ id: ASG_BLOCKED_ID, status: 'blocked' });
    installHttpBackend({
      sops: [makeSop()],
      assignmentsBySop: { [SOP_ID]: [asg] },
      clarificationsByAsg: {},
      onCancelPost: async () => {
        throw Object.assign(new Error('500'), {
          response: { status: 500, data: { message: 'Internal error' } },
        });
      },
    });

    let refreshCount = 0;
    const onRefresh = () => { refreshCount += 1; };
    window.addEventListener(INBOX_REFRESH_EVENT, onRefresh);

    try {
      render(
        <MemoryRouter initialEntries={[`/sops?sop=${SOP_ID}&assignment=${ASG_BLOCKED_ID}`]}>
          <SopsPage />
        </MemoryRouter>,
      );

      fireEvent.click(await screen.findByTestId(`sop-assignment-cancel-${ASG_BLOCKED_ID}`));
      const textarea = (await screen.findByLabelText('取消原因（可选）')) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: '保留我填的原因' } });
      fireEvent.click(within(liveModal()).getByRole('button', { name: '确认取消指派' }));

      await waitFor(() => expect(client.post).toHaveBeenCalledTimes(1));
      expect(modalIsClosed()).toBe(false);
      expect(textarea.value).toBe('保留我填的原因');
      expect(refreshCount).toBe(0);
    } finally {
      window.removeEventListener(INBOX_REFRESH_EVENT, onRefresh);
    }
  });

  it('detailSeq 防覆写：取消前发起的慢速旧详情响应晚于取消后刷新到达，不得把已取消覆写回 blocked', async () => {
    const blockedAsg = makeAssignment({ id: ASG_BLOCKED_ID, status: 'blocked' });
    const cancelledAsg = makeAssignment({ id: ASG_BLOCKED_ID, status: 'cancelled' });
    let resolveSlowRefresh!: (rows: SopAssignment[]) => void;
    let getCallCount = 0;

    const state: MockBackendState = {
      sops: [makeSop()],
      assignmentsBySop: { [SOP_ID]: [blockedAsg] },
      clarificationsByAsg: {},
      onAssignmentsGet: async () => {
        getCallCount += 1;
        // 第 1 次：初始打开；第 2 次：模拟取消前的慢刷新（稍后晚到返回 blocked）；第 3 次：取消后刷新（立即返回 cancelled）
        if (getCallCount === 1) return [blockedAsg];
        if (getCallCount === 2) {
          return new Promise<SopAssignment[]>((resolve) => {
            resolveSlowRefresh = resolve;
          });
        }
        return [cancelledAsg];
      },
      onCancelPost: async () => {
        state.assignmentsBySop[SOP_ID] = [cancelledAsg];
        return { assignment: cancelledAsg, previousStatus: 'blocked' };
      },
    };
    installHttpBackend(state);

    let nav!: ReturnType<typeof useNavigate>;
    function NavCapture() {
      nav = useNavigate();
      return null;
    }

    render(
      <MemoryRouter initialEntries={[`/sops?sop=${SOP_ID}&assignment=${ASG_BLOCKED_ID}`]}>
        <NavCapture />
        <SopsPage />
      </MemoryRouter>,
    );

    // 初始加载完成，点开取消弹窗
    fireEvent.click(await screen.findByTestId(`sop-assignment-cancel-${ASG_BLOCKED_ID}`));
    await screen.findByLabelText('取消原因（可选）');

    // 取消提交前触发一次慢速 openDetail（第 2 次 assignments 请求挂起在途）
    nav(`/sops?sop=${SOP_ID}`);
    await waitFor(() => expect(getCallCount).toBe(2));

    // 提交取消：内部触发第 3 次 openDetail 立即返回 cancelled
    fireEvent.click(within(liveModal()).getByRole('button', { name: '确认取消指派' }));
    await waitFor(() => {
      const row = document.getElementById(`sop-assignment-${ASG_BLOCKED_ID}`);
      expect(row?.textContent).toContain('已取消');
    });

    // 此时才让取消前的慢响应（旧 blocked）落地——detailSeq 必须将其丢弃
    resolveSlowRefresh([blockedAsg]);
    await new Promise((r) => setTimeout(r, 20));
    const finalRow = document.getElementById(`sop-assignment-${ASG_BLOCKED_ID}`);
    expect(finalRow?.textContent).toContain('已取消');
    expect(finalRow?.textContent).not.toContain('等待澄清');
  });
});
