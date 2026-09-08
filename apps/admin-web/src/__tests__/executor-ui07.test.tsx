/**
 * UI-07：执行器列表升级专项测试（视图切换 / 分组聚合 / 卡片视图 /
 * 批量操作 / SSE 实时状态）。
 *
 * 覆盖矩阵（任务书 §6.2 验收点）：
 *  ① ViewToggle localStorage 记忆（读写纯函数 + 切换持久化）；
 *  ② 分组聚合：groupBuckets 纯函数（未分组兜底/计数/排序）+ GroupFilterBar
 *     点击过滤联动 + 「全部」复位 + 无分组时整条隐藏；
 *  ① 卡片视图：渲染（名称/CPU/内存/任务数/分组 Tag/快捷操作）+ 空态 + 点击详情；
 *  ③ 批量操作：ADMIN 门控（非 admin 不渲染条）+ 逐台结果反馈
 *     （all 成功/部分失败逐台 error）+ rotate 二次确认 Modal 内容
 *     （受影响执行器清单 + 「短暂重新注册」明示）；
 *  ④ SSE 合并：executorStatsToMap/mergeStreamOverlay 纯函数（字段级覆盖、
 *     畸形行跳过、流缺失回退轮询值）+ Provider 缺守卫（既有 executor-list
 *     测试裸渲染即回归证明）。
 *
 * 批量操作测试直接驱动 BatchActionBar（Modal.confirm 走 onOk），
 * runBatch 纯函数直测逐台结果聚合。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ExecutorListPage from '../pages/ExecutorListPage';
import { runBatch } from '../components/executor/BatchActionBar';
import ViewToggle, { readViewMode, writeViewMode } from '../components/executor/ViewToggle';
import { groupBuckets } from '../components/executor/GroupFilterBar';
import { executorStatsToMap, mergeStreamOverlay } from '../hooks/useExecutorLive';
import { executorsApi, type Executor } from '../api/executors';
import { useAuthStore } from '../store/auth';

vi.mock('../api/executors', () => ({
  executorsApi: {
    list: vi.fn(),
    getGroups: vi.fn(),
    reloadConfig: vi.fn(),
    rotateToken: vi.fn(),
  },
}));
const mockedExecutors = vi.mocked(executorsApi, true);

vi.mock('../api/client', () => ({
  client: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
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

const NOW = Date.now();
const makeExecutor = (over: Partial<Executor>): Executor => ({
  id: 'ex-1',
  appName: 'alpha',
  address: '10.0.0.1:3002',
  status: 'online',
  cpuUsage: 30,
  memUsage: 50,
  runningTaskCount: 1,
  lastHeartbeat: new Date(NOW - 10_000).toISOString(),
  ...over,
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/executors']}>
      <Routes>
        <Route path="/executors" element={<ExecutorListPage />} />
        <Route path="/executors/:id" element={<div>executor-detail-mock</div>} />
        <Route path="/executors/install" element={<div>install-wizard-mock</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const findBtn = (root: ParentNode, text: string): HTMLButtonElement | null =>
  (Array.from(root.querySelectorAll('button')) as HTMLButtonElement[]).find(
    (b) => (b.textContent ?? '').replace(/\s/g, '') === text,
  ) ?? null;

beforeEach(() => {
  mockedExecutors.list.mockReset();
  mockedExecutors.getGroups.mockReset();
  mockedExecutors.reloadConfig.mockReset();
  mockedExecutors.rotateToken.mockReset();
  localStorage.clear();
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
});

afterEach(() => {
  cleanup();
});

// ── ① ViewToggle：localStorage 记忆 ─────────────────────────────────────

describe('UI-07 ① ViewToggle 记忆', () => {
  it('readViewMode：card 命中记忆，非法值/空值/异常回退 table', () => {
    expect(readViewMode(localStorage)).toBe('table');
    writeViewMode(localStorage, 'card');
    expect(readViewMode(localStorage)).toBe('card');
    localStorage.setItem('autoflow-ui07-executor-view', 'bogus');
    expect(readViewMode(localStorage)).toBe('table');
    expect(readViewMode(undefined)).toBe('table');
    const throwing = {
      getItem: () => { throw new Error('denied'); },
    } as unknown as Storage;
    expect(readViewMode(throwing)).toBe('table');
  });

  it('writeViewMode：写入后再读一致；存储异常静默', () => {
    writeViewMode(localStorage, 'card');
    expect(localStorage.getItem('autoflow-ui07-executor-view')).toBe('card');
    const throwing = {
      setItem: () => { throw new Error('quota'); },
    } as unknown as Storage;
    expect(() => writeViewMode(throwing, 'card')).not.toThrow();
  });

  it('页面内切换视图并持久化：刷新后仍为卡片视图', async () => {
    mockedExecutors.list.mockResolvedValue([makeExecutor({})]);
    mockedExecutors.getGroups.mockResolvedValue([]);
    const { unmount } = renderPage();
    await screen.findByText('alpha');
    fireEvent.click(screen.getByText('卡片'));
    expect(localStorage.getItem('autoflow-ui07-executor-view')).toBe('card');
    unmount();
    cleanup();
    // 重挂：readViewMode 命中 card → 卡片网格渲染
    renderPage();
    await screen.findByText('alpha');
    expect(screen.getByTestId('executor-card-grid')).toBeTruthy();
  });
});

// ── ② 分组聚合 ──────────────────────────────────────────────────────────

describe('UI-07 ② 分组聚合', () => {
  it('groupBuckets：计数正确、未分组兜底恒末位、其余按名称序', () => {
    const buckets = groupBuckets([
      { id: '1', groupName: '华东' },
      { id: '2', groupName: '华东' },
      { id: '3', groupName: '华北' },
      { id: '4', groupName: null },
      { id: '5', groupName: undefined },
      { id: '6', groupName: '' },
    ]);
    expect(buckets).toEqual([
      { key: '华北', label: '华北', count: 1 },
      { key: '华东', label: '华东', count: 2 },
      { key: '', label: '未分组', count: 3 },
    ]);
  });

  it('groupBuckets：空输入返回空数组（Bar 整条隐藏）', () => {
    expect(groupBuckets([])).toEqual([]);
  });

  it('页面：分组条渲染计数徽标，点击「华东」过滤、点「全部」复位', async () => {
    mockedExecutors.list.mockResolvedValue([
      makeExecutor({ id: 'ex-1', appName: 'alpha', groupName: '华东' }),
      makeExecutor({ id: 'ex-2', appName: 'beta', groupName: '华东' }),
      makeExecutor({ id: 'ex-3', appName: 'gamma', groupName: null }),
    ]);
    mockedExecutors.getGroups.mockResolvedValue(['华东']);
    renderPage();
    await screen.findByText('alpha');
    expect(screen.getByTestId('executor-group-bar')).toBeTruthy();
    // 点击分组 Tag（CheckableTag 内含文本 华东（2））
    fireEvent.click(screen.getByText('华东（2）').closest('span')!);
    await waitFor(() => {
      expect(screen.queryByText('gamma')).toBeNull();
      expect(screen.getByText('alpha')).toBeTruthy();
      expect(screen.getByText('beta')).toBeTruthy();
    });
    // 复位
    fireEvent.click(screen.getByText('全部').closest('span')!);
    await waitFor(() => {
      expect(screen.getByText('gamma')).toBeTruthy();
    });
  });

  it('页面：全部执行器均无分组 → 分组条隐藏', async () => {
    mockedExecutors.list.mockResolvedValue([
      makeExecutor({ id: 'ex-1', groupName: null }),
    ]);
    mockedExecutors.getGroups.mockResolvedValue([]);
    renderPage();
    await screen.findByText('alpha');
    expect(screen.queryByTestId('executor-group-bar')).toBeNull();
  });
});

// ── ① 卡片视图 ──────────────────────────────────────────────────────────

describe('UI-07 ① 卡片视图', () => {
  beforeEach(() => {
    mockedExecutors.list.mockResolvedValue([
      makeExecutor({ id: 'ex-1', appName: 'alpha', groupName: '生产组', tags: ['gpu'], maxConcurrentTasks: 4, runningTaskCount: 2, cpuUsage: 85, memUsage: 45 }),
      makeExecutor({ id: 'ex-2', appName: 'beta', status: 'offline', groupName: null, tags: null, deadLetterCount: 3 }),
    ]);
    mockedExecutors.getGroups.mockResolvedValue(['生产组']);
  });

  it('切换卡片视图：网格渲染名称/任务数/分组/死信 Tag/CPU 百分比', async () => {
    renderPage();
    await screen.findByText('alpha');
    fireEvent.click(screen.getByText('卡片'));
    expect(screen.getByTestId('executor-card-grid')).toBeTruthy();
    expect(screen.getByTestId('executor-card-ex-1')).toBeTruthy();
    expect(screen.getByTestId('executor-card-ex-2')).toBeTruthy();
    expect(screen.getByText('2/4 任务')).toBeTruthy();
    expect(screen.getByText('生产组')).toBeTruthy();
    expect(screen.getByText('死信 3')).toBeTruthy();
    expect(screen.getByText('85%')).toBeTruthy();
  });

  it('卡片点详情跳执行器详情页；搜索过滤联动卡片网格（空态）', async () => {
    renderPage();
    await screen.findByText('alpha');
    fireEvent.click(screen.getByText('卡片'));
    fireEvent.click(screen.getAllByText('详情')[0]);
    await waitFor(() => {
      expect(screen.getByText('executor-detail-mock')).toBeTruthy();
    });
  });

  it('卡片视图搜索无匹配 → 空态', async () => {
    renderPage();
    await screen.findByText('alpha');
    fireEvent.click(screen.getByText('卡片'));
    fireEvent.change(screen.getByPlaceholderText('搜索名称、地址、分组'), {
      target: { value: '不存在' },
    });
    await waitFor(() => {
      expect(screen.getByText('无匹配执行器')).toBeTruthy();
    });
  });

  it('ADMIN 卡片快捷操作可见（轮换 Token）；非 admin 隐藏', async () => {
    renderPage();
    await screen.findByText('alpha');
    fireEvent.click(screen.getByText('卡片'));
    expect(screen.getByLabelText('轮换 Token alpha')).toBeTruthy();
    cleanup();
    useAuthStore.setState({ user: { id: 2, username: 'dev', role: 'user' } });
    renderPage();
    await screen.findByText('alpha');
    fireEvent.click(screen.getByText('卡片'));
    expect(screen.queryByLabelText('轮换 Token alpha')).toBeNull();
  });
});

// ── ③ 批量操作 ──────────────────────────────────────────────────────────

describe('UI-07 ③ runBatch 逐台结果聚合', () => {
  it('全部成功：succeeded=total，rotate 结果带 token', async () => {
    const execs = [makeExecutor({ id: 'a', appName: 'a' }), makeExecutor({ id: 'b', appName: 'b' })];
    const summary = await runBatch(execs, async (ex) => ({ token: `tok-${ex.id}` }));
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.outcomes.map((o) => o.token)).toEqual(['tok-a', 'tok-b']);
  });

  it('部分失败：allSettled 隔离单台异常，失败台携带错误信息', async () => {
    const execs = [makeExecutor({ id: 'a', appName: 'a' }), makeExecutor({ id: 'b', appName: 'b' })];
    const summary = await runBatch(execs, async (ex) => {
      if (ex.id === 'b') throw new Error('网络错误');
      return {};
    });
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);
    const failed = summary.outcomes.find((o) => !o.ok)!;
    expect(failed.executor.id).toBe('b');
    expect(failed.error).toContain('网络错误');
  });
});

describe('UI-07 ③ 批量操作条（页面内）', () => {
  // 表格多选复选框 DOM 序：[0]=表头全选，[1..n]=数据行（antd rowSelection）。
  // 点击用行 checkbox 本体（fireEvent.click 直发 input），勾选经 antd
  // Checkbox 受控链路触发 rowSelection.onChange。
  const rowCheckbox = (index: number) =>
    document.querySelectorAll('input[type="checkbox"]')[index + 1];

  it('ADMIN：勾选两台后操作条出现并显示已选数', async () => {
    mockedExecutors.list.mockResolvedValue([
      makeExecutor({ id: 'ex-1', appName: 'alpha' }),
      makeExecutor({ id: 'ex-2', appName: 'beta' }),
    ]);
    mockedExecutors.getGroups.mockResolvedValue([]);
    renderPage();
    await screen.findByText('alpha');
    fireEvent.click(rowCheckbox(0));
    fireEvent.click(rowCheckbox(1));
    expect(screen.getByTestId('executor-batch-bar')).toBeTruthy();
    expect(screen.getByText('已选 2 台')).toBeTruthy();
  });

  it('非 admin：勾选后操作条不渲染（isAdmin 门控）', async () => {
    useAuthStore.setState({ user: { id: 2, username: 'dev', role: 'user' } });
    mockedExecutors.list.mockResolvedValue([makeExecutor({})]);
    mockedExecutors.getGroups.mockResolvedValue([]);
    renderPage();
    await screen.findByText('alpha');
    fireEvent.click(rowCheckbox(0));
    expect(screen.queryByTestId('executor-batch-bar')).toBeNull();
  });

  it('批量轮换：二次确认 Modal 列出受影响执行器并明示「短暂重新注册」，确认后逐台调用 rotate-token', async () => {
    mockedExecutors.list.mockResolvedValue([
      makeExecutor({ id: 'ex-1', appName: 'alpha' }),
      makeExecutor({ id: 'ex-2', appName: 'beta', status: 'offline' }),
    ]);
    mockedExecutors.getGroups.mockResolvedValue([]);
    mockedExecutors.rotateToken.mockResolvedValue({ token: 'new-tok', expiresAt: '2026-01-01' });
    renderPage();
    await screen.findByText('alpha');
    fireEvent.click(rowCheckbox(0));
    fireEvent.click(rowCheckbox(1));
    fireEvent.click(findBtn(document.body, '批量轮换Token')!);
    // 二次确认内容（Modal.confirm 渲染在 body 级 holder；表格与 Modal 内
    // 各有一份执行器名 → getAllByText 容忍多份）
    expect(await screen.findByText('高危操作')).toBeTruthy();
    expect(screen.getByText(/短暂重新注册/)).toBeTruthy();
    expect(screen.getAllByText('alpha').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('beta').length).toBeGreaterThanOrEqual(1);
    // 确认执行
    await act(async () => {
      fireEvent.click(findBtn(document.body, '确认轮换')!);
    });
    await waitFor(() => {
      expect(mockedExecutors.rotateToken).toHaveBeenCalledTimes(2);
    });
    // 结果弹窗（成功台 token 一次性展示）
    await waitFor(() => {
      expect(screen.getByText(/批量轮换结果/)).toBeTruthy();
    });
  });

  it('批量配置热更新：确认后仅对在线台调用 reload-config', async () => {
    mockedExecutors.list.mockResolvedValue([
      makeExecutor({ id: 'ex-1', appName: 'alpha', status: 'online' }),
      makeExecutor({ id: 'ex-2', appName: 'beta', status: 'offline' }),
    ]);
    mockedExecutors.getGroups.mockResolvedValue([]);
    renderPage();
    await screen.findByText('alpha');
    fireEvent.click(rowCheckbox(0));
    fireEvent.click(rowCheckbox(1));
    fireEvent.click(findBtn(document.body, '批量配置热更新')!);
    await screen.findAllByText(/批量配置热更新（1 台在线）/);
    await act(async () => {
      fireEvent.click(findBtn(document.body, '确认推送')!);
    });
    await waitFor(() => {
      expect(mockedExecutors.reloadConfig).toHaveBeenCalledTimes(1);
      expect(mockedExecutors.reloadConfig).toHaveBeenCalledWith('ex-1', {});
    });
  });
});

// ── ④ SSE 实时状态（合并纯函数） ────────────────────────────────────────

describe('UI-07 ④ /metrics/stream executors 段合并', () => {
  it('executorStatsToMap：按 id 建 map，畸形行（非对象/无 id）跳过', () => {
    const map = executorStatsToMap([
      { id: 'a', status: 'online', cpuUsage: 11 },
      { status: 'offline' },
      null,
      'garbage',
    ]);
    expect(Object.keys(map)).toEqual(['a']);
    expect(map.a.cpuUsage).toBe(11);
    expect(executorStatsToMap('not-array')).toEqual({});
    expect(executorStatsToMap(null)).toEqual({});
  });

  it('mergeStreamOverlay：流值优先覆盖同 id 字段，流缺失执行器回退轮询值', () => {
    const polled = [
      makeExecutor({ id: 'a', status: 'offline', cpuUsage: 1, memUsage: 2, runningTaskCount: 0 }),
      makeExecutor({ id: 'b', status: 'online', cpuUsage: 5 }),
    ];
    const overlay = executorStatsToMap([
      { id: 'a', status: 'online', cpuUsage: 90, memUsage: 80, runningTaskCount: 3 },
    ]);
    const merged = mergeStreamOverlay(polled, overlay);
    expect(merged[0].status).toBe('online');
    expect(merged[0].cpuUsage).toBe(90);
    expect(merged[0].memUsage).toBe(80);
    expect(merged[0].runningTaskCount).toBe(3);
    // 流里没有 b：原样保留
    expect(merged[1]).toBe(polled[1]);
  });

  it('mergeStreamOverlay：空覆盖层返回原数组（同一引用，避免多余重渲染）', () => {
    const polled = [makeExecutor({})];
    expect(mergeStreamOverlay(polled, {})).toBe(polled);
  });

  it('mergeStreamOverlay：流字段类型不合法时回退轮询值（null cpuUsage 等）', () => {
    const polled = [makeExecutor({ id: 'a', cpuUsage: 42 })];
    const overlay = executorStatsToMap([{ id: 'a', cpuUsage: null, status: undefined }]);
    const merged = mergeStreamOverlay(polled, overlay);
    expect(merged[0].cpuUsage).toBe(42);
    expect(merged[0].status).toBe('online');
  });
});

// ── ViewToggle 组件形态（独立渲染冒烟） ─────────────────────────────────

describe('UI-07 ViewToggle 组件', () => {
  it('渲染两态选项并回调', () => {
    let val = 'table';
    const { container, unmount } = render(
      <ViewToggle value="table" onChange={(m) => { val = m; }} />,
    );
    fireEvent.click(screen.getByText('卡片'));
    expect(val).toBe('card');
    expect(container).toBeTruthy();
    unmount();
  });
});
