/**
 * §2.1（PLAN-BACKEND-ARCHITECTURE 游标分页推广）ExecutorPackagesPage 消费
 * keyset `nextCursor` 的前端契约。
 *
 * 后端（4cc26327）给 `GET /executor-packages` **加性**支持了可选 `cursor`，
 * 响应**追加** `nextCursor`。⚠️ 该端点的响应是裸 `{items,total}` 而**不是**
 * `paginate()` 信封，keyset 分支也不改形状（keyset 键序 `["items","total",
 * "nextCursor"]`）——这是刻意的：`items` 同时被包表与安装向导的 `listLatest`
 * 消费，改成信封会让 `res.items` 变 undefined、包表恒空。
 *
 * 本页按 ExecutionsPage 的**同一套范式**实现（那边已有 14 条用例钉死，不另造
 * 一套）。下面每条用例对应范式里的一个不变量：
 *
 * ① **默认零风险**：开关关闭时请求里**不存在** `cursor` 这个键。断言用
 *    `'cursor' in params` 而不是 `params.cursor === undefined`——只有前者能区分
 *    "键不存在"与"键存在但值为 undefined"。
 * ② **`undefined` ≠ `''`**：`undefined` 让 axios 把键整个丢掉（OFFSET 路径），
 *    空串序列化成 `?cursor=`（keyset 起点）。前端一旦用 `cursor ?? ''` 或
 *    `if (cursor)` 归一，keyset 起点就永远进不去。
 * ③ **游标栈**：没有「上一页」令牌，上一页靠栈回退，且必须发出**当初**那个游标。
 * ④ **重置点全覆盖**：包名搜索 / 类型筛选 / 状态筛选 / 页码变更 / 翻页护栏——
 *    任何改变结果集的入口都要把栈归零。
 * ⑤ **listLatest 不受影响**：它走**同一个端点**但是固定切片（active 前 100），
 *    **不传 cursor**，OFFSET 路径逐字节不变。这条单独钉死——它的候选列表若
 *    跟着包表的翻页状态漂移，安装向导会给出错的包且无人察觉。
 *
 * 隔离方式对齐 executor-packages-audit.test.tsx 先例：mock api 模块 +
 * antd 浏览器 API shim。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import ExecutorPackagesPage from '../pages/ExecutorPackagesPage';
import { listPackages } from '../api/executor-packages';
import type { ExecutorPackage } from '../api/executor-packages';
import { executorsApi } from '../api/executors';
import { Modal as confirmModal } from '../utils/modal';
import { message } from '../utils/toast';

// 页面消费的具名导出 + 本 spec 直测 listLatest 所需的 api 对象。
// `executorPackagesApi.list` 不是页面用的那个（页面走 listPackages），
// 故这里把 list 也接上，供下方「api 层」用例直接驱动。
vi.mock('../api/executor-packages', () => ({
  listPackages: vi.fn(),
  uploadPackage: vi.fn(),
  deletePackage: vi.fn(),
  pushPackage: vi.fn(),
  deprecatePackage: vi.fn(),
  activatePackage: vi.fn(),
  downloadPackage: vi.fn(),
  // 页面只消费具名导出；这里保留 api 对象是为了让 mock 形状与真实模块一致
  // （真实模块同时导出二者），否则将来页面改用 api 对象时会静默变 undefined。
  executorPackagesApi: { list: vi.fn(), listLatest: vi.fn() },
}));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn() },
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

const packageRow = (over: Partial<ExecutorPackage> = {}): ExecutorPackage => ({
  id: 'pkg-1',
  name: 'python-runner',
  version: '1.0.0',
  type: 'python',
  platform: 'linux',
  fileSize: 1024,
  checksum: 'sha256',
  changelog: '',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

/**
 * OFFSET 路径的响应：**没有** `nextCursor` 键（后端逐字节不变的旧响应形态）。
 * 刻意不写 `nextCursor: undefined`——要复刻"键不存在"的真实形状。
 */
const offsetFixture = (items: ExecutorPackage[], total = items.length) => ({ items, total });

/** keyset 路径的响应：键必然存在，`null` = 末页。 */
const keysetFixture = (
  items: ExecutorPackage[],
  nextCursor: string | null,
  total = items.length,
) => ({ items, total, nextCursor });

/** 最后一次列表请求的参数对象。 */
const lastParams = (): Record<string, unknown> => {
  const calls = vi.mocked(listPackages).mock.calls;
  return (calls[calls.length - 1]?.[0] ?? {}) as Record<string, unknown>;
};

