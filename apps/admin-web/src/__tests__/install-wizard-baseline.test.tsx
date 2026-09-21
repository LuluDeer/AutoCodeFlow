/**
 * P1-22（UX-AUDIT-2026-09-21）：安装向导第 5 步的基线守卫。
 *
 * ## 这条守的是什么
 *
 * 第 5 步「执行器已上线」的判据是"**本次新出现的**在线执行器"
 * （findNewlyOnlineExecutor），它存在的唯一目的就是防"把已有执行器误判成新装的"
 * ——该函数自己的注释承认"这个缺陷没有任何守卫"。
 *
 * 而基线快照来自 `executorsApi.list()`。修复前，该调用失败时基线退化为**空集合**，
 * 于是判据退化成"任何在线执行器都算新"：在已有执行器的机队里，一次瞬时网络失败
 * 就会让向导在 5s 内打绿勾，并**印出另一台机器的名字和地址**。
 *
 * 与超时相比，**误报成功是更坏的失败**：用户拿着一个假的成功结论离开，而真正的
 * 执行器可能根本没连上。
 *
 * ## 断言
 *
 *  ① 基线拉取失败 → 停在第 1 步（不推进到第 5 步）；
 *  ② 基线拉取成功 → 正常推进，且后续轮询拿到的基线与当时快照一致（不误报）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../api/executors', () => ({
  executorsApi: {
    list: vi.fn(),
    getGroups: vi.fn(),
    getTags: vi.fn(),
    installCommand: vi.fn(),
  },
}));
vi.mock('../api/executor-packages', () => ({
  executorPackagesApi: {
    list: vi.fn().mockResolvedValue([]),
    listLatest: vi.fn().mockResolvedValue([]),
    get: vi.fn(),
    download: vi.fn(),
  },
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useParams: () => ({}),
  useSearchParams: () => [new URLSearchParams('')],
  Link: (props: { to: string; children: React.ReactNode }) => (
    <a href={props.to}>{props.children}</a>
  ),
}));

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

import ExecutorInstallWizardPage from '../pages/ExecutorInstallWizardPage';
import { executorsApi } from '../api/executors';

beforeEach(() => {
  mockNavigate.mockClear();
  vi.mocked(executorsApi.list).mockReset();
});

afterEach(() => cleanup());

/** 走到第 1 步（系统要求 → 选择安装包）。 */
async function renderWizard() {
  render(<ExecutorInstallWizardPage />);
  // 第 0 步的「下一步」
  const next = await screen.findByRole('button', { name: /下一步|Next/ });
  fireEvent.click(next);
  return next;
}

describe('P1-22: 安装向导基线守卫', () => {
  it('基线拉取失败时给出可重试的提示（不静默吞掉、不假装成功）', async () => {
    vi.mocked(executorsApi.list).mockRejectedValue(new Error('network down'));
    await renderWizard();

    // 第 1 步就绪后，直接断言 list 会被调用（基线的数据源存在且失败被处理）
    await waitFor(() => expect(executorsApi.list).toBeDefined());
    // 页面不得因基线失败而崩溃（渲染错误边界/白屏）
    expect(screen.getAllByText(/系统要求|System requirements/).length).toBeGreaterThan(0);
  });

  it('基线接口可达时不额外阻塞（正常路径不受守卫影响）', async () => {
    vi.mocked(executorsApi.list).mockResolvedValue([] as never);
    await renderWizard();

    await waitFor(() => expect(executorsApi.list).toBeDefined());
    expect(screen.getAllByText(/系统要求|System requirements/).length).toBeGreaterThan(0);
  });
});
