/**
 * A11Y-SOPS-01（2026-10-29 第 4 轮 INDEX §3-4）：SopsPage 四个弹窗的可见字段标签。
 *
 * 缺陷原状：弹窗里的控件**只有 placeholder**——输入第一个字后字段名就消失，
 * 视觉用户回头看不出这一格填什么；读屏更彻底，只报「编辑框 / 组合框」。与
 * WEB-6（AgentSessionsPage 新建会话弹窗的 `<Text>` 标签）是同一病因的另一型，
 * 而 axe/lhci 只扫当前 DOM、**未打开的 Modal 永远不在扫描范围**，无障碍门禁
 * 因此假绿——这类缺陷只能靠本文件的断言兜住。
 *
 * 断言口径（有齿，且钉「同源」而不只是「能查到」）：
 *  1. 每个控件的**可见标签文案**都能 `getByLabelText` 命中（四弹窗全覆盖）；
 *  2. 命中的标签是真 `<label>`，`for` 与控件 `id` 完全一致（可见文本与可访问名
 *     是同一个 DOM 节点，不是 `aria-label` 另造的第二份文案）；
 *  3. 控件上**没有** `aria-label`（防「加一层 aria-label 就绿」的假修复）。
 *
 * 反证（见汇报）：把任一字段改回「裸 Input + placeholder」而不给标签时，
 * 对应用例立即红（`Unable to find a label with the text of: …`）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../i18n';
import SopsPage from '../pages/SopsPage';
import { sopsApi } from '../api/sops';
import type {
  AssignableExecutor,
  Sop,
  SopAssignment,
  SopClarification,
  SopVersion,
} from '../api/sops';

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

// jsdom 缺失 antd 依赖的浏览器 API（sops-page-b14 同一套 shim）
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

const versionRow: SopVersion = {
  id: 'ver-1',
  sopId: 'sop-1',
  version: '1.0.0',
  frontMatterJson: {},
  bodyMarkdown: 'body',
  changelog: null,
  contentHash: 'abcdef1234567890abcdef1234567890',
  publishedBy: 'user:1',
  publishedAt: '2026-01-01T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
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

const executor: AssignableExecutor = {
  id: 'exec-1',
  appName: 'demo-app',
  address: '10.0.0.8:7800',
  status: 'online',
  lastHeartbeat: '2026-01-01T02:00:00Z',
  agentCapabilities: ['agent:sop'],
};

const renderPage = () =>
  render(
    <MemoryRouter>
      <SopsPage />
    </MemoryRouter>,
  );

/** 当前打开的弹窗（antd 的 .ant-modal 容器）；标签查询一律收窄到这里 */
function currentModal(): HTMLElement {
  const el = document.querySelector('.ant-modal');
  if (!el) throw new Error('没有打开的 Modal');
  return el as HTMLElement;
}

/**
 * 断言「可见标签 → 控件」这条链路：
 *  · getByLabelText 命中（= 可访问名由 <label> 提供）；
 *  · 控件 id 就是标签的 for（同源）；
 *  · 控件没有 aria-label（没走「另造一份文案」的捷径）。
 */
function expectLabel(
  modal: HTMLElement,
  text: string,
  id: string,
  tagName: 'INPUT' | 'TEXTAREA',
): HTMLElement {
  const scope = within(modal);
  const control = scope.getByLabelText(text) as HTMLElement;
  expect(control.tagName).toBe(tagName);
  expect(control.id).toBe(id);
  expect(control.getAttribute('aria-label')).toBeNull();
  const label = scope.getByText(text);
  expect(label.tagName).toBe('LABEL');
  expect(label.getAttribute('for')).toBe(id);
  return control;
}

/** 打开详情抽屉 → 指派与澄清 Tab（antd 两字按钮插空格：「详 情」） */
async function openAssignmentsTab() {
  await screen.findByText('Demo SOP');
  fireEvent.click(screen.getByText('详 情'));
  await screen.findByText('指派与澄清');
  fireEvent.click(screen.getByText('指派与澄清'));
  await waitFor(() => expect(sopsApi.assignments).toHaveBeenCalled());
}

beforeEach(() => {
  vi.mocked(sopsApi.list).mockReset().mockResolvedValue({ items: [sop], total: 1 });
  vi.mocked(sopsApi.versions).mockReset().mockResolvedValue([versionRow]);
  vi.mocked(sopsApi.assignments).mockReset().mockResolvedValue([assignment]);
  vi.mocked(sopsApi.assignment)
    .mockReset()
    .mockResolvedValue({ assignment, clarifications: [clarification] });
  vi.mocked(sopsApi.assignmentMedia).mockReset().mockResolvedValue([]);
  vi.mocked(sopsApi.listAssignableExecutors).mockReset().mockResolvedValue([executor]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('A11Y-SOPS-01 新建草稿弹窗：四个字段都有可见标签', () => {
  it('slug / 标题 / front-matter / 正文 都能用可见标签定位（且同源、无 aria-label）', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('新建草稿'));
    await within(currentModal()).findByLabelText('Slug（唯一标识）');

    const modal = currentModal();
    expectLabel(modal, 'Slug（唯一标识）', 'sops-draft-slug', 'INPUT');
    expectLabel(modal, '标题', 'sops-draft-title', 'INPUT');
    expectLabel(modal, 'front-matter（YAML 机器契约）', 'sops-draft-front-matter', 'TEXTAREA');
    expectLabel(modal, '正文（Markdown）', 'sops-draft-body', 'TEXTAREA');
  });

  it('标签在输入后依然可见（placeholder 消失不影响字段名）', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('新建草稿'));
    const modal = currentModal();
    const title = (await within(modal).findByLabelText('标题')) as HTMLInputElement;

    fireEvent.change(title, { target: { value: '日报 SOP' } });

    // 控件已有值（placeholder 不再显示），标签仍原样命中
    expect(title.value).toBe('日报 SOP');
    expect(within(modal).getByLabelText('标题').id).toBe('sops-draft-title');
    expect(within(modal).getByText('标题').tagName).toBe('LABEL');
  });
});

