/**
 * COLWIDTH-01 / FIXEDCOL-01（生产反馈）：
 *
 *   ①「应用管理页面的表格，名称列的宽度太宽了」；
 *   ②「右侧的操作区域没有固定在右侧，导致编辑只显示到『编』字，右侧区域需要
 *     滚动滑动条才能看到」。
 *
 * 两条是**同一个根因**的两面，jsdom 没有布局引擎，所以本文件按本仓既有的
 * 「断言渲染产物」口径，把两条**可静态检出的结构不变量**钉住；真实几何量测
 * 见文件末尾的注释（真实 Chromium 实测数据）。
 *
 * 根因（实测，非推断）：
 *  · `@rc-component/table` 的 `useWidthColumns` 在 `scroll.x` 有值时会统计
 *    「已给 width 的列」之和，把 `maxFitWidth - 已用` **全部**平摊给「没给
 *    width 的列」。应用列表此前名称列是**唯一**没给 width 的列 → 它独占全部
 *    剩余空间（1280→262px、1440→422px、1920→902px、2560→1542px，随视口线性
 *    膨胀）。这就是「名称列太宽」。
 *  · 操作列 width=210 而列内「详情/新建部署/编辑/删除」四个带文字按钮实测需要
 *    272px → 溢出 62px。`position: sticky` 只约束 td 自身盒子，溢出到盒外的
 *    内容不参与 sticky，被横向滚动容器裁掉 → 未滚动时右侧正好切在「编」字之后，
 *    拖动滚动条才看得到「辑/删除」。这就是「操作列没固定住」。
 *
 * 修复：名称列给 width（260）、操作列给足（300）、`scroll.x` **恰好等于**
 * 各列 width 之和（260+90+90+100+150+110+300 = 1100）。真实 Chromium 复测
 * （修复后）：1280px 视口 scrollLeft=0 与 scrollLeft=max 两端，操作列右边界都
 * 等于滚动容器右边界（sticky 生效），列内溢出 -39px（不再裁切）。
 *
 * 为什么是「恰好等于」而不是「大于等于」：小于之和时 rc-table 会反向压缩
 * 弹性列；大于之和时会多出一截纯空白滚动区，稍窄的视口下会有一整列被固定列
 * 完全盖住（实测 1140 时 1280px 视口的「最后部署」列被遮挡）。改动任一列
 * width 必须同步 `scroll.x`——本文件第三个用例就是这条守卫。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ApplicationListPage from '../pages/ApplicationListPage';
import { applicationsApi } from '../api/applications';

vi.mock('../api/applications', () => ({
  applicationsApi: {
    list: vi.fn(),
    delete: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    upload: vi.fn(),
    removalImpact: vi.fn(),
  },
  deploymentsApi: { list: vi.fn(), stats: vi.fn().mockResolvedValue([]), deploy: vi.fn() },
  mutexGroupsApi: { list: vi.fn().mockResolvedValue([]), create: vi.fn() },
}));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn(), picker: vi.fn() },
}));
vi.mock('../store/auth', () => ({
  isAdminUser: () => true,
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: 1, role: 'admin' } }),
  useIsAdmin: () => true,
}));

// jsdom 缺失 antd 依赖的浏览器 API，先行补齐（既有先例 shim）
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
    matches: /prefers-reduced-motion: reduce/.test(q),
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <ApplicationListPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.mocked(applicationsApi.list).mockReset().mockResolvedValue([
    {
      id: 'app-1',
      name: '数据采集平台-生产环境-长名称验证用例',
      description: 'x',
      version: '2.3.1',
      runtime: 'python',
      status: 'running',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
  ] as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** 取表头单元格（按文案）。 */
const thByText = (text: string): HTMLElement | null =>
  (Array.from(document.querySelectorAll('.ant-table-thead th')) as HTMLElement[]).find(
    (th) => (th.textContent ?? '').trim() === text,
  ) ?? null;

describe('ApplicationListPage 表格列宽（COLWIDTH-01）', () => {
  it('名称列显式声明 width——它是「名称列太宽」的根因（唯一无 width 的列会吞掉全部余量）', async () => {
    renderPage();
    await screen.findByText('数据采集平台-生产环境-长名称验证用例');

    const nameTh = thByText('名称');
    expect(nameTh).not.toBeNull();
    // rc-table 把列宽写进 colgroup（第 1 个 col 对应第 1 列）
    const firstCol = document.querySelector('.ant-table colgroup col') as HTMLElement | null;
    expect(firstCol).not.toBeNull();
    // 修复前这里没有 width（style.width === ''），修复后是具体像素值
    expect(firstCol!.style.width).toBe('260px');
  });

  it('操作列 width 足以容纳四个带文字按钮（≥300），且仍是 fixed=end', async () => {
    renderPage();
    await screen.findByText('数据采集平台-生产环境-长名称验证用例');

    const actionTh = thByText('操作');
    expect(actionTh).not.toBeNull();
    // rc-table 把 legacy 'right' 归一成 'end'
    expect(actionTh!.className).toContain('ant-table-cell-fix-end');
    const cols = document.querySelectorAll('.ant-table colgroup col');
    const lastCol = cols[cols.length - 1] as HTMLElement;
    expect(Number.parseFloat(lastCol.style.width)).toBeGreaterThanOrEqual(300);
  });

  it('scroll.x 恰好等于各列 width 之和（小于会压缩弹性列，大于会多出空白滚动区并遮挡固定列）', async () => {
    renderPage();
    await screen.findByText('数据采集平台-生产环境-长名称验证用例');

    const table = document.querySelector('.ant-table-content table') as HTMLElement | null;
    expect(table).not.toBeNull();
    const scrollX = Number.parseFloat(table!.style.width);
    const colSum = Array.from(document.querySelectorAll('.ant-table colgroup col')).reduce(
      (acc, c) => acc + (Number.parseFloat((c as HTMLElement).style.width) || 0),
      0,
    );
    expect(colSum).toBeGreaterThan(0);
    // 精确相等而非 >=：见文件头注（大于之和会多出空白滚动区、遮挡固定列）。
    // 这条断言同时充当「改了任一列 width 却没同步 scroll.x」的守卫。
    expect(scrollX).toBe(colSum);
    // 兼作回归哨：改回旧的 1000（小于列宽之和）时立即变红。
    expect(scrollX).toBe(1100);
  });
});