/** antd 双汉字按钮自动插空格，textContent 归一化后匹配（既有先例）。 */
const findBtn = (root: ParentNode, text: string): HTMLButtonElement | null =>
  (Array.from(root.querySelectorAll('button')) as HTMLButtonElement[]).find(
    (b) => (b.textContent ?? '').replace(/\s/g, '') === text,
  ) ?? null;

/**
 * 自绘分页器按钮。用 `includes` 而不是等值匹配：「下一页」标签与
 * `<RightOutlined />` 相邻且不插空格，等值匹配会因图标空白漏掉。
 */
const pagerBtn = (label: '上一页' | '下一页'): HTMLButtonElement => {
  const btn = (Array.from(document.querySelectorAll('button')) as HTMLButtonElement[]).find(
    (b) => (b.textContent ?? '').replace(/\s/g, '').includes(label),
  );
  expect(btn, `未找到分页按钮：${label}`).toBeTruthy();
  return btn!;
};

/** 打开「稳定翻页」开关（antd Switch 渲染成 role="switch" 的 button）。 */
async function enableStablePaging() {
  const sw = await screen.findByRole('switch');
  fireEvent.click(sw);
  // 切换会把游标栈重置成 keyset 起点并重取一次
  await waitFor(() => expect(lastParams().cursor).toBe(''));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listPackages).mockResolvedValue(offsetFixture([packageRow()]));
  vi.mocked(executorsApi.list).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  confirmModal.destroyAll();
  message.destroy();
});

describe('ExecutorPackagesPage keyset：默认路径零风险', () => {
  it('开关默认关闭，且请求里**不存在** cursor 键（旧 OFFSET 路径逐字节不变）', async () => {
    render(<ExecutorPackagesPage />);
    await screen.findByText('python-runner');

    const params = lastParams();
    // ① 核心断言：键根本不存在。
    expect('cursor' in params).toBe(false);
    expect(params.page).toBe(1);
    expect(params.pageSize).toBe(20);
    // 旧形态仍在：antd 页码器 + 没有自绘分页器
    expect(document.querySelector('.ant-pagination')).toBeTruthy();
    expect(findBtn(document.body, '上一页')).toBeNull();
    expect(findBtn(document.body, '下一页')).toBeNull();
  });

  it('开关具备可访问名（aria-label），可被键盘/AT 定位', async () => {
    render(<ExecutorPackagesPage />);
    await screen.findByText('python-runner');

    const sw = screen.getByRole('switch');
    expect(sw.getAttribute('aria-label')).toBe('稳定翻页（游标分页，深翻页不受数据变动影响）');
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });
});

