/**
 * B-14（前端最小步）回归：SopsPage
 *  ① 15s 轮询自动刷新——interval 注入（截获 15000ms 定时器回调后手动触发），
 *     标签页不可见时跳过本拍（对齐 ExecutionsPage / app-deployment-polling 先例）；
 *  ② 人工回复表单的修订正文（amendedBodyMarkdown）载荷——API 已支持，
 *     此前表单只给了 front-matter YAML 入口。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import '../i18n';
import SopsPage from '../pages/SopsPage';
import { sopsApi } from '../api/sops';
import type { Sop, SopAssignment, SopClarification } from '../api/sops';

vi.mock('../api/sops', () => ({
  sopsApi: {
    list: vi.fn(),
    get: vi.fn(),
    draft: vi.fn(),
    updateDraft: vi.fn(),
    publish: vi.fn(),
    assign: vi.fn(),
    versions: vi.fn(),
    assignments: vi.fn(),
    assignment: vi.fn(),
    replyClarification: vi.fn(),
    listAssignableExecutors: vi.fn(),
    assignmentMedia: vi.fn(),
    viewMedia: vi.fn(),
  },
}));

// jsdom 缺失 antd 依赖的浏览器 API，先行补齐（对齐 app-deployment-polling 先例）
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

/** 真实 setInterval（截获 15s 轮询定时器时用于放行其它调用） */
const realSetInterval = globalThis.setInterval;

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

const sop: Sop = {
  id: 'sop-1',
  slug: 'demo',
  title: 'Demo SOP',
  status: 'published',
  currentVersion: '1.0.0',
  applicationId: null,
  frontMatterJson: {},
  bodyMarkdown: 'body',
  createdBy: 'tester',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const assignment: SopAssignment = {
  id: 'asg-1',
  sopId: 'sop-1',
  sopVersion: '1.0.0',
  targetExecutorId: 'exec-1',
  targetAgentSessionId: null,
  status: 'in_progress',
  clarificationRound: 1,
  maxRounds: 5,
  resultJson: null,
  parentSessionId: null,
  pulledAt: '2026-01-01T01:00:00Z',
  lastProgressAt: null,
  progressJson: null,
  attempt: 1,
  lastReplyDeliveredAt: null,
  capabilitySnapshotJson: null,
  permissionProfileAtPull: null,
  assignedBy: 'tester',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T02:00:00Z',
};

const clarification: SopClarification = {
  id: 'clr-1',
  clientClarificationId: null,
  assignmentId: 'asg-1',
  round: 1,
  question: '第 3 步弹窗点不动',
  questionContextJson: null,
  answer: null,
  resolution: null,
  newSopVersion: null,
  mediaRefsJson: null,
  reviewSessionId: null,
  createdAt: '2026-01-01T01:30:00Z',
  updatedAt: '2026-01-01T01:30:00Z',
};

beforeEach(() => {
  setVisibility('visible');
  vi.mocked(sopsApi.list).mockReset().mockResolvedValue({ items: [sop], total: 1 });
  vi.mocked(sopsApi.versions).mockReset().mockResolvedValue([]);
  vi.mocked(sopsApi.assignments).mockReset().mockResolvedValue([assignment]);
  vi.mocked(sopsApi.assignment).mockReset().mockResolvedValue({
    assignment,
    clarifications: [clarification],
  });
  vi.mocked(sopsApi.assignmentMedia).mockReset().mockResolvedValue([]);
  vi.mocked(sopsApi.replyClarification).mockReset().mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (document as unknown as Record<string, unknown>).visibilityState;
});

describe('B-14 SopsPage 15s 轮询', () => {
  it('interval 注入：可见时每拍静默刷新；标签页隐藏时跳过本拍', async () => {
    const pollers: Array<() => void> = [];
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, delay?: number) => {
      if (delay === 15_000) {
        pollers.push(fn);
        return 0 as never;
      }
      return realSetInterval(fn as never, delay as never) as never;
    }) as never);

    render(<SopsPage />);
    await waitFor(() => expect(sopsApi.list).toHaveBeenCalledTimes(1));

    // 可见：本拍触发一次静默刷新（不闪 loading，仅多一次请求）
    await act(async () => {
      pollers[0]();
    });
    await waitFor(() => expect(sopsApi.list).toHaveBeenCalledTimes(2));

    // 隐藏：跳过本拍
    setVisibility('hidden');
    await act(async () => {
      pollers[0]();
    });
    expect(sopsApi.list).toHaveBeenCalledTimes(2);
  });
});

