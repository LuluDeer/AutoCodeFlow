/**
 * PICKER（执行器选择器数据源）：AppDeploymentPage 部署模态的执行器下拉必须
 * 以 GET /executors/picker（轻读面 + 显式截断旗标）为数据源，而非 GET /executors
 * 的 listLimit(500) **静默截断**列表——执行器总数超限后，旧实现对第 501+ 台
 * 真实存在的执行器假阴性（搜不到）。若实现回退吃 list()，本文件里的候选只挂
 * 在 picker 上，用例立即变红。
 *
 * 同时钉住：
 *   ① 既有过滤行为保留——在线态过滤 + 占用中执行器（本应用活动部署所在机器）
 *      从候选剔除；
 *   ② picker truncated=true 时，下拉内出现显式截断告警（复用 execList.truncated
 *      文案，含全量总数与上限两个数字）——截断必须可见，不许静默。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import AppDeploymentPage from '../pages/AppDeploymentPage';
import { deploymentsApi } from '../api/applications';
import { executorsApi } from '../api/executors';
import { useAuthStore } from '../store/auth';

vi.mock('../api/applications', () => ({
  deploymentsApi: { list: vi.fn(), deploy: vi.fn(), stop: vi.fn(), upgrade: vi.fn() },
  applicationsApi: { upgradeAll: vi.fn() },
}));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn(), picker: vi.fn() },
}));

// jsdom 缺失 antd 依赖的浏览器 API，先行补齐（对齐 app-deployment-polling.test 先例）
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

const pickerItem = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  appName: `机器-${id}`,
  address: `10.0.0.${id}:8001`,
  status: 'online',
  runningTaskCount: 0,
  maxConcurrentTasks: 10,
  ...over,
});

beforeEach(() => {
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  // R3-E 收口后页面不再请求 list()（名字解析吃 picker 行）——mock 工厂保留
  // list: vi.fn() 供下方「list 恒零调用」断言；不给实现，实现若回归调用将
  // resolve undefined 使页面数据流崩红，双重防线。
  vi.mocked(executorsApi.list).mockReset();
  vi.mocked(executorsApi.picker).mockReset().mockResolvedValue({
    items: [], total: 0, truncated: false, limit: 2000,
  } as never);
  vi.mocked(deploymentsApi.list)
    .mockReset()
    .mockResolvedValue({ data: [], total: 0 } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** 打开部署模态并展开执行器下拉（完整用户路径）。 */
async function openDeployDropdown() {
  render(<AppDeploymentPage applicationId="app-1" />);
  // 「新建部署」按钮在存在在线执行器时才可用（picker 驱动）
  const trigger = await waitFor(() => {
    const btn = screen.getByRole('button', { name: /新建部署|Create deployment/ });
    expect(btn.getAttribute('disabled')).toBeNull();
    return btn;
  });
  fireEvent.click(trigger);

  // 标题与按钮文案同键（appDeploy.action.create / appDeploy.modal.create 均为
  // 「新建部署」），按 class 查模态容器避免 getByText 二义。
  const modal = await waitFor(() => {
    const el = document.querySelector('.ant-modal');
    expect(el).toBeTruthy();
    return el as HTMLElement;
  });
  // 部署模态内的执行器下拉：带 showSearch 的 Select
  fireEvent.mouseDown(modal.querySelector<HTMLInputElement>('.ant-select-show-search input')!);
  return modal;
}

describe('部署模态执行器下拉：数据源 = GET /executors/picker', () => {
  it('候选来自 picker.items（list 返回空，选项仍齐全）', async () => {
    vi.mocked(executorsApi.picker).mockResolvedValue({
      items: [pickerItem('1'), pickerItem('2')],
      total: 2,
      truncated: false,
      limit: 2000,
    } as never);

    await openDeployDropdown();
    await waitFor(() => {
      const opts = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')];
      expect(opts).toHaveLength(2);
      const text = opts.map((o) => o.textContent ?? '').join('|');
      expect(text).toContain('机器-1');
      expect(text).toContain('机器-2');
    });
    // 全列 list() 已彻底退场（名字解析同样吃 picker 行）——实现若回归拉 list
    // 即变红（R3-E 遗留收口：首屏不再有 list+picker 双请求）。
    expect(executorsApi.list).not.toHaveBeenCalled();
  });

  it('既有过滤保留：离线不可选；被活动部署占用的执行器从候选整体剔除', async () => {
    vi.mocked(executorsApi.picker).mockResolvedValue({
      items: [
        pickerItem('1'),
        pickerItem('2'),
        pickerItem('3', { status: 'offline' }),
      ],
      total: 3,
      truncated: false,
      limit: 2000,
    } as never);
    // dep-1 正占用 exec-2（deploying）。页面口径：候选 = 在线 && 未被本应用
    // 活动部署占用——被占用的机器**整体从选项剔除**，离线的机器不进候选。
    vi.mocked(deploymentsApi.list).mockResolvedValue({
      data: [{
        id: 'dep-1',
        applicationId: 'app-1',
        executorId: '2',
        executorAddress: '10.0.0.2:8001',
        status: 'deploying',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }],
      total: 1,
    } as never);

    await openDeployDropdown();
    await waitFor(() => {
      const opts = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')];
      // 只有空闲且在线的 exec-1 留在候选里
      expect(opts).toHaveLength(1);
      expect(opts[0].textContent).toContain('机器-1');
      expect(opts[0].getAttribute('aria-disabled')).toBe('false');
      const allText = opts.map((o) => o.textContent ?? '').join('|');
      expect(allText).not.toContain('机器-2');
      expect(allText).not.toContain('机器-3');
    });
  });

  it('picker 超限（truncated=true）：下拉内出现显式截断告警（总数 + 上限），不许静默', async () => {
    vi.mocked(executorsApi.picker).mockResolvedValue({
      items: [pickerItem('1'), pickerItem('2')],
      total: 2500,
      truncated: true,
      limit: 2000,
    } as never);

    await openDeployDropdown();
    await waitFor(() => {
      // 复用 execList.truncated 文案：全量 2500 台、仅显示前 2000 台都必须如实
      // 出现。下拉 popup 挂在 body portal（不在 .ant-modal 内），从 document 查。
      const text = document.body.textContent ?? '';
      expect(text).toContain('2500');
      expect(text).toContain('2000');
    });
  });

  it('未超限（truncated=false）不渲染截断告警', async () => {
    vi.mocked(executorsApi.picker).mockResolvedValue({
      items: [pickerItem('1')],
      total: 1,
      truncated: false,
      limit: 2000,
    } as never);

    const modal = await openDeployDropdown();
    await waitFor(() => {
      expect(document.querySelectorAll<HTMLElement>('.ant-select-item-option').length).toBe(1);
    });
    // 下拉 popup + 模态整体都不出现截断文案（2500 这个数字是告警特有）
    expect(modal.textContent).not.toContain('2500');
    expect(document.body.textContent).not.toContain('2500');
  });
});
