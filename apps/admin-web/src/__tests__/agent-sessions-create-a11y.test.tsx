/**
 * WEB-6（2026-10-29 第三轮 UX 审计 P3）：新建会话弹窗的可访问名与焦点。
 *
 * 缺陷原状：三个字段名是 `<Text type="secondary">` 纯视觉文本，Select/Input/
 * TextArea 既无 `id` 也无 `htmlFor`/`aria-label` → 读屏只报「组合框 / 编辑框」。
 * 而 lhci/axe 只扫当前 DOM，**未打开的 Modal 永远不在扫描范围**，无障碍门禁
 * （lighthouserc.json categories:accessibility ≥ 0.9，error 级）因此假绿——
 * 这类缺陷只能靠本文件的断言兜住。
 *
 * 断言口径（有齿）：
 *  1. `getByLabelText(可见标签文案)` 必须能定位到控件，且标签文本节点与
 *     `<label for>` / 控件 `id` 同源（不是 aria-label 糊的）；
 *  2. 打开 → 焦点进入弹窗首个可交互控件；Esc → 弹窗关闭；关闭后焦点回到
 *     触发按钮。
 *  反证：把 label 改回 `<Text>`，`getByLabelText` 立刻抛 not found（见汇报）。
 *
 * 关于 ConfigProvider motion:false：jsdom 跑不完 rc-motion 的 leave 过渡，
 * 弹窗关闭后 DOM 会带着 `ant-zoom-leave` 滞留，断言「已关闭」会假红。
 * motion:false 让关闭动作同步落定（也是生产里 `prefers-reduced-motion` 用户的
 * 同一路径），其余行为与生产一致。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ConfigProvider } from 'antd';
import AgentSessionsPage from '../pages/AgentSessionsPage';
import { agentApi } from '../api/agent';

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

// jsdom 缺失 antd 依赖的浏览器 API（对齐既有页面测试先例）
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

function renderPage() {
  return render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <MemoryRouter initialEntries={['/agent-sessions']}>
        <AgentSessionsPage />
      </MemoryRouter>
    </ConfigProvider>,
  );
}

/** 打开弹窗并等字段标签就位；返回触发按钮（焦点归还的判据） */
async function openCreateModal() {
  const trigger = screen.getAllByText('新建会话')[0].closest('button');
  expect(trigger).toBeTruthy();
  // 键盘用户的真实路径：触发按钮此刻持有焦点
  trigger!.focus();
  fireEvent.click(trigger!);
  await screen.findByLabelText('会话类型');
  return trigger as HTMLButtonElement;
}

beforeEach(() => {
  vi.mocked(agentApi.list).mockReset().mockResolvedValue({ items: [], total: 0 });
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
  vi.restoreAllMocks();
});

describe('WEB-6 新建会话弹窗：可访问名（可见标签 = 可访问名）', () => {
  it('三个字段都能用可见标签文案定位到控件', async () => {
    renderPage();
    await openCreateModal();

    // ① 会话类型 → antd Select 的可聚焦输入（role=combobox）
    const kind = screen.getByLabelText('会话类型');
    expect(kind.tagName).toBe('INPUT');
    expect(kind.getAttribute('role')).toBe('combobox');

    // ② 标题 → 原生 Input
    const title = screen.getByLabelText('标题');
    expect(title.tagName).toBe('INPUT');

    // ③ 上下文 → 原生 TextArea（标签文案含全角括号，走精确匹配）
    const context = screen.getByLabelText('上下文（JSON 对象，可选）');
    expect(context.tagName).toBe('TEXTAREA');
  });

  it('标签是真实 <label for>，且与控件 id 同源（不是 aria-label 糊的）', async () => {
    renderPage();
    await openCreateModal();

    const cases = [
      { text: '会话类型', id: 'agents-create-kind' },
      { text: '标题', id: 'agents-create-title' },
      { text: '上下文（JSON 对象，可选）', id: 'agents-create-context' },
    ];

    for (const c of cases) {
      const control = screen.getByLabelText(c.text);
      // 可见标签确实是 <label>，不是 <Text>/<span>
      const label = screen.getByText(c.text);
      expect(label.tagName).toBe('LABEL');
      // label[for] === 控件 id → 可见文本与可访问名共用同一节点
      expect(label.getAttribute('for')).toBe(c.id);
      expect(control.id).toBe(c.id);
      // 未用 aria-label 另造一份文案
      expect(control.getAttribute('aria-label')).toBeNull();
    }
  });

  it('读屏可访问名 = 可见标签文案（accessible name 由 label 提供）', async () => {
    renderPage();
    await openCreateModal();
    // testing-library 的 getByLabelText 走的就是 accname 的 label 路径；
    // 再显式核一次「标签文本与控件关联」的 DOM 事实。
    const kind = screen.getByLabelText('会话类型');
    const labelledBy = document.querySelector(`label[for="${kind.id}"]`);
    expect(labelledBy?.textContent).toBe('会话类型');
  });
});

describe('WEB-6 新建会话弹窗：键盘与焦点（A11Y-MODAL-01）', () => {
  it('打开后焦点进入首个可交互控件（不是停在 body / 触发按钮）', async () => {
    renderPage();
    const trigger = await openCreateModal();

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('会话类型'));
    });
    // 焦点确实离开了触发按钮（否则读屏用户仍留在背景页）
    expect(document.activeElement).not.toBe(trigger);
  });

  it('Esc 关闭弹窗，并把焦点归还触发按钮', async () => {
    renderPage();
    const trigger = await openCreateModal();

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByLabelText('会话类型')).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });

  it('Esc 关闭后重新打开：字段标签仍在（未因卸载丢失关联）', async () => {
    renderPage();
    const trigger = await openCreateModal();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByLabelText('会话类型')).toBeNull());

    fireEvent.click(trigger);
    expect(await screen.findByLabelText('会话类型')).toBeTruthy();
    expect(screen.getByLabelText('标题').id).toBe('agents-create-title');
  });
});

describe('WEB-6 新建会话弹窗：可见标签仍是唯一事实源（提交不受影响）', () => {
  it('按标签填入标题/上下文 → create 收到对应载荷（旧用例口径不变）', async () => {
    vi.mocked(agentApi.create).mockResolvedValue({ id: 's-new' } as never);
    renderPage();
    await openCreateModal();

    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '排查日报' } });
    fireEvent.change(screen.getByLabelText('上下文（JSON 对象，可选）'), {
      target: { value: '{"question":"为什么失败"}' },
    });
    // 页头也有一个「新建会话」按钮 → 提交按钮用弹窗作用域收窄
    const modal = document.querySelector('.ant-modal') as HTMLElement;
    fireEvent.click(within(modal).getByRole('button', { name: '新建会话' }));

    await waitFor(() => {
      expect(agentApi.create).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'chat',
          title: '排查日报',
          context: { question: '为什么失败' },
        }),
      );
    });
  });
});
