/**
 * A1 审批闭环（审计轮 #11 → 实施轮 #12，前端半边）回归：AgentSessionsPage
 *  ① 详情抽屉「审批单」页签：列出会话审批单（工具/理由/状态徽标/处置人/时间）；
 *  ② pending 单的批准/拒绝 → 调 grant/deny 端点；成功后提示 + 刷新详情与列表；
 *  ③ resumed=true 的提示说明会话已重新入队；
 *  ④ 409（AGENT_APPROVAL_ALREADY_DECIDED，并发处置后到者）→ 如实提示并刷新。
 *
 * WEB-4（P2，2026-10-29 第 3 轮 web-ux）：审批单的**决策依据**回归：
 *  ⑤ pending 审批行显示该次调用的结构化入参（approvalKey ↔ toolCalls.approvalId）；
 *  ⑥ 理由不截断（200+ 字符全文可查，DOM 含尾部）；
 *  ⑦ 批准必须先过二次确认——未确认不发 grant；
 *  ⑧ 入参缺失（历史审批单）显示「未记录入参（旧审批单）」而不是空白/崩溃。
 *
 * mock 风格对齐 agent-sessions-page-b14.test.tsx（api 层 mock + antd shim）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
// 仅用于 afterEach 的 destroyAll：命令式 Modal.confirm 挂 body 级 holder，cleanup() 清不掉
import { Modal } from 'antd';
import '../i18n';
import AgentSessionsPage from '../pages/AgentSessionsPage';
import { agentApi } from '../api/agent';
import type { AgentApproval, AgentSession, AgentToolCall } from '../api/agent';

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

// jsdom 缺失 antd 依赖的浏览器 API，先行补齐（既有页面测试先例）
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

const sessionOf = (id: string, status: string, waitingFor: string | null = null): AgentSession => ({
  id,
  kind: 'incident',
  status,
  title: `session-${id}`,
  triggerSource: 'cron',
  parentSessionId: null,
  contextJson: {},
  scopeJson: {},
  budgetJson: null,
  resultJson: null,
  summary: null,
  errorMessage: null,
  totalSteps: 1,
  totalTokensIn: 1,
  totalTokensOut: 1,
  totalToolCalls: 0,
  waitingFor,
  startedAt: null,
  finishedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

const approvalOf = (overrides: Partial<AgentApproval>): AgentApproval => ({
  id: 'apr-1',
  approvalKey: 'apr-s-wait-1700000000000',
  sessionId: 's-wait',
  toolName: 'task_restart',
  reason: 'write 类操作需要人工点头（审批策略 writeRequiresApproval=true）',
  status: 'pending',
  decidedBy: null,
  decidedAt: null,
  consumedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

/**
 * 触发这张审批单的那次工具调用。
 *
 * 关联键是 `approvalId`——后端 tool-executor 的 requestApproval 里
 * `const approvalId = approvalKey;`，落库的 approvalId 就是 approvalKey 本身
 * （不是 agent_approvals 的 uuid 主键）。这里照实造数据，避免用错键还测绿。
 */