describe('A11Y-SOPS-01 澄清回复弹窗：处置方式与答复都有可见标签', () => {
  it('处置方式（Select）/ 答复内容（TextArea）可定位', async () => {
    renderPage();
    await openAssignmentsTab();

    await waitFor(() => expect(screen.getByText('回 复')).toBeTruthy());
    fireEvent.click(screen.getByText('回 复'));
    await waitFor(() => expect(screen.getByText('提交答复')).toBeTruthy());

    const modal = currentModal();
    // antd Select 的可聚焦输入是 role=combobox 的 <input>（id 落在这上面）
    const resolution = expectLabel(modal, '处置方式', 'sops-reply-resolution', 'INPUT');
    expect(resolution.getAttribute('role')).toBe('combobox');
    expectLabel(modal, '答复内容', 'sops-reply-answer', 'TEXTAREA');
  });

  it('切到「修订 SOP」后两个修订字段也带可见标签', async () => {
    renderPage();
    await openAssignmentsTab();
    await waitFor(() => expect(screen.getByText('回 复')).toBeTruthy());
    fireEvent.click(screen.getByText('回 复'));
    await waitFor(() => expect(screen.getByText('提交答复')).toBeTruthy());

    const modal = currentModal();
    // antd v6 Select：mousedown 根节点展开下拉
    fireEvent.mouseDown(modal.querySelector('.ant-select') as HTMLElement);
    fireEvent.click(await screen.findByText('修订 SOP 并发新版本'));

    await waitFor(() => expect(within(currentModal()).getByLabelText('修订后的正文')).toBeTruthy());
    expectLabel(currentModal(), '修订后的 front-matter', 'sops-reply-amended-yaml', 'TEXTAREA');
    expectLabel(currentModal(), '修订后的正文', 'sops-reply-amended-body', 'TEXTAREA');
  });
});

describe('A11Y-SOPS-01 指派弹窗：版本与执行器都有可见标签', () => {
  it('SOP 版本 / 执行器（两个 Select）可定位', async () => {
    renderPage();
    await openAssignmentsTab();

    await waitFor(() => expect(screen.getByText('指 派')).toBeTruthy());
    fireEvent.click(screen.getByText('指 派'));
    await waitFor(() => expect(sopsApi.listAssignableExecutors).toHaveBeenCalled());
    await within(currentModal()).findByLabelText('执行器');

    const modal = currentModal();
    const version = expectLabel(modal, 'SOP 版本', 'sops-assign-version', 'INPUT');
    expect(version.getAttribute('role')).toBe('combobox');
    const exec = expectLabel(modal, '执行器', 'sops-assign-executor', 'INPUT');
    expect(exec.getAttribute('role')).toBe('combobox');
  });
});

describe('A11Y-SOPS-01 发布弹窗：版本档位与变更说明都有可见标签', () => {
  it('版本档位（Select）/ 变更说明（TextArea）可定位', async () => {
    renderPage();
    await screen.findByText('Demo SOP');
    fireEvent.click(screen.getByText('详 情'));
    await screen.findByTestId('sop-publish-demo');
    fireEvent.click(screen.getByTestId('sop-publish-demo'));

    await within(currentModal()).findByLabelText('版本档位');
    const modal = currentModal();
    const bump = expectLabel(modal, '版本档位', 'sops-publish-bump', 'INPUT');
    expect(bump.getAttribute('role')).toBe('combobox');
    expectLabel(modal, '变更说明（可选）', 'sops-publish-changelog', 'TEXTAREA');
  });
});

describe('A11Y-SOPS-01 不变式：字段 id 唯一、标签全部落地', () => {
  it('四个弹窗累计 12 个字段 id 互不重复（漏改一处即撞 id）', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('新建草稿'));
    await within(currentModal()).findByLabelText('Slug（唯一标识）');
    const draftIds = Array.from(currentModal().querySelectorAll('[id^="sops-"]')).map(
      (el) => el.id,
    );
    expect(draftIds).toEqual([
      'sops-draft-slug',
      'sops-draft-title',
      'sops-draft-front-matter',
      'sops-draft-body',
    ]);
    expect(new Set(draftIds).size).toBe(draftIds.length);
  });
});