describe('B-14 SopsPage 回复表单 bodyMarkdown', () => {
  it('sop_amended 时载荷携带 amendedBodyMarkdown（与 YAML 至少其一）', async () => {
    render(<SopsPage />);

    // 打开详情抽屉 → 指派与澄清 tab（antd 两字按钮插空格：「详 情」）
    await screen.findByText('Demo SOP');
    fireEvent.click(screen.getByText('详 情'));
    await screen.findByText('指派与澄清');
    fireEvent.click(screen.getByText('指派与澄清'));

    // 待回复澄清出现「回复」按钮 → 打开回复弹窗（antd：「回 复」）
    await waitFor(() => expect(screen.getByText('回 复')).toBeTruthy());
    fireEvent.click(screen.getByText('回 复'));
    await waitFor(() => expect(screen.getByText('提交答复')).toBeTruthy());

    // 选择 sop_amended（antd v6 Select：mousedown 根节点展开下拉）
    const selectEl = document.querySelector('.ant-modal .ant-select') as HTMLElement;
    fireEvent.mouseDown(selectEl);
    const option = await screen.findByText('修订 SOP 并发新版本');
    fireEvent.click(option);

    // 弹窗内出现三个文本域：答复 / front-matter YAML / 修订正文
    await waitFor(() => expect(document.querySelectorAll('.ant-modal textarea').length).toBe(3));
    const textareas = document.querySelectorAll('.ant-modal textarea');
    fireEvent.change(textareas[0], { target: { value: '修订说明：补充了弹窗步骤' } });
    fireEvent.change(textareas[1], { target: { value: 'sop:\n  constraints:\n    maxDurationSec: 900' } });
    fireEvent.change(textareas[2], { target: { value: '## 修订后的正文' } });

    fireEvent.click(screen.getByText('提交答复'));
    await waitFor(() => expect(sopsApi.replyClarification).toHaveBeenCalledTimes(1));
    expect(sopsApi.replyClarification).toHaveBeenCalledWith('asg-1', 'clr-1', {
      resolution: 'sop_amended',
      answer: '修订说明：补充了弹窗步骤',
      amendedFrontMatterYaml: 'sop:\n  constraints:\n    maxDurationSec: 900',
      amendedBodyMarkdown: '## 修订后的正文',
    });
  });

  it('answered 时不携带修订字段（正文本域不出现）', async () => {
    render(<SopsPage />);
    await screen.findByText('Demo SOP');
    fireEvent.click(screen.getByText('详 情'));
    await screen.findByText('指派与澄清');
    fireEvent.click(screen.getByText('指派与澄清'));
    await waitFor(() => expect(screen.getByText('回 复')).toBeTruthy());
    fireEvent.click(screen.getByText('回 复'));
    await waitFor(() => expect(screen.getByText('提交答复')).toBeTruthy());

    // 默认 resolution=answered：只有答复一个文本域
    expect(document.querySelectorAll('.ant-modal textarea').length).toBe(1);
    const textarea = document.querySelector('.ant-modal textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '直接答复内容' } });

    fireEvent.click(screen.getByText('提交答复'));
    await waitFor(() => expect(sopsApi.replyClarification).toHaveBeenCalledTimes(1));
    expect(sopsApi.replyClarification).toHaveBeenCalledWith('asg-1', 'clr-1', {
      resolution: 'answered',
      answer: '直接答复内容',
    });
  });
});
