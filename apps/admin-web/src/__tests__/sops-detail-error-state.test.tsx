/**
 * R149-F4 回归：SOP 详情抽屉的两个取数面（versions / assignments）。
 *
 * 修复前：
 *   ① 两个 Tab 既无 loading 也无错误态——`openDetail` 的 Promise.all 失败后
 *      三个 Tab 停在空白/「暂无数据」，把「读接口坏了」说成「没有版本/没有指派」；
 *   ② 失败只弹一条**文案错**的 toast：「SOP **列表**加载失败」——真正失败的是
 *      **详情**（GET /sop/:id/versions + /assignments），列表刷新是另一条链路；
 *   ③ 没有重试入口，用户只能关掉重开。
 *
 * 断言口径：
 *   · versions / assignments 任一 reject ⇒ 抽屉内出现 StateError（标题「SOP 详情
 *     加载失败」）+ 重试按钮；toast 文案也是「详情」那句，且**不再**是「列表」；
 *   · 重试 = 就地重取当前 Tab（不关抽屉），成功后错误块消失、数据回归。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../i18n';
import SopsPage from '../pages/SopsPage';
import { sopsApi } from '../api/sops';
import type { Sop, SopVersion } from '../api/sops';
import { message } from '../utils/toast';

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
// 捕获 toast（页面从 utils/toast 取 message）
vi.mock('../utils/toast', () => ({
  message: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
const mockedToast = vi.mocked(message, true);

// jsdom 缺失 antd 依赖的浏览器 API（既有先例 shim）
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
  frontMatterJson: {},
  bodyMarkdown: 'body',
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
  contentHash: 'hash-1',
  publishedBy: 'tester',
  publishedAt: '2026-01-02T00:00:00Z',
  createdAt: '2026-01-02T00:00:00Z',
};

const renderPage = () =>
  render(
    <MemoryRouter>
      <SopsPage />
    </MemoryRouter>,
  );

/** 打开详情抽屉（antd 两字按钮插空格：「详 情」） */
async function openDetailDrawer() {
  await screen.findByText('Demo SOP');
  fireEvent.click(screen.getByText('详 情'));
}

const retryButtons = () => screen.queryAllByRole('button', { name: /重\s*试/ });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sopsApi.list).mockResolvedValue({ items: [sop], total: 1 });
  vi.mocked(sopsApi.versions).mockResolvedValue([versionRow]);
  vi.mocked(sopsApi.assignments).mockResolvedValue([]);
  vi.mocked(sopsApi.assignmentMedia).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('R149-F4 SopsPage 详情抽屉 — versions/assignments 错误态 + 重试', () => {
  it('versions 读取失败：抽屉内出现详情错误态 + 重试，toast 文案是「详情」不是「列表」', async () => {
    vi.mocked(sopsApi.versions).mockRejectedValue(new Error('versions 500'));

    renderPage();
    await openDetailDrawer();

    // ① 错误块（StateError）出现，并且有重试入口
    expect(await screen.findByText('SOP 详情加载失败')).toBeTruthy();
    expect(screen.getByTestId('state-error')).toBeTruthy();
    await waitFor(() => expect(retryButtons().length).toBeGreaterThanOrEqual(1));

    // ② toast 文案修正：详情，不是列表
    expect(mockedToast.error).toHaveBeenCalledWith('SOP 详情加载失败');
    expect(mockedToast.error).not.toHaveBeenCalledWith('SOP 列表加载失败');

    // ③ 两个 Tab 都看到错误态（一次 Promise.all 的失败只报告一次，不按 Tab 重复）
    fireEvent.click(await screen.findByText('版本历史'));
    await waitFor(() => expect(screen.getByText('版本历史')).toBeTruthy());
    expect(screen.getAllByTestId('state-error').length).toBe(1);
    fireEvent.click(await screen.findByText('指派与澄清'));
    await waitFor(() => expect(screen.getByText('指派与澄清')).toBeTruthy());
    expect(screen.getAllByTestId('state-error').length).toBe(1);

    // ④ 读取失败时不得渲染「暂无数据」空态（emptyText 已撤）
    expect(screen.queryByText('暂无数据')).toBeNull();
  });

  it('assignments 读取失败：同样落到详情错误态（不是只有 versions 有错误面）', async () => {
    vi.mocked(sopsApi.assignments).mockRejectedValue(new Error('assignments 502'));

    renderPage();
    await openDetailDrawer();

    expect(await screen.findByText('SOP 详情加载失败')).toBeTruthy();
    expect(retryButtons().length).toBeGreaterThanOrEqual(1);
    expect(mockedToast.error).toHaveBeenCalledWith('SOP 详情加载失败');
  });

  it('重试 = 就地重取（不关抽屉）：成功后错误块消失、版本数据回归', async () => {
    vi.mocked(sopsApi.versions).mockRejectedValueOnce(new Error('versions 500'));

    renderPage();
    await openDetailDrawer();
    expect(await screen.findByText('SOP 详情加载失败')).toBeTruthy();
    expect(sopsApi.versions).toHaveBeenCalledTimes(1);

    // 点重试（第二次成功）
    vi.mocked(sopsApi.versions).mockResolvedValue([versionRow]);
    fireEvent.click(retryButtons()[0]);

    await waitFor(() => expect(sopsApi.versions).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('SOP 详情加载失败')).toBeNull());
    // 抽屉没有被关掉（重试不是「关闭重开」）
    expect(screen.getByText('版本历史')).toBeTruthy();
    expect(screen.getByText('1.0.0')).toBeTruthy();
  });
});