describe('ExecutorPackagesPage keyset：起点 / 下一页 / 上一页', () => {
  it('打开开关 → 第一页带 cursor=""（空串 = keyset 起点，不是"不带参数"）', async () => {
    vi.mocked(listPackages).mockResolvedValue(keysetFixture([packageRow()], null));
    render(<ExecutorPackagesPage />);
    await screen.findByText('python-runner');

    await enableStablePaging();

    const params = lastParams();
    expect('cursor' in params).toBe(true);
    // ② 必须是空串：写成 undefined（或把空串归一掉）后端会走 OFFSET 分支，
    // keyset 模式就静默失效了。
    expect(params.cursor).toBe('');
    expect(params.cursor).not.toBeUndefined();
  });

  it('第二页 → 带上一页响应里的 nextCursor（原样回传，不解析）', async () => {
    vi.mocked(listPackages).mockResolvedValue(
      keysetFixture([packageRow()], 'CURSOR_PKG_2'),
    );
    render(<ExecutorPackagesPage />);
    await screen.findByText('python-runner');
    await enableStablePaging();

    await waitFor(() => expect(pagerBtn('下一页').disabled).toBe(false));
    fireEvent.click(pagerBtn('下一页'));

    await waitFor(() => expect(lastParams().cursor).toBe('CURSOR_PKG_2'));
    // 不透明令牌：客户端不得加工（截断/解码/拼接）
    expect(lastParams().cursor).not.toBe('');
  });

  it('后端返回 nextCursor: null → 「下一页」禁用，且点击不发请求', async () => {
    vi.mocked(listPackages).mockResolvedValue(keysetFixture([packageRow()], null));
    render(<ExecutorPackagesPage />);
    await screen.findByText('python-runner');
    await enableStablePaging();

    const next = pagerBtn('下一页');
    expect(next.disabled).toBe(true);

    const callsBefore = vi.mocked(listPackages).mock.calls.length;
    fireEvent.click(next);
    await new Promise((r) => setTimeout(r, 30));
    expect(vi.mocked(listPackages).mock.calls.length).toBe(callsBefore);
  });

  it('上一页 → 回到栈中前一页的游标（栈首额外禁用）', async () => {
    vi.mocked(listPackages).mockImplementation((async (params?: Record<string, unknown>) => {
      const cursor = (params?.cursor ?? '') as string;
      const nextByCursor: Record<string, string | null> = {
        '': 'CURSOR_PKG_2',
        CURSOR_PKG_2: 'CURSOR_PKG_3',
        CURSOR_PKG_3: null,
      };
      return keysetFixture(
        [packageRow({ id: `pkg-${cursor || 'first'}` })],
        cursor in nextByCursor ? nextByCursor[cursor]! : null,
        200,
      );
    }) as never);

    render(<ExecutorPackagesPage />);
    await screen.findByText('python-runner');
    await enableStablePaging();

    await waitFor(() => expect(pagerBtn('下一页').disabled).toBe(false));
    expect(pagerBtn('上一页').disabled).toBe(true); // 栈首禁用
    fireEvent.click(pagerBtn('下一页'));
    await waitFor(() => expect(lastParams().cursor).toBe('CURSOR_PKG_2'));

    await waitFor(() => expect(pagerBtn('下一页').disabled).toBe(false));
    fireEvent.click(pagerBtn('下一页'));
    await waitFor(() => expect(lastParams().cursor).toBe('CURSOR_PKG_3'));

    // ③ 回退一格 → 必须重新发出"CURSOR_PKG_2"（栈里存的就是当初那一页的游标）
    fireEvent.click(pagerBtn('上一页'));
    await waitFor(() => expect(lastParams().cursor).toBe('CURSOR_PKG_2'));

    // 再退到栈首 → 回到空串起点，且上一页重新禁用
    fireEvent.click(pagerBtn('上一页'));
    await waitFor(() => expect(lastParams().cursor).toBe(''));
    expect(pagerBtn('上一页').disabled).toBe(true);
  });

  it('keyset 模式下不渲染页码器（不给出"点第 5 页其实在第 2 页"的骗人页码）', async () => {
    // total 故意给 200 → 旧 OFFSET 模式下 antd 会据此渲染出 10 个页码
    vi.mocked(listPackages).mockResolvedValue(
      keysetFixture([packageRow()], 'CURSOR_PKG_2', 200),
    );
    render(<ExecutorPackagesPage />);
    await screen.findByText('python-runner');

    // OFFSET 模式下确实有页码器（对照）
    expect(document.querySelector('.ant-pagination')).toBeTruthy();

    await enableStablePaging();

    // keyset 模式：页码器整体消失，只剩自绘的两个按钮
    expect(document.querySelector('.ant-pagination')).toBeNull();
    expect(pagerBtn('上一页')).toBeTruthy();
    expect(pagerBtn('下一页')).toBeTruthy();
  });
});

