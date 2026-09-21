/**
 * P1-8（UX-AUDIT-2026-09-21）回归：部署失败原因不再被单行省略吞掉。
 *
 * 旧实现：executor-node 非 0 退出只上报 "Exited with code N"，前端用单行
 * ellipsis tooltip 渲染——真正的错误堆栈写在 app.log 里，控制台用户既看不见
 * 也复制不走。修复分两端：
 *   · executor-node：非 0 退出把 app.log 尾部一并上报（deploy-log-tail.spec.ts）；
 *   · 前端：失败详情可展开多行 + 一键复制。
 *
 * 本测试钉住前端行为：长 statusMessage 默认折叠、可展开、有复制按钮；并钉住
 * i18n 键存在（zh/en 双语）。修复前 DeployStatusMessage 不存在 → 长消息只会
 * 单行省略，本测试找不到「展开详情」按钮（红）；修复后转绿。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor, screen, fireEvent } from '@testing-library/react';
import AppDeploymentPage from '../pages/AppDeploymentPage';
import { deploymentsApi } from '../api/applications';
import { executorsApi } from '../api/executors';
import { useAuthStore } from '../store/auth';

vi.mock('../api/applications', () => ({
  deploymentsApi: { list: vi.fn(), deploy: vi.fn(), stop: vi.fn(), upgrade: vi.fn() },
  applicationsApi: { upgradeAll: vi.fn() },
}));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn() },
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

/** 模拟 executor-node 修复后上报的失败原因：退出码 + app.log 尾部堆栈 */
const LONG_FAILURE =
  'Exited with code 1; recent app.log:\n' +
  'booting...\n' +
  'Error: Cannot find module \'./server/main\'\n' +
  '    at Function._resolveFilename (node:internal/modules/cjs/loader:1234:15)\n' +
  '    at Function._load (node:internal/modules/cjs/loader:1080:27)\n' +
  '    at node:entry.js:42:10\n' +
  'x'.repeat(400);

const failedDeployment = {
  id: 'd-fail',
  applicationId: 'app-1',
  executorAddress: '10.0.0.5',
  status: 'failed',
  runMode: 'daemon',
  startedAt: null,
  updatedAt: '2026-09-21T10:00:00Z',
  createdAt: '2026-09-21T09:59:00Z',
  appName: 'demo-app',
  appVersion: '1.0.0',
  packageType: 'node',
  packageUrl: 'https://example.com/pkg.zip',
  executorName: 'exec-a',
  statusMessage: LONG_FAILURE,
};

describe('P1-8 部署失败详情可展开 + 复制', () => {
  beforeEach(() => {
    useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
    vi.mocked(executorsApi.list).mockReset().mockResolvedValue([] as never);
    vi.mocked(deploymentsApi.list)
      .mockReset()
      .mockResolvedValue({ data: [failedDeployment], total: 1 } as never);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('zh/en 双语都有展开/收起/复制的 i18n 键', async () => {
    const zh = (await import('../locales/zh')).default as Record<string, string>;
    const en = (await import('../locales/en')).default as Record<string, string>;
    for (const dict of [zh, en]) {
      expect(dict['appDeploy.statusMessage.expand']).toBeTruthy();
      expect(dict['appDeploy.statusMessage.collapse']).toBeTruthy();
      expect(dict['appDeploy.statusMessage.copy']).toBeTruthy();
      expect(dict['appDeploy.statusMessage.copied']).toBeTruthy();
    }
  });

  it('长失败原因默认折叠、可展开显示完整堆栈、有复制按钮', async () => {
    render(<AppDeploymentPage applicationId="app-1" />);

    await waitFor(() =>
      expect(screen.getByText(/Cannot find module/)).toBeTruthy(),
    );

    // 折叠态：完整堆栈尾（400 个 x）不应全部可见
    expect(screen.queryByText(new RegExp('x{400}'))).toBeNull();

    // 展开按钮存在
    const expandBtn = screen.getByRole('button', { name: /展开详情|Show details/ });
    fireEvent.click(expandBtn);

    // 展开后：完整堆栈尾可见；按钮变成「收起」
    await waitFor(() =>
      expect(screen.getByText(new RegExp('x{400}'))).toBeTruthy(),
    );
    expect(screen.getByRole('button', { name: /收起|Collapse/ })).toBeTruthy();

    // 复制按钮存在（旧实现无此控件）
    expect(screen.getByRole('button', { name: /复制|Copy/ })).toBeTruthy();
  });

  it('源码守卫：executor 列真的挂载了 DeployStatusMessage（不是又退回单行 ellipsis）', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(
      path.resolve(process.cwd(), 'src/pages/AppDeploymentPage.tsx'),
      'utf-8',
    );
    expect(src).toMatch(/function DeployStatusMessage/);
    expect(src).toMatch(/statusMessage && <DeployStatusMessage/);
  });
});
