/**
 * R171（P2-1）：**详情读失败 ≠ 没有步骤/工具调用/子会话**。
 *
 * ## 缺陷现场（`AgentSessionsPage.openDetail`）
 *
 * steps / toolCalls / children 三者来自**同一个** `agentApi.detail` 请求。切会话时
 * 三个数组被清成 `[]`，而请求失败的 catch 里**只弹一条 toast**——数组留在 `[]`。
 * 于是抽屉里三张表渲染 antd 空态、页签计数写 0，用户读到的是：
 *
 *   「推理步骤（0）」+ 空表 +「工具调用（0）」+ 空表 +「子会话（0）」
 *
 * 即「这个会话没有产生任何步骤」。而事实是**没读到**（502/断网/后端抖动）。
 * toast 几秒就消失，留在屏上的是那三个 0。这是本仓反复出现的同一类缺陷。
 *
 * ## 本 spec 钉住四条
 *
 * ① 失败 ⇒ 三个页签计数显示「—」（未知，**不是 0**）+ 面板「读取失败 + 重试」；
 * ② 真空数组（真 0 条）⇒ 计数仍是 0、表格照常渲染、**不出现**失败文案（控制组：
 *    证明①不是一个「永远显示失败」的假绿）；
 * ③ 失败后点「重试」⇒ 复用 openDetail 重新拉取，成功后表格落地、失败文案消失；
 * ④ 与既有 `detailSeq` 序号守卫配合：**先点 A（失败，慢）再点 B（成功，快）**，
 *    A 的失败晚到**不得**把 B 的抽屉标成读取失败（旧响应不许改写当前内容）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Modal } from 'antd';
import '../i18n';
import AgentSessionsPage from '../pages/AgentSessionsPage';
import { agentApi } from '../api/agent';
import type { AgentStep, AgentSession } from '../api/agent';

vi.mock('../api/agent', () => ({
  agentApi: {
    list: vi.fn(),
    detail: vi.fn(),
    resume: vi.fn(),
    budget: vi.fn(),
    create: vi.fn(),
    listApprovals: vi.fn(),
    grantApproval: vi.fn(),
    denyApproval: vi.fn(),
    exportSession: vi.fn(),
  },
  AGENT_SESSION_STATUSES: [
    'pending',
    'running',
    'waiting_input',
    'succeeded',
    'failed',
    'aborted',
    'budget_exceeded',
  ],
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

const sessionOf = (id: string, title: string): AgentSession => ({
  id,
  kind: 'incident',
  status: 'succeeded',
  title,
  triggerSource: 'cron',
  createdBy: 'user:alice',
  parentSessionId: null,
  contextJson: {},
  scopeJson: {},
  budgetJson: null,
  resultJson: null,
  summary: null,
  errorMessage: null,
  totalSteps: 3,
  totalTokensIn: 10,
  totalTokensOut: 20,
  totalToolCalls: 2,
  waitingFor: null,
  startedAt: null,
  finishedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

const stepOf = (id: string, content: string): AgentStep => ({
  id,
  sessionId: 's-a',
  seq: 1,
  role: 'assistant',
  content,
  summary: content,
  reasoning: null,
  toolCallsJson: null,
  toolCallId: null,
  model: 'deepseek-chat',
  provider: 'deepseek',
  tokensIn: 3,
  tokensOut: 5,
  latencyMs: 120,
  createdAt: '2026-01-01T00:00:00Z',
});

function renderPage() {
  return render(
    <MemoryRouter>
      <AgentSessionsPage />
    </MemoryRouter>,
  );
}

/** 点「详情」打开第 index 行的抽屉（抽屉标题是会话标题，用于确认打开的是哪一个）。 */
async function openRow(index: number) {
  const buttons = await screen.findAllByText('详 情');
  fireEvent.click(buttons[index]);
}

const FAIL_TEXT = /读取失败——步骤、工具调用、子会话均未读到/;

