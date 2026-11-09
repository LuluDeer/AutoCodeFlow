/**
 * P3-1 回归（SOP 指派弹窗）：「读取失败 / 加载中」**不得**被显示成
 * 「没有可接指派的执行器」，且失败后必须有可恢复路径。
 *
 * ## 缺陷原状
 *
 * `apps/admin-web/src/pages/SopsPage.tsx` 的 openAssign 先 `setAssignable([])`
 * 再发请求：
 *  ① 请求在途的 100–300ms 内，弹窗已渲染 → 黄色警告「没有可接指派的执行器
 *     ——先在桌面端启用 Agent（能力租约 30 秒续报、2 分钟过期）」——首屏把
 *     「还没读到」谎报成「机群里没有可用机器」，还给出一条**可执行但错误**的
 *     处置建议；
 *  ② 请求 500 / 网络失败时，那条警告**永久**留着，只有一条会消失的 toast，
 *     弹窗内**无重试**，确认键**永久置灰** ⇒ 用户被卡死。
 *
 * 这违反本仓反复点名的纪律「读取失败 ≠ 数据为空」（同仓 ExecutorPackagesPage
 * 的同类问题已修：原位报错 + 重试）。
 *
 * ## 三条判据
 *
 *  ① 请求**在途**时不得出现「没有可接指派的执行器」文字；
 *  ② 请求**失败**时出现错误块与「重新加载」按钮，且**不**出现该文字；
 *  ③ 点「重新加载」后请求**重新发出**（API 被调用两次）。
 *
 * 另加一条**真空态**对照：读到空列表（ready 且空）时该警告**必须**出现——
 * 否则「只在失败时隐藏」也会让真空态静默失语（那同样是缺陷）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../i18n';
import SopsPage from '../pages/SopsPage';
import { sopsApi } from '../api/sops';
import type { Sop, SopAssignment } from '../api/sops';

vi.mock('../api/sops', () => ({
  sopsApi: {
    list: vi.fn(),
    get: vi.fn(),
    draft: vi.fn(),
    updateDraft: vi.fn(),
    publish: vi.fn(),
    deprecate: vi.fn(),
    restore: vi.fn(),
    cancelAssignments: vi.fn(),
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

// jsdom 缺失 antd 依赖的浏览器 API（sops-page-b14 / sops-modals-a11y 同一套 shim）
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

const sop: Sop = {
  id: 'sop-1',
  slug: 'demo',
  title: 'Demo SOP',
  status: 'published',
  currentVersion: '1.0.0',
  applicationId: null,
  frontMatterJson: { sop: { target: { application: 'demo-app' } } },
  bodyMarkdown: '## 步骤',
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
  createdAt: '2026-01-01T01:00:00Z',
  updatedAt: '2026-01-01T02:00:00Z',
};

/** 真空态语义专用文案（「确实没有可接单的执行器」）——断言它**不该**出现。 */
const ASSIGN_EMPTY_TEXT = /没有可接指派的执行器/;
/** 失败态的页内错误块标题（自有词条，与真空态语义分离）。 */
const ASSIGN_ERROR_TEXT = /读取可接指派的执行器失败/;

const renderPage = () =>
  render(
    <MemoryRouter>
      <SopsPage />
    </MemoryRouter>,
  );

/** 打开详情抽屉 → 指派与澄清 Tab → 点「指派」打开指派弹窗 */
async function openAssignDialog() {
  await screen.findByText('Demo SOP');
  fireEvent.click(screen.getByText('详 情'));
  await screen.findByText('指派与澄清');
  fireEvent.click(screen.getByText('指派与澄清'));
  // 「指派」按钮在「指派与澄清」Tab 内（SOP 处于 published ⇒ 按钮可用）
  await waitFor(() => expect(screen.getByText('指 派')).toBeTruthy());
  fireEvent.click(screen.getByText('指 派'));
  await waitFor(() => expect(sopsApi.listAssignableExecutors).toHaveBeenCalled());
}

beforeEach(() => {
  vi.mocked(sopsApi.list).mockReset().mockResolvedValue({ items: [sop], total: 1 });
  vi.mocked(sopsApi.versions).mockReset().mockResolvedValue([]);
  vi.mocked(sopsApi.assignments).mockReset().mockResolvedValue([assignment]);
  vi.mocked(sopsApi.assignment).mockReset().mockResolvedValue({
    assignment,
    clarifications: [],
  });
  vi.mocked(sopsApi.assignmentMedia).mockReset().mockResolvedValue([]);
  vi.mocked(sopsApi.listAssignableExecutors).mockReset().mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('P3-1 指派弹窗：读取失败 / 加载中 ≠ 没有可接指派的执行器', () => {
  it('① 请求在途时不出现「没有可接指派的执行器」（首屏不得先报空态）', async () => {
    // 请求**在途**（永不 resolve）⇒ 弹窗停在 loading 态
    vi.mocked(sopsApi.listAssignableExecutors).mockReset().mockReturnValue(new Promise(() => {}) as never);

    renderPage();
    await openAssignDialog();

    // 弹窗已打开，但空态警告**不**在场（此刻只是「还在读」）
    expect(screen.getByText('指派 SOP')).toBeTruthy();
    expect(screen.queryByText(ASSIGN_EMPTY_TEXT)).toBeNull();
    // loading 指示在场（轻量加载态，不是空态）
    expect(screen.getByText(/正在读取可接指派的执行器/)).toBeTruthy();
  });

  it('② 请求失败时出现错误块与「重新加载」按钮，且不出现空态警告', async () => {
    vi.mocked(sopsApi.listAssignableExecutors)
      .mockReset()
      .mockRejectedValue(new Error('network down'));

    renderPage();
    await openAssignDialog();

    // 错误块（StateError 标准块）+ 标题 + 「重新加载」按钮
    const errorBlock = await screen.findByTestId('state-error');
    expect(errorBlock).toBeTruthy();
    expect(within(errorBlock).getByText(ASSIGN_ERROR_TEXT)).toBeTruthy();
    expect(screen.getByTestId('sop-assign-reload')).toBeTruthy();
    expect(screen.getByText('重新加载')).toBeTruthy();

    // 核心断言：**不**出现真空态警告，也不出现那条错误处置建议
    expect(screen.queryByText(ASSIGN_EMPTY_TEXT)).toBeNull();
  });

  it('③ 点「重新加载」后请求重新发出（API 被调用两次）', async () => {
    vi.mocked(sopsApi.listAssignableExecutors)
      .mockReset()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce([] as never);

    renderPage();
    await openAssignDialog();
    expect(sopsApi.listAssignableExecutors).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('sop-assign-reload'));
    await waitFor(() => expect(sopsApi.listAssignableExecutors).toHaveBeenCalledTimes(2));

    // 重试成功且读到空列表 ⇒ 此刻才渲染真空态警告（错误块消失）
    await waitFor(() => expect(screen.queryByTestId('state-error')).toBeNull());
    expect(screen.getByText(ASSIGN_EMPTY_TEXT)).toBeTruthy();
  });

  it('④ 真空态（读到空列表）时「没有可接指派的执行器」**必须**出现', async () => {
    // 对照用例：防止「把空态警告整个删掉」这种假修复——真空态是有信息的
    vi.mocked(sopsApi.listAssignableExecutors).mockReset().mockResolvedValue([]);

    renderPage();
    await openAssignDialog();

    expect(await screen.findByText(ASSIGN_EMPTY_TEXT)).toBeTruthy();
    expect(screen.queryByTestId('state-error')).toBeNull();
  });
});
