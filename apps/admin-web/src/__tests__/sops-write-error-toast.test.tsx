/**
 * UX-B1/B2 回归：SOP 指派 / 澄清答复提交失败时，catch 必须把后端错误交给
 * showApiError（有 errorCode 走本地化字典，无码回落后端 message），不得吞掉 err
 * 再补一条通用兜底 toast（双 toast + 原因不可见）。
 *
 * 与同页 submitPublish / useCancelAssignment 同一口径。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Modal } from 'antd';
import '../i18n';
import SopsPage from '../pages/SopsPage';
import { sopsApi } from '../api/sops';
import { message } from '../utils/toast';
import type { Sop, SopAssignment, SopClarification, AssignableExecutor } from '../api/sops';

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
vi.mock('../utils/toast', () => ({
  message: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

// jsdom 缺失 antd 依赖的浏览器 API（sops-page-b14 同一套 shim）
const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const sop: Sop = {
  id: 'sop-1', slug: 'demo', title: 'Demo SOP', status: 'published', currentVersion: '1.0.0',
  applicationId: null, frontMatterJson: {}, bodyMarkdown: 'body', createdBy: 'tester',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};

const assignment: SopAssignment = {
  id: 'asg-1', sopId: 'sop-1', sopVersion: '1.0.0', targetExecutorId: 'exec-1',
  targetAgentSessionId: null, status: 'in_progress', clarificationRound: 1, maxRounds: 5,
  resultJson: null, parentSessionId: null, pulledAt: '2026-01-01T01:00:00Z',
  lastProgressAt: null, progressJson: null, attempt: 1, lastReplyDeliveredAt: null,
  capabilitySnapshotJson: null, permissionProfileAtPull: null, assignedBy: 'tester',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T02:00:00Z',
};

const clarification: SopClarification = {
  id: 'clr-1', clientClarificationId: null, assignmentId: 'asg-1', round: 1,
  question: '第 3 步弹窗点不动', questionContextJson: null, answer: null, resolution: null,
  newSopVersion: null, mediaRefsJson: null, reviewSessionId: null,
  createdAt: '2026-01-01T01:30:00Z', updatedAt: '2026-01-01T01:30:00Z',
};

const executor: AssignableExecutor = {
  id: 'exec-1', appName: 'alpha-app', address: '10.0.0.1', status: 'online',
  lastHeartbeat: null, agentCapabilities: ['shell'],
};

function renderPage() {
  return render(<MemoryRouter><SopsPage /></MemoryRouter>);
}

async function openAssignmentsTab() {
  await screen.findByText('Demo SOP');
  fireEvent.click(screen.getByText('详 情'));
  await screen.findByText('指派与澄清');
  fireEvent.click(screen.getByText('指派与澄清'));
}

beforeEach(() => {
  vi.mocked(sopsApi.list).mockReset().mockResolvedValue({ items: [sop], total: 1 });
  vi.mocked(sopsApi.versions).mockReset().mockResolvedValue([]);
  vi.mocked(sopsApi.assignments).mockReset().mockResolvedValue([assignment]);
  vi.mocked(sopsApi.assignment).mockReset().mockResolvedValue({ assignment, clarifications: [clarification] });
  vi.mocked(sopsApi.assignmentMedia).mockReset().mockResolvedValue([]);
  vi.mocked(sopsApi.replyClarification).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(sopsApi.assign).mockReset().mockResolvedValue({} as never);
  vi.mocked(sopsApi.listAssignableExecutors).mockReset().mockResolvedValue([executor]);
  vi.mocked(message.success).mockReset();
  vi.mocked(message.error).mockReset();
  vi.mocked(message.warning).mockReset();
});

afterEach(() => {
  Modal.destroyAll();
  cleanup();
  vi.restoreAllMocks();
});

describe('UX-B1：指派提交失败走 showApiError，不吞原因、不弹通用兜底双 toast', () => {
  it('指派被后端拒绝：错误 toast 透出后端 message，不再补「指派失败（核对能力租约…）」通用条', async () => {
    vi.mocked(sopsApi.assign).mockRejectedValueOnce({
      errorCode: 'UX_TEST_UNKNOWN_ASSIGN_CODE',
      message: '执行器能力不满足：缺少 shell 能力',
    });

    renderPage();
    await openAssignmentsTab();

    await waitFor(() => expect(screen.getByText('指 派')).toBeTruthy());
    fireEvent.click(screen.getByText('指 派'));
    await waitFor(() => expect(sopsApi.listAssignableExecutors).toHaveBeenCalled());

    // 选可接单执行器（弹窗内两个 Select：版本在前、执行器在后；antd v6 mousedown 展开下拉）
    const selects = document.querySelectorAll('.ant-modal .ant-select');
    fireEvent.mouseDown(selects[1] as HTMLElement);
    fireEvent.click(await screen.findByText(/alpha-app \(10\.0\.0\.1\)/));

    // 弹窗确认键与抽屉入口文案同为「指 派」，限定 modal 内查找
    const modal = document.querySelector('.ant-modal') as HTMLElement;
    fireEvent.click(within(modal).getByRole('button', { name: /指\s*派/ }));
    await waitFor(() => expect(sopsApi.assign).toHaveBeenCalledTimes(1));

    expect(message.error).toHaveBeenCalledWith('执行器能力不满足：缺少 shell 能力');
    expect(message.error).not.toHaveBeenCalledWith('指派失败（核对执行器能力租约与 SOP 版本）');
  });
});

describe('UX-B2：澄清答复提交失败走 showApiError，不吞原因、不弹通用兜底双 toast', () => {
  it('答复被后端拒绝：错误 toast 透出后端 message，不再补「答复提交失败」通用条', async () => {
    vi.mocked(sopsApi.replyClarification).mockRejectedValueOnce({
      errorCode: 'UX_TEST_UNKNOWN_REPLY_CODE',
      message: '澄清轮次已被推进，本次答复过期',
    });

    renderPage();
    await openAssignmentsTab();

    await waitFor(() => expect(screen.getByText('回 复')).toBeTruthy());
    fireEvent.click(screen.getByText('回 复'));
    await waitFor(() => expect(screen.getByText('提交答复')).toBeTruthy());

    const textarea = document.querySelector('.ant-modal textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '直接答复内容' } });
    fireEvent.click(screen.getByText('提交答复'));
    await waitFor(() => expect(sopsApi.replyClarification).toHaveBeenCalledTimes(1));

    expect(message.error).toHaveBeenCalledWith('澄清轮次已被推进，本次答复过期');
    expect(message.error).not.toHaveBeenCalledWith('答复提交失败');
  });
});