beforeEach(() => {
  vi.mocked(agentApi.list).mockReset().mockResolvedValue({
    items: [sessionOf('s-a', '会话 A'), sessionOf('s-b', '会话 B')],
    total: 2,
  });
  vi.mocked(agentApi.listApprovals).mockReset().mockResolvedValue([]);
  vi.mocked(agentApi.budget).mockReset().mockResolvedValue({
    maxSteps: 40,
    maxTokens: 1000,
    wallClockMs: 60000,
    maxToolCalls: 20,
  });
});

afterEach(() => {
  cleanup();
  Modal.destroyAll();
  vi.clearAllMocks();
});

describe('R171 P2-1：详情读取失败必须与「确实 0 条」可区分', () => {
  it('① detail 失败 → 三个页签计数「—」+ 读取失败 + 重试（不再是 0 条空表）', async () => {
    vi.mocked(agentApi.detail).mockReset().mockRejectedValue(new Error('502 Bad Gateway'));

    renderPage();
    await screen.findByText('会话 A');
    await openRow(0);

    expect(await screen.findByText(FAIL_TEXT)).toBeTruthy();
    // 计数是未知态，不是 0（0 会被读成「这个会话零步骤」）
    expect(screen.getByRole('tab', { name: /推理步骤（—）/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /工具调用（—）/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /子会话（—）/ })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /推理步骤（0）/ })).toBeNull();
    expect(screen.getByRole('button', { name: /重\s*试/ })).toBeTruthy();
  });

  it('② 控制组：真的 0 条 → 计数 0、不出现读取失败文案', async () => {
    vi.mocked(agentApi.detail).mockReset().mockResolvedValue({
      session: sessionOf('s-a', '会话 A'),
      steps: [],
      toolCalls: [],
      children: [],
    } as never);

    renderPage();
    await screen.findByText('会话 A');
    await openRow(0);

    expect(await screen.findByRole('tab', { name: /推理步骤（0）/ })).toBeTruthy();
    expect(screen.queryByText(FAIL_TEXT)).toBeNull();
    expect(screen.getByRole('tab', { name: /工具调用（0）/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /子会话（0）/ })).toBeTruthy();
  });

  it('③ 失败后点「重试」→ 重拉 detail，表格落地、失败文案消失', async () => {
    vi.mocked(agentApi.detail)
      .mockReset()
      .mockRejectedValueOnce(new Error('502'))
      .mockResolvedValue({
        session: sessionOf('s-a', '会话 A'),
        steps: [stepOf('st-1', '第一步推理')],
        toolCalls: [],
        children: [],
      } as never);

    renderPage();
    await screen.findByText('会话 A');
    await openRow(0);
    expect(await screen.findByText(FAIL_TEXT)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));

    expect(await screen.findByText('第一步推理')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(FAIL_TEXT)).toBeNull());
    expect(screen.getByRole('tab', { name: /推理步骤（1）/ })).toBeTruthy();
  });

  it('④ 序号守卫：A 的失败晚到不得把 B（成功）的抽屉标成读取失败', async () => {
    vi.mocked(agentApi.detail).mockReset().mockImplementation((async (id: string) => {
      if (id === 's-a') {
        // A 的响应慢且失败——它晚于 B 落地
        await new Promise((resolve) => setTimeout(resolve, 80));
        throw new Error('502');
      }
      return {
        session: sessionOf('s-b', '会话 B'),
        steps: [stepOf('st-b', 'B 的第一步')],
        toolCalls: [],
        children: [],
      };
    }) as never);

    renderPage();
    await screen.findByText('会话 A');
    await openRow(0); // A：慢，将失败
    await openRow(1); // B：快，成功（detailSeq 已前移）

    expect(await screen.findByText('B 的第一步')).toBeTruthy();
    // 等 A 的失败真正落地
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(screen.queryByText(FAIL_TEXT)).toBeNull();
    expect(screen.getByRole('tab', { name: /推理步骤（1）/ })).toBeTruthy();
    expect(screen.getByText('B 的第一步')).toBeTruthy();
  });
});
