/**
 * 用户报障回归：部署失败后记录无法删除。
 *
 * 原状：app-deployments 只有 stop（停机保行），没有任何删除出口；而 deploy()
 * 恒定 INSERT 新行——「重新部署」几次就在列表里叠几行失败记录，且用户无法清理。
 * 现补 DELETE /app-deployments/:id（仅终态行）+ 行内删除按钮，并修正了
 * 「重新部署会复用这条记录」这条与实现相反的提示文案。
 *
 * 本文件断言 UI 消费面；后端守卫（在途/运行中/待审批 409）由 admin-api
 * app-deployment.service.spec 覆盖。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import AppDeploymentPage from '../pages/AppDeploymentPage';
import { deploymentsApi } from '../api/applications';
import { executorsApi } from '../api/executors';
import { useAuthStore } from '../store/auth';

vi.mock('../api/applications', () => ({
  deploymentsApi: {
    list: vi.fn(),
    deploy: vi.fn(),
    stop: vi.fn(),
    upgrade: vi.fn(),
    remove: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    cancel: vi.fn(),
  },
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

const dep = (overrides: Record<string, unknown> = {}) => ({
  id: 'dep-1',
  applicationId: 'app-1',
  executorAddress: 'executor-a:3001',
  status: 'failed',
  runMode: 'daemon',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

const mockList = (data: ReturnType<typeof dep>[], total = data.length) => {
  vi.mocked(deploymentsApi.list).mockReset().mockResolvedValue({ data, total } as never);
};

beforeEach(() => {
  useAuthStore.setState({ user: { id: 1, username: 'bob', role: 'admin' } });
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(deploymentsApi.remove).mockReset().mockResolvedValue({ ok: true, deletedId: 'dep-1' } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * antd 会在双汉字按钮里插空格，文本匹配需归一化。
 * 注意：Popconfirm 打开的浮层里也有一个「删除」确认按钮，因此**表格行内**的
 * 删除按钮必须限定在表格容器内查找（否则会选到浮层按钮/undefned）。
 */
const findRowBtn = (label: string) =>
  Array.from(document.body.querySelectorAll('.ant-table button')).find(
    (b) => (b.textContent ?? '').replace(/\s/g, '') === label,
  ) as HTMLButtonElement | undefined;

const findConfirmBtn = () =>
  Array.from(document.body.querySelectorAll('.ant-popconfirm button')).find(
    (b) => (b.textContent ?? '').replace(/\s/g, '') === '删除',
  ) as HTMLButtonElement | undefined;

describe('AppDeploymentPage 删除失败的部署记录（用户报障）', () => {
  it('失败行渲染删除按钮；确认后调用 remove(id) 并刷新列表', async () => {
    mockList([dep({ status: 'failed' })]);
    render(<AppDeploymentPage applicationId="app-1" />);

    const delBtn = await waitFor(() => {
      const b = findRowBtn('删除');
      expect(b).toBeTruthy();
      return b as HTMLButtonElement;
    });
    expect(delBtn.disabled).toBe(false);

    fireEvent.click(delBtn);
    // Popconfirm 的确认按钮
    await waitFor(() => expect(screen.getByText('确认删除这条部署记录？')).toBeTruthy());
    const confirm = findConfirmBtn() as HTMLButtonElement;
    fireEvent.click(confirm);

    await waitFor(() => expect(deploymentsApi.remove).toHaveBeenCalledWith('dep-1'));
    // 删除后必须刷新（否则被删行仍留在表里，用户以为没生效）
    await waitFor(() => expect(vi.mocked(deploymentsApi.list).mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('停止行同样可删（终态行都给出口）', async () => {
    mockList([dep({ status: 'stopped' })]);
    render(<AppDeploymentPage applicationId="app-1" />);
    await waitFor(() => expect(findRowBtn('删除')).toBeTruthy());
  });

  it('在途/运行中行不渲染删除按钮（避免删掉在途唯一性载体）', async () => {
    mockList([dep({ id: 'dep-run', status: 'running' })]);
    render(<AppDeploymentPage applicationId="app-1" />);
    // 等表格渲染出来（运行中行有「停止」按钮）
    await waitFor(() => expect(findRowBtn('停止')).toBeTruthy());
    expect(findRowBtn('删除')).toBeUndefined();
  });

  it('后端 409 的说明文案如实呈现给用户（不是通用「操作失败」）', async () => {
    mockList([dep({ status: 'failed' })]);
    vi.mocked(deploymentsApi.remove).mockRejectedValue(
      Object.assign(new Error('conflict'), {
        response: {
          data: {
            message:
              'Deployment dep-1 is in progress (status=deploying); wait for it to finish before deleting the record',
          },
        },
      }),
    );
    render(<AppDeploymentPage applicationId="app-1" />);

    // waitFor 的谓词必须自带断言：无断言的 waitFor 会在首个 tick 就 resolve，
    // 拿到的是尚未渲染完的 DOM（undefined → 后续 fireEvent/属性读取崩）。
    const delBtn = await waitFor(() => {
      const b = findRowBtn('删除');
      expect(b).toBeTruthy();
      return b as HTMLButtonElement;
    });
    fireEvent.click(delBtn);
    await waitFor(() => expect(screen.getByText('确认删除这条部署记录？')).toBeTruthy());
    const confirm = findConfirmBtn() as HTMLButtonElement;
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(screen.getByText(/wait for it to finish before deleting/)).toBeTruthy(),
    );
  });

  it('非 admin：删除按钮禁用', async () => {
    useAuthStore.setState({ user: { id: 2, username: 'dev', role: 'user' } });
    mockList([dep({ status: 'failed' })]);
    render(<AppDeploymentPage applicationId="app-1" />);

    const delBtn = await waitFor(() => {
      const b = findRowBtn('删除');
      expect(b).toBeTruthy();
      return b as HTMLButtonElement;
    });
    expect(delBtn.disabled).toBe(true);
    expect(deploymentsApi.remove).not.toHaveBeenCalled();
  });
});

describe('「重新部署」提示文案与实现一致（不再谎报复用记录）', () => {
  it('源码提示如实说明会新建记录，并指向可删除', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const zh = fs.readFileSync(
      path.resolve(process.cwd(), 'src/locales/zh.ts'),
      'utf8',
    );
    // 旧文案与后端 deploy() 恒定 INSERT 的行为相反（用户被误导），不得回归。
    expect(zh).not.toContain('重新部署会复用本设备的这条记录');
    expect(zh).toContain('重新部署会在本设备新建一条部署记录');
  });
});
