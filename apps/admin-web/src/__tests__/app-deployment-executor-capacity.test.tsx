/**
 * R64（§7.17 P3 收尾）`deployment-progress-semantics`：部署模态执行器下拉里的
 * 「进度条」到底度量什么？
 *
 * ## 事实（不是猜测）
 *
 * · 数据源是 `GET /executors/picker` 的**最小读面** `ExecutorPickerItem`
 *   （`api/executors.ts`）——字段只有 id/appName/address/status/runningTaskCount
 *   /maxConcurrentTasks，**根本没有 reservedSlots 列**；
 * · `runningTaskCount` 是**已占槽位**（含 E-01 pull 取件预留），也正是服务端派发闸门
 *   读的那个数（`executor.entity.ts:207`）；
 * · 下拉的用途是「**挑一台还能接新部署的机器**」——判据必须是「还有没有空槽」。
 *
 * ⇒ 这里是**容量/占用**语义，**不是**详情页「当前运行任务」的**实际在跑**语义。
 * 两者刻意不同：
 *   - 若改用 `displayedRunningCount`（已占 − 预留），空闲 pull 执行器会显示 0/10，
 *     让人以为「还有空槽可接部署」，而那个槽位其实被取件预留占着 ⇒ 选它 = 往满
 *     载机器派发（E-01 要关闭的竞态本身）；
 *   - 列表页/详情页显示「实际在跑」是为了回答「这台在跑几个任务」；本处是为了回答
 *     「这台还能不能再接一个部署」——问题不同，口径就不该强行统一。
 *
 * 因此 R64 的处理是**消歧（改名 + 说明 + 可访问标签）**，而不是「统一口径」。
 * 本文件把这条判断钉死：
 *   ① 显示的是**已占槽位**（1/10 而不是 0/10）；
 *   ② 该处有「已占槽位」说明（旧实现没有 ⇒ 首轮红）；
 *   ③ 即使载荷夹带 `reservedSlots`（picker 读面本不提供），也**不得**因此换算或
 *      触发「计数不一致」提示——证明这里消费的是 `runningTaskCount`，不是展示口径。
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
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
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

/** 打开部署模态并展开执行器下拉（与 app-deployment-picker-datasource 同一路径）。 */
async function openDeployDropdown() {
  render(<AppDeploymentPage applicationId="app-1" />);
  const trigger = await waitFor(() => {
    const btn = screen.getByRole('button', { name: /新建部署|Create deployment/ });
    expect(btn.getAttribute('disabled')).toBeNull();
    return btn;
  });
  fireEvent.click(trigger);
  const modal = await waitFor(() => {
    const el = document.querySelector('.ant-modal');
    expect(el).toBeTruthy();
    return el as HTMLElement;
  });
  fireEvent.mouseDown(modal.querySelector<HTMLInputElement>('.ant-select-show-search input')!);
  return modal;
}

const options = (): HTMLElement[] =>
  [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')];

beforeEach(() => {
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  vi.mocked(executorsApi.list).mockReset();
  vi.mocked(executorsApi.picker).mockReset().mockResolvedValue({
    items: [], total: 0, truncated: false, limit: 2000,
  } as never);
  vi.mocked(deploymentsApi.list).mockReset().mockResolvedValue({ data: [], total: 0 } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('R64 — 部署下拉的「任务数」是容量占用语义，不是「实际在跑」', () => {
  it('【语义①】空闲 pull 执行器（已占 1 含取件预留）显示 1/10——容量口径，绝非 0/10', async () => {
    // 这正是 R18/R59 在详情页会显示 0 的那种执行器：若此处「统一口径」，
    // 就会宣称它还有空槽 —— 而那个槽位被长轮询预留占着。
    vi.mocked(executorsApi.picker).mockResolvedValue({
      items: [pickerItem('1', { runningTaskCount: 1 })],
      total: 1, truncated: false, limit: 2000,
    } as never);

    await openDeployDropdown();
    await waitFor(() => {
      expect(options()).toHaveLength(1);
      expect(options()[0].textContent).toContain('1/10');
    });
    // 反向：绝不能显示成「实际在跑」0/10。
    expect(options()[0].textContent).not.toContain('0/10');
  });

  it('【语义②】该处给出「已占槽位」的可访问说明，消除与详情页数字不一致的困惑', async () => {
    // 旧实现只渲染 `{{load}}/{{maxLoad}}任务`，没有任何说明——用户在部署下拉看到
    // 「1/10」、点进详情页看到「0/10」，会以为是缺陷。
    vi.mocked(executorsApi.picker).mockResolvedValue({
      items: [pickerItem('1', { runningTaskCount: 1 })],
      total: 1, truncated: false, limit: 2000,
    } as never);

    await openDeployDropdown();
    await waitFor(() => {
      expect(options()).toHaveLength(1);
    });
    // 说明必须可被读屏读到（aria-label），不能只藏在 hover 里。
    const labelled = options()[0].querySelector('[aria-label*="已占槽位"]');
    expect(labelled).toBeTruthy();
  });

  it('【语义③】不消费 reservedSlots：载荷夹带该字段也不换算、不触发「计数不一致」', async () => {
    // picker 读面本就不含 reservedSlots（api/executors.ts 的 ExecutorPickerItem）。
    // 这里故意夹带一个矛盾值，锁死「本处消费 runningTaskCount（容量）而非展示口径」：
    // 若有人把 displayedRunningCount / hasInconsistentMetrics 搬过来，本用例立即变红。
    vi.mocked(executorsApi.picker).mockResolvedValue({
      items: [pickerItem('1', { runningTaskCount: 1, reservedSlots: 999 }) as never],
      total: 1, truncated: false, limit: 2000,
    } as never);

    await openDeployDropdown();
    await waitFor(() => {
      expect(options()).toHaveLength(1);
    });
    expect(options()[0].textContent).toContain('1/10');
    expect(options()[0].textContent).not.toContain('0/10');
    expect(screen.queryByLabelText(/后端上报的任务计数不一致/)).toBeNull();
  });
});
