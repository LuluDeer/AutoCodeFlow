/**
 * P2-8（UX-AUDIT-2026-09-21，Shard C）：「添加执行器」两套入口无差别说明。
 *
 * ## 旧实现怎么错（红）
 *  列表页右上角「安装向导」（/executors/install 引导式）与「快速添加」
 *  （fetchInstallCmd 只吐一行命令）两个 admin 按钮并排放着，没有任何一句话
 *  区分——用户凭直觉选，可能选错入口。
 *
 * ## 修法（绿）
 *  两个按钮各包一个 Tooltip：installWizard.tip 说明引导式（检测 OS / 配网络模式 /
 *  验证连接），quickAdd.tip 说明只生成一行命令自行执行（脚本化 / 批量装机）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ExecutorListPage from '../pages/ExecutorListPage';
import { executorsApi } from '../api/executors';
import { useAuthStore } from '../store/auth';

vi.mock('../api/executors', () => ({ executorsApi: { list: vi.fn(), getGroups: vi.fn() } }));
vi.mock('../api/client', () => ({ client: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));

const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) { g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; }
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(executorsApi.list).mockResolvedValue([] as never);
  vi.mocked(executorsApi.getGroups).mockResolvedValue([] as never);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/executors']}>
        <Routes>
          <Route path="/executors" element={<ExecutorListPage />} />
          <Route path="/executors/install" element={<div>install-wizard-mock</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup(); vi.clearAllMocks();
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
});
afterEach(() => cleanup());

describe('P2-8: 两套添加入口各有区分说明 Tooltip', () => {
  it('两个 admin 按钮渲染；悬停「安装向导」显示引导式说明', async () => {
    renderPage();
    const wizard = await screen.findByRole('button', { name: /安装向导/ });
    const quickAdd = await screen.findByRole('button', { name: /快速添加/ });
    expect(wizard).toBeTruthy();
    expect(quickAdd).toBeTruthy();

    // 旧实现：无 Tooltip，悬停什么都不出现。
    fireEvent.mouseEnter(wizard);
    await waitFor(() => expect(screen.getByText(/引导式安装/)).toBeTruthy());
  });

  it('悬停「快速添加」显示"只生成一行命令"说明，与向导区分', async () => {
    renderPage();
    const quickAdd = await screen.findByRole('button', { name: /快速添加/ });
    fireEvent.mouseEnter(quickAdd);
    await waitFor(() => expect(screen.getByText(/一行安装命令/)).toBeTruthy());
  });
});
