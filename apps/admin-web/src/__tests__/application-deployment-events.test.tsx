/**
 * R4（部署模型评审 2026-10-23 §4.1A）收尾：ApplicationDetailPage 版本追溯
 * Tab 的**部署事件流**消费面 + **P8 truncated 截断告警**。
 *
 * 覆盖：事件表渲染（类型中文标签/操作者系统标注/摘要 detail 已知键翻译）/
 * 分页（以新页码重新请求）/ 事件流加载失败区块降级不拖垮版本表 /
 * truncated=true 渲染告警条与跳转按钮 / truncated 缺省不渲染告警 /
 * 时间范围筛选（since/until 半开区间换算 + 与 eventType 组合 + 清除恢复）。
 * mock api 层（application-releases-devices.test 先例形态）；设备名解析
 * 不依赖 useExecutorNames 的清单请求（executors.list mock 拒绝）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import dayjs from 'dayjs';
import ApplicationDetailPage, { eventsRangeToSinceUntil } from '../pages/ApplicationDetailPage';
import { applicationsApi, type Application, type AppReleaseRow, type AppDeploymentEventRow } from '../api/applications';
import { tasksApi } from '../api/tasks';
import { useAuthStore } from '../store/auth';

vi.mock('../api/applications', () => ({
  applicationsApi: {
    get: vi.fn(),
    update: vi.fn(),
    syncTasks: vi.fn(),
    getVersionHistory: vi.fn(),
    getReleases: vi.fn(),
    getDeploymentEvents: vi.fn(),
    rollback: vi.fn(),
  },
}));
vi.mock('../api/tasks', () => ({ tasksApi: { list: vi.fn() } }));
vi.mock('../api/ai', () => ({ aiApi: { analyzeApp: vi.fn() } }));
vi.mock('../api/executors', () => ({ executorsApi: { list: vi.fn().mockRejectedValue(new Error('no list')) } }));
vi.mock('../pages/AppDeploymentPage', () => ({
  default: () => <div data-testid="app-deployment-mock">deployments-mock</div>,
}));

const mockedApps = vi.mocked(applicationsApi, true);
const mockedTasks = vi.mocked(tasksApi, true);

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
// jsdom 未实现 scrollIntoView（截断告警跳转按钮的滚动调用）——no-op shim
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {};
}

const appFixture: Application = {
  id: 'app-1',
  name: 'demo-app',
  version: '1.2.0',
  runtime: 'python',
  status: 'active',
  createdAt: '2026-09-01T08:00:00Z',
  updatedAt: '2026-09-07T08:00:00Z',
};

const releaseRow = (over: Partial<AppReleaseRow> = {}): AppReleaseRow => ({
  id: 'ver-1',
  version: '1.2.0',
  packageUrl: 'http://api:3000/uploads/packages/demo-1.2.0.zip',
  gitCommit: 'abcdef1234567890',
  deployedAt: '2026-09-07T08:00:00Z',
  latestDeploymentId: 'dep-1',
  deploymentStatus: 'running',
  deploymentCount: 1,
  executorAddress: '10.0.0.9:3002',
  runMode: 'daemon',
  triggerType: 'manual',
  operator: null,
  operatorSource: 'application_versions.createdBy',
  operatorMissingReason: 'not populated by any write path',
  sourceDeploymentId: 'dep-1',
  status: 'released',
  createdAt: '2026-09-06T08:00:00Z',
  synthetic: false,
  ...over,
});

const eventRow = (over: Partial<AppDeploymentEventRow> = {}): AppDeploymentEventRow => ({
  id: 'evt-1',
  applicationId: 'app-1',
  deploymentId: 'dep-1',
  executorId: 'exec-a',
  executorAddress: '10.0.0.9:3002',
  eventType: 'deploy_created',
  deployedVersion: '1.2.0',
  triggerType: 'manual',
  operator: 'root',
  detail: { runMode: 'daemon' },
  createdAt: '2026-10-24T08:00:00Z',
  ...over,
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/applications/app-1?tab=releases']}>
      <Routes>
        <Route path="/applications/:id" element={<ApplicationDetailPage />} />
        <Route path="/applications" element={<div>app-list-mock</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function openReleasesTab() {
  renderPage();
  await screen.findAllByText('demo-app');
  fireEvent.click(screen.getByText('版本追溯'));
  await waitFor(() => expect(mockedApps.getReleases).toHaveBeenCalled());
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  mockedApps.get.mockResolvedValue(appFixture);
  mockedTasks.list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 });
  mockedApps.getReleases.mockResolvedValue({
    data: [releaseRow()],
    total: 1,
    page: 1,
    pageSize: 20,
  });
  mockedApps.getDeploymentEvents.mockResolvedValue({
    data: [],
    total: 0,
    page: 1,
    pageSize: 20,
  });
});

afterEach(() => {
  cleanup();
});

describe('ApplicationDetailPage 版本追溯 Tab 部署事件流（R4 §4.1A）', () => {
  it('Tab 渲染并以 (appId, page, pageSize) 调用 getDeploymentEvents，事件表出现', async () => {
    mockedApps.getDeploymentEvents.mockResolvedValue({
      data: [eventRow()],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    await openReleasesTab();
    await screen.findByTestId('deployment-events-table');
    expect(mockedApps.getDeploymentEvents).toHaveBeenCalledWith('app-1', 1, 20, undefined);
    // 版本表与事件表同屏共存
    expect(screen.getByTestId('releases-table')).toBeTruthy();
  });

  it('事件行渲染：类型中文标签 / 版本 / 操作者 / 摘要 detail 已知键翻译', async () => {
    mockedApps.getDeploymentEvents.mockResolvedValue({
      data: [
        eventRow(),
        eventRow({
          id: 'evt-2',
          eventType: 'stuck_failed',
          operator: null,
          triggerType: null,
          deployedVersion: null,
          detail: { previousStatus: 'deploying' },
        }),
      ],
      total: 2,
      page: 1,
      pageSize: 20,
    });
    await openReleasesTab();
    await screen.findByTestId('deployment-events-table');
    // 类型标签：人类可读中文（非裸 token）
    expect(screen.getAllByText('新建部署').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('卡死判失败').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('deploy_created')).toBeNull();
    // 版本事实列
    expect(screen.getAllByText('1.2.0').length).toBeGreaterThanOrEqual(1);
    // 操作者：人工路径显示用户名；机器路径显示「系统」标注（非空白）
    expect(screen.getAllByText('root').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('系统').length).toBeGreaterThanOrEqual(1);
    // 摘要：已知键翻译（运行模式 / 扫死前状态），不出现裸 key
    expect(screen.getAllByText(/运行模式: daemon/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/扫死前状态: 部署中/).length).toBeGreaterThanOrEqual(1);
  });

  it('空态：无事件时展示空态文案', async () => {
    await openReleasesTab();
    await screen.findByTestId('deployment-events-table');
    await waitFor(() =>
      expect(screen.getByText(/暂无部署事件/)).toBeTruthy(),
    );
  });

  it('分页：翻页时以新页码重新请求事件流', async () => {
    mockedApps.getDeploymentEvents.mockResolvedValue({
      data: Array.from({ length: 20 }, (_, i) => eventRow({ id: 'evt-' + i })),
      total: 45,
      page: 1,
      pageSize: 20,
    });
    await openReleasesTab();
    const table = await screen.findByTestId('deployment-events-table');
    // antd 分页器第 2 页按钮（事件表分页器）
    const pager = table.closest('.ant-card')?.querySelectorAll('.ant-pagination li');
    const page2 = Array.from(pager ?? []).find((el) => (el.textContent ?? '') === '2');
    expect(page2).toBeTruthy();
    fireEvent.click(page2 as HTMLElement);
    await waitFor(() => expect(mockedApps.getDeploymentEvents).toHaveBeenCalledWith('app-1', 2, 20, undefined));
  });

  it('事件流加载失败降级为区块内 StateError，版本表不受拖垮', async () => {
    mockedApps.getDeploymentEvents.mockRejectedValue(new Error('events down'));
    await openReleasesTab();
    const eventsCard = await screen.findByTestId('events-card');
    await waitFor(() => expect(screen.getByTestId('state-error')).toBeTruthy());
    expect(screen.getByText(/加载部署事件流失败/)).toBeTruthy();
    expect(screen.getByText('events down')).toBeTruthy();
    // 版本表仍在（失败被隔离在事件区块内）
    expect(screen.getByTestId('releases-table')).toBeTruthy();
    expect(eventsCard).toBeTruthy();
  });

  it('StateError 重试按钮重新发起 getDeploymentEvents', async () => {
    mockedApps.getDeploymentEvents
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ data: [eventRow()], total: 1, page: 1, pageSize: 20 });
    await openReleasesTab();
    await waitFor(() => expect(screen.getByTestId('state-error')).toBeTruthy());
    fireEvent.click(screen.getByText('重试'));
    await waitFor(() => {
      expect(mockedApps.getDeploymentEvents).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('deployment-events-table')).toBeTruthy();
    });
  });
});

describe('ApplicationDetailPage 部署事件流 eventType 筛选（服务端过滤）', () => {
  /** 打开事件卡右上角的类型筛选下拉（antd v6 虚拟列表：可见选项按类名定位，
   *  先例见 execution-detail-log-level.test.tsx 的 openLevelDropdown）。 */
  async function openTypeDropdown(): Promise<HTMLElement[]> {
    fireEvent.mouseDown(screen.getByTestId('event-type-filter'));
    return waitFor(() => {
      const opts = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')];
      expect(opts.length).toBe(9);
      return opts;
    });
  }

  function clickOption(opts: HTMLElement[], label: string) {
    const target = opts.find((o) => o.textContent === label);
    if (!target) throw new Error(`未找到选项 ${label}`);
    fireEvent.click(target);
  }

  it('初始不筛选：请求不带 eventType（第 4 参 undefined，请求形状与旧后端一致）', async () => {
    await openReleasesTab();
    await screen.findByTestId('deployment-events-table');
    expect(mockedApps.getDeploymentEvents).toHaveBeenCalledWith('app-1', 1, 20, undefined);
  });

  it('选择类型后：请求带 eventType 且重置回第 1 页', async () => {
    mockedApps.getDeploymentEvents.mockResolvedValue({
      data: [eventRow({ eventType: 'upgrade' })],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    await openReleasesTab();
    await screen.findByTestId('deployment-events-table');
    const opts = await openTypeDropdown();
    clickOption(opts, '升级');
    await waitFor(() =>
      expect(mockedApps.getDeploymentEvents).toHaveBeenCalledWith('app-1', 1, 20, { eventType: 'upgrade' }),
    );
  });

  it('筛选状态下翻页：页码变化、eventType 仍随行', async () => {
    mockedApps.getDeploymentEvents.mockResolvedValue({
      data: Array.from({ length: 20 }, (_, i) => eventRow({ id: 'evt-' + i, eventType: 'upgrade' })),
      total: 45,
      page: 1,
      pageSize: 20,
    });
    await openReleasesTab();
    await screen.findByTestId('deployment-events-table');
    const opts = await openTypeDropdown();
    clickOption(opts, '升级');
    await waitFor(() =>
      expect(mockedApps.getDeploymentEvents).toHaveBeenCalledWith('app-1', 1, 20, { eventType: 'upgrade' }),
    );
    // 翻第 2 页：eventType 保持
    const table = screen.getByTestId('deployment-events-table');
    const pager = table.closest('.ant-card')?.querySelectorAll('.ant-pagination li');
    const page2 = Array.from(pager ?? []).find((el) => (el.textContent ?? '') === '2');
    fireEvent.click(page2 as HTMLElement);
    await waitFor(() =>
      expect(mockedApps.getDeploymentEvents).toHaveBeenCalledWith('app-1', 2, 20, { eventType: 'upgrade' }),
    );
  });

  it('清除筛选（allowClear ×）：恢复不带 eventType 的请求', async () => {
    mockedApps.getDeploymentEvents.mockResolvedValue({
      data: [eventRow()],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    await openReleasesTab();
    await screen.findByTestId('deployment-events-table');
    const opts = await openTypeDropdown();
    clickOption(opts, '停止');
    await waitFor(() =>
      expect(mockedApps.getDeploymentEvents).toHaveBeenCalledWith('app-1', 1, 20, { eventType: 'stop' }),
    );
    // antd v6 清除按钮（allowClear 渲染的 ×）
    const clear = screen.getByTestId('event-type-filter').querySelector('.ant-select-clear');
    expect(clear).toBeTruthy();
    fireEvent.mouseDown(clear as HTMLElement);
    fireEvent.click(clear as HTMLElement);
    await waitFor(() =>
      expect(mockedApps.getDeploymentEvents).toHaveBeenCalledWith('app-1', 1, 20, undefined),
    );
  });

  it('下拉选项与 EVENT_TYPE_LABELS 同源：九个中文标签全呈现', async () => {
    await openReleasesTab();
    await screen.findByTestId('deployment-events-table');
    const opts = await openTypeDropdown();
    expect(opts.map((o) => o.textContent)).toEqual([
      '新建部署', '复用重部署', '审批通过', '审批拒绝', '审批撤回', '升级', '停止', '删除', '卡死判失败',
    ]);
  });
});

describe('ApplicationDetailPage 部署事件流时间范围筛选（since/until 半开区间）', () => {
  /**
   * 交互方式的边界（先例：executions-keyset-paging / audit-keyset-paging 两处
   * 测试均已记录）：antd 6.6.x 的 RangePicker **日期格子**在 jsdom 下无法被
   * fireEvent/user-event 驱动到 onChange（rc-picker 的区间落定依赖真实指针/
   * 布局事件序列，click / mouseDown+mouseUp / mouseenter / 双面板格子 /
   * 键入+Enter 均试过，均不触发）。**presets 预设区间**可以：antd 把它渲染
   * 成真实可点击的 li，点击即 onChange（本文件开发时已 probe 验证）。故交互
   * 用例走预设，而「选任意日期的换算是否正确」由纯函数 eventsRangeToSinceUntil
   * 直接断言——两者合起来覆盖「UI 选择 → since/until 参数」的完整链路，
   * 不需要编一个点了不发请求的假交互断言。
   */

  // 预设区间以「现在」为锚（antd 不做 startOf 归一，带时分秒），换算函数会
  // startOf('day') 归一；断言同样以 dayjs() 现算，避免硬编码日期跨日红。
  function expectedPresetParams(days: number) {
    return {
      since: dayjs().subtract(days, 'day').startOf('day').toISOString(),
      until: dayjs().startOf('day').toISOString(),
    };
  }

  /** 打开 RangePicker 面板（click 外层 .ant-picker —— probe 验证 jsdom 可开）。 */
  async function openTimePanel() {
    fireEvent.click(screen.getByTestId('event-time-filter').querySelector('.ant-picker') as HTMLElement);
    await waitFor(() => {
      expect(document.querySelector('.ant-picker-dropdown')).toBeTruthy();
    });
  }

  /** 点击面板里的预设区间标签（antd presets 渲染为 .ant-picker-presets li）。 */
  async function clickPreset(label: string) {
    await openTimePanel();
    const items = [...document.querySelectorAll<HTMLElement>('.ant-picker-presets li')];
    const target = items.find((li) => (li.textContent ?? '') === label);
    if (!target) throw new Error(`未找到预设区间 ${label}（现有：${items.map((i) => i.textContent).join(',')}）`);
    fireEvent.click(target);
  }

  it('eventsRangeToSinceUntil：日期粒度 → 半开区间绝对时刻（结束日当天不计入）', () => {
    // 选 10-20 ~ 10-24：since=10-20T00:00（含），until=10-24T00:00（不含）——
    // 半开区间下恰好等于「到 10-23 23:59:59.999 止」。带时间成分的入参也被
    // startOf('day') 归一到当日 0 点（UI 是日期粒度，归一化是口径的一部分）。
    const r = eventsRangeToSinceUntil([
      dayjs('2026-10-20T15:30:00'),
      dayjs('2026-10-24T09:00:00'),
    ]);
    expect(r.since).toBe('2026-10-19T16:00:00.000Z'); // 北京时间 10-20 00:00
    expect(r.until).toBe('2026-10-23T16:00:00.000Z'); // 北京时间 10-24 00:00
  });

  it('初始不带时间筛选：第 4 参 undefined（请求形状与旧后端一致）', async () => {
    await openReleasesTab();
    await screen.findByTestId('deployment-events-table');
    expect(mockedApps.getDeploymentEvents).toHaveBeenCalledWith('app-1', 1, 20, undefined);
  });

  it('选预设区间（最近 7 天）：请求带 since/until 且换算正确、回第 1 页', async () => {
    mockedApps.getDeploymentEvents.mockResolvedValue({
      data: [eventRow()],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    await openReleasesTab();
    await screen.findByTestId('deployment-events-table');
    await clickPreset('最近 7 天');
    const exp = expectedPresetParams(7);
    await waitFor(() =>
      expect(mockedApps.getDeploymentEvents).toHaveBeenCalledWith('app-1', 1, 20, exp),
    );
  });

  it('时间范围与 eventType 组合：三个参数同发', async () => {
    mockedApps.getDeploymentEvents.mockResolvedValue({
      data: [eventRow({ eventType: 'upgrade' })],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    await openReleasesTab();
    await screen.findByTestId('deployment-events-table');
    // 先选类型
    fireEvent.mouseDown(screen.getByTestId('event-type-filter'));
    const opt = await waitFor(() => {
      const opts = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')];
      expect(opts.length).toBe(9);
      return opts;
    });
    fireEvent.click(opt.find((o) => o.textContent === '升级') as HTMLElement);
    await waitFor(() =>
      expect(mockedApps.getDeploymentEvents).toHaveBeenCalledWith('app-1', 1, 20, { eventType: 'upgrade' }),
    );
    // 再加时间范围：组合后 eventType 与 since/until 同时在
    await clickPreset('最近 1 天');
    const exp = expectedPresetParams(1);
    await waitFor(() =>
      expect(mockedApps.getDeploymentEvents).toHaveBeenCalledWith('app-1', 1, 20, {
        eventType: 'upgrade',
        ...exp,
      }),
    );
  });

  it('时间筛选下翻页：页码变化、since/until 随行', async () => {
    mockedApps.getDeploymentEvents.mockResolvedValue({
      data: Array.from({ length: 20 }, (_, i) => eventRow({ id: 'evt-' + i })),
      total: 45,
      page: 1,
      pageSize: 20,
    });
    await openReleasesTab();
    await screen.findByTestId('deployment-events-table');
    await clickPreset('最近 30 天');
    const exp = expectedPresetParams(30);
    await waitFor(() =>
      expect(mockedApps.getDeploymentEvents).toHaveBeenCalledWith('app-1', 1, 20, exp),
    );
    const table = screen.getByTestId('deployment-events-table');
    const pager = table.closest('.ant-card')?.querySelectorAll('.ant-pagination li');
    const page2 = Array.from(pager ?? []).find((el) => (el.textContent ?? '') === '2');
    fireEvent.click(page2 as HTMLElement);
    await waitFor(() =>
      expect(mockedApps.getDeploymentEvents).toHaveBeenCalledWith('app-1', 2, 20, exp),
    );
  });

  it('清除时间范围（allowClear ×）：恢复不带 since/until 的请求', async () => {
    mockedApps.getDeploymentEvents.mockResolvedValue({
      data: [eventRow()],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    await openReleasesTab();
    await screen.findByTestId('deployment-events-table');
    await clickPreset('最近 7 天');
    const exp = expectedPresetParams(7);
    await waitFor(() =>
      expect(mockedApps.getDeploymentEvents).toHaveBeenCalledWith('app-1', 1, 20, exp),
    );
    // antd allowClear 的 ×（hover 显示，jsdom 下直接对节点发事件即可，Select
    // 清除按钮同款先例）
    const clear = screen.getByTestId('event-time-filter').querySelector('.ant-picker-clear');
    expect(clear).toBeTruthy();
    fireEvent.mouseEnter(screen.getByTestId('event-time-filter').querySelector('.ant-picker') as HTMLElement);
    fireEvent.click(clear as HTMLElement);
    await waitFor(() =>
      expect(mockedApps.getDeploymentEvents).toHaveBeenCalledWith('app-1', 1, 20, undefined),
    );
  });
});

describe('ApplicationDetailPage 版本追溯 Tab truncated 截断告警（P8）', () => {
  it('truncated=true：版本表上方渲染告警条与「查看事件流」跳转按钮', async () => {
    mockedApps.getReleases.mockResolvedValue({
      data: [releaseRow()],
      total: 1,
      page: 1,
      pageSize: 20,
      truncated: true,
    });
    await openReleasesTab();
    await screen.findByTestId('releases-table');
    expect(screen.getByText('版本列表已被截断')).toBeTruthy();
    expect(screen.getByText(/超出单次查询上限/)).toBeTruthy();
    expect(screen.getByTestId('truncated-goto-events')).toBeTruthy();
  });

  it('跳转按钮存在且锚点节点在文档中（jsdom 无真实滚动，点击不抛错）', async () => {
    mockedApps.getReleases.mockResolvedValue({
      data: [releaseRow()],
      total: 1,
      page: 1,
      pageSize: 20,
      truncated: true,
    });
    mockedApps.getDeploymentEvents.mockResolvedValue({ data: [eventRow()], total: 1, page: 1, pageSize: 20 });
    await openReleasesTab();
    await screen.findByTestId('releases-table');
    const anchor = document.getElementById('app-deployment-events');
    expect(anchor).toBeTruthy();
    fireEvent.click(screen.getByTestId('truncated-goto-events'));
    expect(screen.getByTestId('truncated-goto-events')).toBeTruthy();
  });

  it('truncated 缺省（旧后端不带该键）：不渲染告警条', async () => {
    await openReleasesTab();
    await screen.findByTestId('releases-table');
    expect(screen.queryByText('版本列表已被截断')).toBeNull();
    expect(screen.queryByTestId('truncated-goto-events')).toBeNull();
  });

  it('truncated=false：同样不渲染告警条', async () => {
    mockedApps.getReleases.mockResolvedValue({
      data: [releaseRow()],
      total: 1,
      page: 1,
      pageSize: 20,
      truncated: false,
    });
    await openReleasesTab();
    await screen.findByTestId('releases-table');
    expect(screen.queryByText('版本列表已被截断')).toBeNull();
  });
});