describe('ExecutorPackagesPage keyset：游标必须在改筛选时重置（重置点全覆盖）', () => {
  /** 翻到第 2 页，让栈里存在一个非空游标（各用例的前置条件）。 */
  async function goToSecondPage() {
    await waitFor(() => expect(pagerBtn('下一页').disabled).toBe(false));
    fireEvent.click(pagerBtn('下一页'));
    await waitFor(() => expect(lastParams().cursor).toBe('CURSOR_OLD'));
  }

  it('包名搜索变化 → 游标重置（下一次请求带空串而非旧游标）', async () => {
    vi.mocked(listPackages).mockResolvedValue(
      keysetFixture([packageRow()], 'CURSOR_OLD'),
    );
    render(<ExecutorPackagesPage />);
    await screen.findByText('python-runner');
    await enableStablePaging();
    await goToSecondPage();

    // 搜索是 300ms 防抖的：等防抖后的请求落地
    fireEvent.change(screen.getByPlaceholderText('搜索包名…'), { target: { value: 'runner' } });

    await waitFor(
      () => {
        const p = lastParams();
        expect(p.name).toBe('runner');
        // ④ 关键：不是 CURSOR_OLD（带着旧筛选的游标继续翻 = 错乱数据）
        expect(p.cursor).not.toBe('CURSOR_OLD');
        expect(p.cursor).toBe('');
      },
      { timeout: 2000 },
    );
  });

  it('类型筛选变化 → 游标重置', async () => {
    vi.mocked(listPackages).mockResolvedValue(
      keysetFixture([packageRow()], 'CURSOR_OLD'),
    );
    render(<ExecutorPackagesPage />);
    await screen.findByText('python-runner');
    await enableStablePaging();
    await goToSecondPage();

    // 「类型」既是表格列标题也是筛选占位符——按 placeholder class 定位
    const typePlaceholder = screen
      .getAllByText('类型')
      .find((el) => (el as HTMLElement).classList?.contains('ant-select-placeholder'));
    expect(typePlaceholder).toBeTruthy();
    fireEvent.mouseDown(typePlaceholder!);
    const opt = await screen.findByText('Node.js', { selector: '.ant-select-item-option-content' });
    fireEvent.click(opt);

    await waitFor(() => {
      const p = lastParams();
      expect(p.type).toBe('node');
      expect(p.cursor).toBe('');
    });
  });

  it('状态筛选变化 → 游标重置', async () => {
    vi.mocked(listPackages).mockResolvedValue(
      keysetFixture([packageRow()], 'CURSOR_OLD'),
    );
    render(<ExecutorPackagesPage />);
    await screen.findByText('python-runner');
    await enableStablePaging();
    await goToSecondPage();

    const statusPlaceholder = screen
      .getAllByText('状态')
      .find((el) => (el as HTMLElement).classList?.contains('ant-select-placeholder'));
    expect(statusPlaceholder).toBeTruthy();
    fireEvent.mouseDown(statusPlaceholder!);
    const opt = await screen.findByText('已弃用', { selector: '.ant-select-item-option-content' });
    fireEvent.click(opt);

    await waitFor(() => {
      const p = lastParams();
      expect(p.status).toBe('deprecated');
      expect(p.cursor).toBe('');
    });
  });

  it('关闭开关 → 请求里 cursor 键消失（不是空串），页面回到页码分页', async () => {
    vi.mocked(listPackages).mockResolvedValue(
      keysetFixture([packageRow()], 'CURSOR_OLD'),
    );
    render(<ExecutorPackagesPage />);
    await screen.findByText('python-runner');
    await enableStablePaging();
    await goToSecondPage();
    expect(lastParams().cursor).toBe('CURSOR_OLD');

    // 关掉开关（同一个 switch）
    fireEvent.click(screen.getByRole('switch'));

    await waitFor(() => {
      const p = lastParams();
      // ① 再次回到"键不存在"的形态（不是 cursor: undefined，也不是 cursor: ''）
      expect('cursor' in p).toBe(false);
      expect(p.page).toBe(1);
    });
    // 页码器回来了，自绘分页器消失
    expect(document.querySelector('.ant-pagination')).toBeTruthy();
    expect(findBtn(document.body, '上一页')).toBeNull();
  });

  it('keyset 模式下翻页仍保留筛选（游标与过滤器是 AND 关系，不互相顶掉）', async () => {
    vi.mocked(listPackages).mockResolvedValue(
      keysetFixture([packageRow()], 'CURSOR_NEXT'),
    );
    render(<ExecutorPackagesPage />);
    await screen.findByText('python-runner');

    // 先加一个筛选（OFFSET 模式下），再开 keyset
    fireEvent.change(screen.getByPlaceholderText('搜索包名…'), { target: { value: 'py' } });
    await waitFor(() => expect(lastParams().name).toBe('py'), { timeout: 2000 });

    await enableStablePaging();
    await waitFor(() => expect(pagerBtn('下一页').disabled).toBe(false));
    fireEvent.click(pagerBtn('下一页'));

    await waitFor(() => {
      const p = lastParams();
      expect(p.cursor).toBe('CURSOR_NEXT');
      // 筛选没被游标翻页弄丢——两者一起下发（后端对它们取交集）
      expect(p.name).toBe('py');
    });
  });
});

/**
 * ⚠️ 特别提醒的那条：`listLatest()` 走**同一个端点**但是它要的是固定切片
 * （active 前 100），不是翻页。它**不传 cursor** ⇒ 后端走 OFFSET 分支 ⇒ 响应
 * 形态与加游标之前**逐字节一致**。本组用例把它钉死：包表的游标化不能泄漏成
 * 安装向导候选列表的漂移。
 *
 * 注：本文件在模块级别把 `api/executor-packages` 整个 mock 掉了（页面隔离需要），
 * 于是真实 `listLatest` 实现不可达。它的请求形状断言在**独立**的
 * `executor-packages-keyset-api.test.ts` 里做（那里只 mock `api/client`）——
 * 拆开是为了让这一条断言的是**真实实现**，而不是我自己的 mock。
 */