const toolCallOf = (overrides: Partial<AgentToolCall> = {}): AgentToolCall => ({
  id: 'tc-1',
  sessionId: 's-wait',
  stepId: 'st-1',
  toolName: 'task_restart',
  tier: 'write',
  argsJson: { taskId: 't-42', reason: 'OOM 反复重启' },
  resultJson: null,
  resultTruncated: false,
  status: 'awaiting_approval',
  errorMessage: null,
  approvalId: 'apr-s-wait-1700000000000',
  durationMs: 0,
  createdAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

function renderPage() {
  return render(
    <MemoryRouter>
      <AgentSessionsPage />
    </MemoryRouter>,
  );
}

/** 点第一行「详 情」（antd 两字按钮插空格）打开抽屉并等审批单页签出现 */
async function openDetail(id: string) {
  fireEvent.click((await screen.findAllByText('详 情'))[0]);
  await waitFor(() => expect(agentApi.detail).toHaveBeenCalledWith(id));
  await screen.findByText(/审批单（/);
}

/**
 * 切到「审批单」页签。antd 6 Tabs 的非激活且从未激活的面板**默认不挂载**
 * （@rc-component/motion CSSMotion：removeOnLeave=false 但 leavedClassName
 * 非空且 forceRender 未传时返回 null），因此断言面板内容前必须真实点击
 * 页签（默认激活页签是「推理步骤」）。
 */
async function openApprovalsTab() {
  fireEvent.click(await screen.findByRole('tab', { name: /审批单/ }));
}

/**
 * 命令式确认框（WEB-4 的批准二次确认）落在 body 级 `.ant-modal-confirm` holder 里，
 * 不在 React 根内。footer 顺序固定 [取消, OK]，末位即确认键（既有先例：
 * user-management-page.test.tsx / event-subscriptions-settings.test.tsx）。
 */
function confirmLayer(): HTMLElement {
  const layer = document.body.querySelector('.ant-modal-confirm') as HTMLElement | null;
  expect(layer, '未挂载批准确认框（.ant-modal-confirm）').toBeTruthy();
  return layer!;
}

/** 点确认键（批准并执行） */
async function clickConfirmOk() {
  await waitFor(() => expect(document.body.querySelector('.ant-modal-confirm')).toBeTruthy());
  const btns = Array.from(confirmLayer().querySelectorAll('button')) as HTMLButtonElement[];
  const ok = btns[btns.length - 1];
  expect(ok).toBeTruthy();
  await act(async () => {
    fireEvent.click(ok);
  });
}

/** 点取消键（放弃批准） */
async function clickConfirmCancel() {
  await waitFor(() => expect(document.body.querySelector('.ant-modal-confirm')).toBeTruthy());
  const btns = Array.from(confirmLayer().querySelectorAll('button')) as HTMLButtonElement[];
  const cancel = btns[btns.length - 2];
  expect(cancel).toBeTruthy();
  await act(async () => {
    fireEvent.click(cancel);
  });
}

beforeEach(() => {
  vi.mocked(agentApi.list).mockReset().mockResolvedValue({
    items: [sessionOf('s-wait', 'waiting_input', '等待审批 apr-s-wait-1700000000000')],
    total: 1,
  });
  vi.mocked(agentApi.detail).mockReset().mockImplementation(async (id: string) => ({
    session: sessionOf(id, 'waiting_input', '等待审批 apr-s-wait-1700000000000'),
    steps: [],
    // WEB-4：审批单的决策依据来自这次调用（approvalId 即 approvalKey）
    toolCalls: [toolCallOf()],
    children: [],
  }));
  vi.mocked(agentApi.resume).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(agentApi.listApprovals).mockReset().mockResolvedValue([
    approvalOf({}),
  ]);
  vi.mocked(agentApi.grantApproval).mockReset().mockResolvedValue({
    ok: true,
    approval: {
      approvalKey: 'apr-s-wait-1700000000000',
      status: 'granted',
      decidedBy: 'admin',
      decidedAt: '2026-01-01T00:01:00Z',
      consumedAt: null,
    },
    resumed: true,
  });
  vi.mocked(agentApi.denyApproval).mockReset().mockResolvedValue({
    ok: true,
    approval: {
      approvalKey: 'apr-s-wait-1700000000000',
      status: 'denied',
      decidedBy: 'admin',
      decidedAt: '2026-01-01T00:01:00Z',
      consumedAt: null,
    },
    resumed: false,
  });
  vi.mocked(agentApi.budget).mockReset().mockResolvedValue({
    maxSteps: 40,
    maxTokens: 1000,
    wallClockMs: 60000,
    maxToolCalls: 20,
  });
});

afterEach(() => {
  cleanup();
  // WEB-4：批准确认框走命令式 Modal.confirm，挂在 body 级 holder、不在 React 根里，
  // cleanup() 清不掉；关闭动画在 jsdom 里不会自然结束。既 destroyAll 又摘掉残留节点
  // （双重保险，user-management-page.test.tsx / projects-page.test.tsx 同款）。
  Modal.destroyAll();
  document.querySelectorAll('.ant-modal-wrap, .ant-modal-root').forEach((n) => n.remove());
  vi.restoreAllMocks();
});

describe('A1 审批闭环：详情抽屉「审批单」区块', () => {
  it('打开详情即拉取审批单列表并呈现（工具/理由/状态徽标/处置时间）', async () => {
    renderPage();
    await screen.findByText('session-s-wait');
    await openDetail('s-wait');
    await openApprovalsTab();

    expect(await screen.findByText('task_restart')).toBeTruthy();
    expect(screen.getByText(/write 类操作需要人工点头/)).toBeTruthy();
    // 状态徽标走 agents.approvalStatus.* 词表
    expect(screen.getByText('待批准')).toBeTruthy();
    // 未处置的 decidedBy/decidedAt 呈现占位
    expect(screen.getByText('批 准')).toBeTruthy();
    expect(screen.getByText('拒 绝')).toBeTruthy();
    // waiting_input 行有「等待审批」徽标
    expect(screen.getAllByText('等待审批').length).toBeGreaterThan(0);
  });

  it('已执行单展示执行时刻，granted 卡住的单展示占位（可区分「批准了但没执行」）', async () => {
    vi.mocked(agentApi.listApprovals).mockResolvedValue([
      approvalOf({
        id: 'apr-a',
        approvalKey: 'apr-a',
        toolName: 'stop_deployment',
        status: 'consumed',
        decidedBy: 'admin',
        decidedAt: '2026-01-01T00:01:00Z',
        consumedAt: '2026-01-01T00:05:00Z',
      }),
      approvalOf({
        id: 'apr-b',
        approvalKey: 'apr-b',
        toolName: 'update_task',
        status: 'granted',
        decidedBy: 'admin',
        decidedAt: '2026-01-01T00:02:00Z',
        consumedAt: null,
      }),
    ]);
    renderPage();
    await screen.findByText('session-s-wait');
    await openDetail('s-wait');
    await openApprovalsTab();

    // 列头存在：执行时刻与批准时刻分开（合并成一列就算不出「批准→执行」时延）
    // 注：WEB-4 给本表加了 scroll.x（新增「入参」列后总宽超抽屉宽度），rc-table 在
    // 横向滚动下会额外渲染一行 height:0 / aria-hidden 的**列宽测量行**，列标题因此
    // 在 DOM 里出现两次——这里按「表头存在」判定（本用例的意图），不赌唯一性。
    await waitFor(() => expect(screen.getAllByText('执行时刻').length).toBeGreaterThan(0));
    expect(screen.getByText('已执行（一次性放行）')).toBeTruthy();

    const dateCells = (tool: string) =>
      within(screen.getByText(tool).closest('tr')!)
        .queryAllByText(/2026/)
        .length;
    // consumed 行：decidedAt + consumedAt = 2 个时间格（列表不显示 createdAt）
    expect(dateCells('stop_deployment')).toBe(2);
    // granted 行（批准了但从未执行）：只有 decidedAt，执行时刻是占位
    expect(dateCells('update_task')).toBe(1);
    expect(
      within(screen.getByText('update_task').closest('tr')!).getAllByText('—').length,
    ).toBeGreaterThan(0);
  });

  it('无审批单 → 空态如实提示，不渲染操作按钮', async () => {
    vi.mocked(agentApi.listApprovals).mockResolvedValue([]);
    renderPage();
    await screen.findByText('session-s-wait');
    await openDetail('s-wait');
    await openApprovalsTab();
    expect(await screen.findByText(/无审批单/)).toBeTruthy();
    expect(screen.queryByText('批 准')).toBeNull();
  });
});

describe('A1 审批闭环：处置操作', () => {
  it('批准 → POST grant；resumed=true 提示会话已重新入队；详情与列表刷新', async () => {
    renderPage();
    await screen.findByText('session-s-wait');
    await openDetail('s-wait');
    await openApprovalsTab();

    fireEvent.click(screen.getByText('批 准'));
    // WEB-4：批准要过二次确认（这里点掉确认键）
    await clickConfirmOk();
    await waitFor(() =>
      expect(agentApi.grantApproval).toHaveBeenCalledWith('s-wait', 'apr-s-wait-1700000000000'),
    );
    // resumed=true 的提示
    expect(await screen.findByText(/会话已重新入队/)).toBeTruthy();
    // 刷新详情（审批单列表重拉）与列表（silent 拍）
    await waitFor(() => expect(agentApi.listApprovals).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(agentApi.list).toHaveBeenCalledTimes(2));
  });

  it('拒绝 → POST deny；resumed=false 提示不含重新入队', async () => {
    renderPage();
    await screen.findByText('session-s-wait');
    await openDetail('s-wait');
    await openApprovalsTab();

    fireEvent.click(screen.getByText('拒 绝'));
    await waitFor(() =>
      expect(agentApi.denyApproval).toHaveBeenCalledWith('s-wait', 'apr-s-wait-1700000000000'),
    );
    const toast = await screen.findByText(/已拒绝（apr-s-wait-1700000000000）/);
    expect(toast.textContent).not.toContain('会话已重新入队');
  });

  it('409（并发已处置，拦截器已弹词条提示）→ 不再重复弹错，但刷新详情与列表', async () => {
    const conflict = Object.assign(new Error('审批单已被处置'), {
      __status: 409,
      __toastedByClient: true,
    });
    vi.mocked(agentApi.grantApproval).mockRejectedValueOnce(conflict);
    renderPage();
    await screen.findByText('session-s-wait');
    await openDetail('s-wait');
    await openApprovalsTab();

    fireEvent.click(screen.getByText('批 准'));
    await clickConfirmOk();
    await waitFor(() => expect(agentApi.grantApproval).toHaveBeenCalled());
    // 无重复 toast：文案里不应出现「处置失败」兜底（__toastedByClient 已标）
    await waitFor(() => expect(agentApi.listApprovals).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(agentApi.list).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/处置失败/)).toBeNull();
  });

  it('普通失败 → 兜底提示，且不触发刷新（可重试）', async () => {
    // 裸 Error（无 response.data.errorCode）→ getErrMsg 落到 err.message 原文
    // （「网络断开」），不走「审批单处置失败（{{key}}）」词条——兜底词条只在
    // 错误既无 localized 也无 message 时出现。
    vi.mocked(agentApi.grantApproval).mockRejectedValueOnce(new Error('网络断开'));
    renderPage();
    await screen.findByText('session-s-wait');
    await openDetail('s-wait');
    await openApprovalsTab();

    fireEvent.click(screen.getByText('批 准'));
    await clickConfirmOk();
    expect(await screen.findByText('网络断开')).toBeTruthy();
    expect(agentApi.listApprovals).toHaveBeenCalledTimes(1); // 未刷新
  });
});

/**
 * WEB-4（P2，2026-10-29 第 3 轮 web-ux）：审批单的**决策依据**。
 *
 * 缺陷现场：理由在数据层 `.slice(0, 160)`（hover 的 title 取自同一串，等于也看不到
 * 全文）、入参从不展示，而「批准」单击即执行（grant → 服务端自动 resume → 重放并
 * 真正执行写工具）——审批人实际是在盲签一组具体参数。
 */
describe('WEB-4：审批单的决策依据（入参 / 全文理由 / 批准前确认）', () => {
  /** 详情四合一里只改 toolCalls 的便捷构造 */
  const mockDetail = (toolCalls: AgentToolCall[]) => {
    vi.mocked(agentApi.detail).mockResolvedValue({
      session: sessionOf('s-wait', 'waiting_input', '等待审批 apr-s-wait-1700000000000'),
      steps: [],
      toolCalls,
      children: [],
    });
  };

  async function openApprovals() {
    renderPage();
    await screen.findByText('session-s-wait');
    await openDetail('s-wait');
    await openApprovalsTab();
    await screen.findByText('task_restart');
  }

  it('pending 审批行显示该次调用的结构化入参（approvalKey ↔ approvalId 关联，只读）', async () => {
    mockDetail([
      toolCallOf({ argsJson: { taskId: 't-42', reason: 'OOM 反复重启', dryRun: false } }),
    ]);
    await openApprovals();

    const row = screen.getByText('task_restart').closest('tr')!;
    // 键值列表：键与值都落在同一行（结构化视图，不是一坨 JSON 串）
    expect(within(row).getByText('taskId')).toBeTruthy();
    expect(within(row).getByText('t-42')).toBeTruthy();
    expect(within(row).getByText('dryRun')).toBeTruthy();
    expect(within(row).getByText('false')).toBeTruthy();
    // 只读语义：该行除「批准/拒绝」两个动作外没有输入控件（参数不可在此编辑——
    // 批准的是当时落库的那组参数，改界面改不了执行面）
    expect(within(row).queryAllByRole('textbox')).toHaveLength(0);
    expect(within(row).queryAllByRole('button')).toHaveLength(2);
  });

  it('理由不再截断：200+ 字符的全文（含尾部标记）都在 DOM 里', async () => {
    const tail = '【末尾标记-END】';
    const longReason = `写类工具 task_restart 需人工审批：目标任务 t-42 处于崩溃循环。`.repeat(8) + tail;
    expect(longReason.length).toBeGreaterThan(200);
    vi.mocked(agentApi.listApprovals).mockResolvedValue([approvalOf({ reason: longReason })]);
    await openApprovals();

    // `.slice(0,160)` 会让尾部消失在数据层——这条断言就是反证用的钉子
    expect(document.body.textContent).toContain(tail);
    expect(document.body.textContent).toContain(longReason);
  });

  it('批准先弹二次确认：未确认前不调用 grant，取消后也不调用', async () => {
    mockDetail([toolCallOf({ argsJson: { taskId: 't-42', reason: 'OOM', keepHistory: true, notify: 'ops' } })]);
    await openApprovals();

    fireEvent.click(screen.getByText('批 准'));
    await waitFor(() => expect(document.body.querySelector('.ant-modal-confirm')).toBeTruthy());

    // ① 正文三件套：工具名 + 参数摘要（前 3 项 + 「等 N 项」）+ 不可撤销
    const content = confirmLayer().textContent ?? '';
    expect(content).toContain('task_restart');
    expect(content).toContain('taskId=t-42');
    expect(content).toContain('等 1 项');
    expect(content).toContain('批准后将立即执行且不可撤销');

    // ② 未确认 = 未执行
    expect(agentApi.grantApproval).not.toHaveBeenCalled();

    // ③ 取消 = 什么都不发生（可再次发起）
    await clickConfirmCancel();
    expect(agentApi.grantApproval).not.toHaveBeenCalled();
  });

  it('确认后才真的调用 grant（且只调一次）', async () => {
    await openApprovals();

    fireEvent.click(screen.getByText('批 准'));
    await waitFor(() => expect(document.body.querySelector('.ant-modal-confirm')).toBeTruthy());
    expect(agentApi.grantApproval).not.toHaveBeenCalled();

    await clickConfirmOk();
    await waitFor(() =>
      expect(agentApi.grantApproval).toHaveBeenCalledWith('s-wait', 'apr-s-wait-1700000000000'),
    );
    expect(agentApi.grantApproval).toHaveBeenCalledTimes(1);
  });

  it('入参缺失（历史审批单 / 调用行已清理）→ 显示「未记录入参」而不是空白，且不崩溃', async () => {
    mockDetail([]);
    await openApprovals();

    expect(await screen.findByText('未记录入参（旧审批单）')).toBeTruthy();
    // 批准入口仍在，且确认框的参数摘要同样如实交代缺失（不渲染空串冒充「无参数」）
    fireEvent.click(screen.getByText('批 准'));
    await waitFor(() => expect(document.body.querySelector('.ant-modal-confirm')).toBeTruthy());
    expect(confirmLayer().textContent).toContain('未记录入参（旧审批单）');
  });

  it('工具调用行存在但 argsJson 为 null（旧行）→ 同样落到「未记录入参」', async () => {
    mockDetail([toolCallOf({ argsJson: null })]);
    await openApprovals();
    expect(await screen.findByText('未记录入参（旧审批单）')).toBeTruthy();
  });
});
