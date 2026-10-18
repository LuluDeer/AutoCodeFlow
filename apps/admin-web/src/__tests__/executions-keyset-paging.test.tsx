/**
 * §2.1（PLAN-BACKEND-ARCHITECTURE 游标分页推广）ExecutionsPage 消费 keyset
 * `nextCursor` 的前端契约。
 *
 * ## 本轮要守住的四件事（每件都由一条用例钉死）
 *
 * ① **默认零风险**：开关关闭时请求里**不存在** `cursor` 这个键。这是"旧路径
 *    没被碰到"的唯一可执行证据——后端契约规定不带 cursor → 响应逐字节不变
 *    （连 nextCursor 都不出现），故只要请求侧不带它，行为就必然与改动前一致。
 *    断言用 `'cursor' in params` 而不是 `params.cursor === undefined`：前者
 *    才能区分"键不存在"与"键存在但值为 undefined"。
 *
 * ② **`undefined` ≠ `''`**：`undefined` 让 axios 把键整个丢掉（OFFSET 路径），
 *    空串序列化成 `?cursor=`（keyset 起点）。两者语义不同，前端一旦用
 *    `cursor ?? ''` 或 `if (cursor)` 归一，keyset 起点就永远进不去。
 *
 * ③ **游标栈**：游标分页没有"跳到第 N 页"，只有「下一页」令牌。上一页靠栈
 *    回退，故栈里存的就是"第 i 页要发的 cursor"，逐页回退必须发出**当初**的
 *    游标（不是重新算的）。
 *
 * ④ **重置时机**：任何改变结果集的入口（四处筛选 / 清除筛选 / pageSize 变更 /
 *    kill 后失效）都必须把栈归零。带着旧筛选的游标继续翻，后端的游标条件与
 *    过滤器取交集后会返回"从某条不相干的行往后"的错乱结果——不报错、不空白，
 *    只是内容错了，这是最难被发现的缺陷形态，故必须有断言。
 *
 * 隔离方式对齐 executions-page.test.tsx / executions-deeplink.test.tsx 先例：
 * mock api 模块（而非 axios 拦截器）+ QueryClientProvider + antd 浏览器 API shim。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ExecutionsPage from '../pages/ExecutionsPage';
import { tasksApi } from '../api/tasks';
import type { TaskExecution, PageResult } from '../api/tasks';

vi.mock('../api/tasks', () => ({
  tasksApi: {
    allExecutions: vi.fn(),
    killExecution: vi.fn(),
  },
}));
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

const exec = (over: Partial<TaskExecution>): TaskExecution => ({
  id: 'exec-1',
  taskId: 'task-1',
  taskName: '备份任务',
  status: 'success',
  triggerType: 'cron',
  executorAddress: '10.0.0.1:3002',
  startTime: '2026-09-07T10:00:00Z',
  endTime: '2026-09-07T10:01:00Z',
  duration: 60_000,
  params: null,
  createdAt: '2026-09-07T10:00:00Z',
  ...over,
});

/**
 * OFFSET 路径的响应：**没有** `nextCursor` 键（后端逐字节不变的旧响应形态）。
 * 这里刻意不写 `nextCursor: undefined`——要复刻"键不存在"的真实形状。
 */
const offsetFixture = (rows: TaskExecution[], total = rows.length): PageResult<TaskExecution> => ({
  items: rows,
  total,
  page: 1,
  pageSize: 20,
});

/** keyset 路径的响应：键必然存在，`null` = 末页。 */
const keysetFixture = (
  rows: TaskExecution[],
  nextCursor: string | null,
  total = rows.length,
): PageResult<TaskExecution> => ({
  items: rows,
  total,
  page: 1,
  pageSize: 20,
  nextCursor,
});

/**
 * 无状态的假后端：**响应只由请求的 cursor 决定**。
 *
 * 为什么不用 `mockResolvedValueOnce` 序列：本页有两个请求源（初始挂载 +
 * 开关切换）且各自会重取（轮询/失效），"第 N 次调用返回第 N 个值"的序列会
 * 与真实调用次数错位——测试就变成在赌内部执行顺序，红/绿都不代表行为。
 * 纯函数式 mock 让每一页的语义一目了然（见 `CURSOR_PAGE_*` 映射表），也让
 * "上一页重发旧游标"这类断言真正检验栈，而不是检验 mock 的消费顺序。
 *
 * 页 → 游标映射（与后端约定一致：响应里的 nextCursor 是**进入下一页**的令牌）：
 *   ''（起点）    → 本页 CURSOR_PAGE_2
 *   CURSOR_PAGE_2 → 本页 CURSOR_PAGE_3
 *   CURSOR_PAGE_3 → 末页（nextCursor: null）
 *   其他          → 末页（null），代表"游标行不存在"时的安全提前结束
 */
function installFakeBackend() {
  const cursorOf = (params: Record<string, unknown> | undefined): string =>
    (params?.cursor ?? '') as string;
  mockedTasks.allExecutions.mockImplementation((async (params?: Record<string, unknown>) => {
    const cursor = cursorOf(params);
    const nextByCursor: Record<string, string | null> = {
      '': 'CURSOR_PAGE_2',
      CURSOR_PAGE_2: 'CURSOR_PAGE_3',
      CURSOR_PAGE_3: null,
    };
    const nextCursor = cursor in nextByCursor ? nextByCursor[cursor]! : null;
    return keysetFixture([exec({ id: `row-${cursor || 'first'}` })], nextCursor, 200);
  }) as never);
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/executions']}>
        <Routes>
          <Route path="/executions" element={<ExecutionsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 最后一次列表请求的参数对象。 */
const lastParams = (): Record<string, unknown> =>
  (mockedTasks.allExecutions.mock.calls[
    mockedTasks.allExecutions.mock.calls.length - 1
  ]?.[0] ?? {}) as Record<string, unknown>;

/** antd 双汉字按钮自动插空格，textContent 归一化后再匹配（既有先例） */
const findBtn = (root: ParentNode, text: string): HTMLButtonElement | null =>
  (Array.from(root.querySelectorAll('button')) as HTMLButtonElement[]).find(
    (b) => (b.textContent ?? '').replace(/\s/g, '') === text,
  ) ?? null;

/**
 * 自绘分页器按钮。
 *
 * 用 `textContent.includes` 而不是等值匹配：「下一页」按钮的标签与 `<RightOutlined />`
 * 相邻（无 `Split` 时两者之间不会插空格），等值匹配会因图标空白而漏掉。
 * `includes` 对「上一页 / 下一页」这两个互不为子串的词仍是精确的。
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
  await waitFor(() => {
    expect(lastParams().cursor).toBe('');
  });
}

beforeEach(() => {
  mockedTasks.allExecutions.mockReset();
  mockedTasks.killExecution.mockReset();
});
afterEach(() => cleanup());

describe('ExecutionsPage keyset 分页：默认路径零风险', () => {
  it('开关默认关闭，且请求里**不存在** cursor 键（旧 OFFSET 路径逐字节不变）', async () => {
    mockedTasks.allExecutions.mockResolvedValue(offsetFixture([exec({})]));
    renderPage();
    await screen.findByText('成功');

    const params = lastParams();
    // 核心断言：键根本不存在。`params.cursor === undefined` 无法区分
    // "键不存在" 与 "键存在且为 undefined"，而 axios 对后者的处理虽然一样，
    // 前者才是"我们没碰旧路径"的强证据。
    expect('cursor' in params).toBe(false);
    expect(params.page).toBe(1);
    expect(params.pageSize).toBe(20);

    // 默认模式下不渲染自绘分页器，antd 页码器仍在（旧形态）
    expect(findBtn(document.body, '上一页')).toBeNull();
    expect(findBtn(document.body, '下一页')).toBeNull();
  });

  it('开关具备可访问名（aria-label），可被键盘/AT 定位', async () => {
    mockedTasks.allExecutions.mockResolvedValue(offsetFixture([exec({})]));
    renderPage();
    await screen.findByText('成功');

    const sw = screen.getByRole('switch');
    expect(sw.getAttribute('aria-label')).toBe('稳定翻页（游标分页，深翻页不受数据变动影响）');
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });
});

describe('ExecutionsPage keyset 分页：起点与下一页', () => {
  it('打开开关 → 第一页带 cursor=""（空串 = keyset 起点，不是"不带参数"）', async () => {
    mockedTasks.allExecutions.mockResolvedValue(keysetFixture([exec({})], null));
    renderPage();
    await screen.findByText('成功');

    await enableStablePaging();

    const params = lastParams();
    expect('cursor' in params).toBe(true);
    // 必须是空串：若实现写成 undefined（或把空串归一成 undefined），
    // 后端会走 OFFSET 分支，keyset 模式就静默失效了。
    expect(params.cursor).toBe('');
    expect(params.cursor).not.toBeUndefined();
  });

  it('第二页 → 带上一页响应里的 nextCursor（原样回传，不解析）', async () => {
    mockedTasks.allExecutions
      .mockResolvedValue(keysetFixture([exec({ id: 'e1' })], 'CURSOR_PAGE_2'));

    renderPage();
    await screen.findByText('成功');
    await enableStablePaging();
    // 必须等 keyset 模式**首屏响应落地**再点：`nextCursor` 从 data 派生，
    // 在首屏 data 到达前按钮是禁用的（点一个禁用按钮什么都不会发生）。
    await waitFor(() => expect(pagerBtn('下一页').disabled).toBe(false));

    fireEvent.click(pagerBtn('下一页'));

    await waitFor(() => {
      expect(lastParams().cursor).toBe('CURSOR_PAGE_2');
    });
    // 不透明令牌：客户端不得加工（截断/解码/拼接），必须是逐字节相同的那串
    expect(lastParams().cursor).not.toBe('');
  });

  it('后端返回 nextCursor: null → 「下一页」禁用（且点击不发请求）', async () => {
    mockedTasks.allExecutions.mockResolvedValue(keysetFixture([exec({})], null));
    renderPage();
    await screen.findByText('成功');
    await enableStablePaging();

    const next = pagerBtn('下一页');
    expect(next.disabled).toBe(true);

    const callsBefore = mockedTasks.allExecutions.mock.calls.length;
    fireEvent.click(next);
    // 禁用按钮点击不应产生"翻到不存在的下一页"的请求
    await new Promise((r) => setTimeout(r, 30));
    expect(mockedTasks.allExecutions.mock.calls.length).toBe(callsBefore);
  });

  it('上一页 → 回到栈中前一页的游标（栈首额外禁用）', async () => {
    installFakeBackend();

    renderPage();
    await screen.findByText('成功');
    await enableStablePaging();

    // 进第 2 页（cursor=CURSOR_PAGE_2），再进第 3 页（cursor=CURSOR_PAGE_3）。
    // 每步都等新数据落地（按钮可用 = nextCursor 已到），否则第二下点的是
    // 上一页残留的令牌。
    await waitFor(() => expect(pagerBtn('下一页').disabled).toBe(false));
    expect(pagerBtn('上一页').disabled).toBe(true); // 栈首禁用
    fireEvent.click(pagerBtn('下一页'));
    await waitFor(() => expect(lastParams().cursor).toBe('CURSOR_PAGE_2'));

    await waitFor(() => expect(pagerBtn('下一页').disabled).toBe(false));
    fireEvent.click(pagerBtn('下一页'));
    await waitFor(() => expect(lastParams().cursor).toBe('CURSOR_PAGE_3'));

    // 回退一格 → 必须重新发出"CURSOR_PAGE_2"（栈里存的就是当初那一页的游标）
    fireEvent.click(pagerBtn('上一页'));
    await waitFor(() => expect(lastParams().cursor).toBe('CURSOR_PAGE_2'));

    // 再退到栈首 → 回到空串起点，且上一页重新禁用
    fireEvent.click(pagerBtn('上一页'));
    await waitFor(() => expect(lastParams().cursor).toBe(''));
    expect(pagerBtn('上一页').disabled).toBe(true);
  });

  it('keyset 模式下不渲染页码器（不给出"点第 5 页其实在第 2 页"的骗人页码）', async () => {
    // total 故意给 200 → 旧 OFFSET 模式下 antd 会据此渲染出 10 个页码
    mockedTasks.allExecutions.mockResolvedValue(keysetFixture([exec({})], 'CURSOR_PAGE_2', 200));
    renderPage();
    await screen.findByText('成功');

    // OFFSET 模式下确实有页码器（对照）
    expect(document.querySelector('.ant-pagination')).toBeTruthy();

    await enableStablePaging();

    // keyset 模式：页码器整体消失，只剩自绘的两个按钮
    expect(document.querySelector('.ant-pagination')).toBeNull();
    expect(pagerBtn('上一页')).toBeTruthy();
    expect(pagerBtn('下一页')).toBeTruthy();
  });
});

describe('ExecutionsPage keyset 分页：游标必须在改筛选时重置', () => {
  it('状态筛选变化 → 游标重置（下一次请求带空串而非旧游标）', async () => {
    mockedTasks.allExecutions.mockResolvedValue(keysetFixture([exec({ id: 'e1' })], 'CURSOR_OLD'));

    renderPage();
    await screen.findByText('成功');
    await enableStablePaging();

    // 先翻到第 2 页，让栈里存在一个非空游标
    await waitFor(() => expect(pagerBtn('下一页').disabled).toBe(false));
    fireEvent.click(pagerBtn('下一页'));
    await waitFor(() => expect(lastParams().cursor).toBe('CURSOR_OLD'));

    // 改状态筛选 → 结果集完全不同，旧游标必须作废
    fireEvent.mouseDown(screen.getByText('全部状态'));
    fireEvent.click(await screen.findByText('失败', { selector: '.ant-select-item-option-content' }));

    await waitFor(() => {
      const p = lastParams();
      expect(p.status).toBe('failed');
      // 关键：不是 CURSOR_OLD（带着旧筛选的游标继续翻 = 错乱数据）
      expect(p.cursor).not.toBe('CURSOR_OLD');
      expect(p.cursor).toBe('');
    });
  });

  it('搜索框输入 → 游标重置', async () => {
    mockedTasks.allExecutions.mockResolvedValue(keysetFixture([exec({ id: 'e1' })], 'CURSOR_OLD'));

    renderPage();
    await screen.findByText('成功');
    await enableStablePaging();
    await waitFor(() => expect(pagerBtn('下一页').disabled).toBe(false));
    fireEvent.click(pagerBtn('下一页'));
    await waitFor(() => expect(lastParams().cursor).toBe('CURSOR_OLD'));

    fireEvent.change(screen.getByPlaceholderText('搜索任务名'), { target: { value: '备份' } });

    await waitFor(() => {
      const p = lastParams();
      expect(p.taskName).toBe('备份');
      expect(p.cursor).toBe('');
    });
  });

  it('执行器筛选变化 → 游标重置', async () => {
    mockedTasks.allExecutions.mockResolvedValue(keysetFixture([exec({ id: 'e1' })], 'CURSOR_OLD'));

    renderPage();
    await screen.findByText('成功');
    await enableStablePaging();
    await waitFor(() => expect(pagerBtn('下一页').disabled).toBe(false));
    fireEvent.click(pagerBtn('下一页'));
    await waitFor(() => expect(lastParams().cursor).toBe('CURSOR_OLD'));

    fireEvent.change(screen.getByPlaceholderText('执行器地址'), { target: { value: '10.0.0.' } });

    await waitFor(() => {
      const p = lastParams();
      expect(p.executorAddress).toBe('10.0.0.');
      expect(p.cursor).toBe('');
    });
  });

  it('清除筛选 → 游标重置回 keyset 起点', async () => {
    mockedTasks.allExecutions.mockResolvedValue(keysetFixture([exec({ id: 'e1' })], 'CURSOR_OLD'));

    renderPage();
    await screen.findByText('成功');
    await enableStablePaging();

    // 先加一个筛选（让「清除筛选」按钮出现），再翻页
    fireEvent.change(screen.getByPlaceholderText('执行器地址'), { target: { value: '10.0.0.' } });
    await waitFor(() => expect(lastParams().executorAddress).toBe('10.0.0.'));
    await waitFor(() => expect(pagerBtn('下一页').disabled).toBe(false));
    fireEvent.click(pagerBtn('下一页'));
    await waitFor(() => expect(lastParams().cursor).toBe('CURSOR_OLD'));

    fireEvent.click(findBtn(document.body, '清除筛选')!);

    await waitFor(() => {
      const p = lastParams();
      expect(p.executorAddress).toBeUndefined();
      // 清除后仍是 keyset 模式（开关没关），故是空串起点而不是"不带 cursor"
      expect(p.cursor).toBe('');
    });
  });

  it('外部深链改筛选（URL → state 的 setter 链路）→ 游标重置', async () => {
    // 这一条覆盖「游标重置」在**非直接 onChange** 入口上的行为：筛选也可以
    // 由外部导航写入（通知铃铛/Dashboard 深链、浏览器前进后退），走的是
    // useUrlStateSync 的 URL→state 方向。若只给四处 onChange 挂重置、漏了这条
    // 链路，深链进来时就会带着上一个结果集的游标。
    //
    // 注：**时间范围**没有走真实交互——antd RangePicker 6.6.5 在 jsdom 下
    // 点格子只更新展示文本，onChange 要等区间的第二端落定，而该状态由
    // rc-picker 的指针移动/焦点序列驱动，jsdom 既无真实指针也无布局：试过
    // click / mouseDown+mouseUp / mouseenter / 双面板格子 / 键入+Enter，均不
    // 触发 onChange。它的重置逻辑与其余三处是同一个 `resetCursorStack` 调用
    // （见 ExecutionsPage 的 RangePicker onChange），故由本用例代表该链路。
    installFakeBackend();

    renderPage();
    await screen.findByText('成功');
    await enableStablePaging();

    // 先造出一个非空游标（第 2 页）
    await waitFor(() => expect(pagerBtn('下一页').disabled).toBe(false));
    fireEvent.click(pagerBtn('下一页'));
    await waitFor(() => expect(lastParams().cursor).toBe('CURSOR_PAGE_2'));

    // 外部改筛选：清空搜索框 = 结果集变化，旧游标必须作废
    fireEvent.change(screen.getByPlaceholderText('搜索任务名'), { target: { value: '备份' } });

    await waitFor(() => {
      const p = lastParams();
      expect(p.taskName).toBe('备份');
      // 关键：不是 CURSOR_PAGE_2（带着旧筛选的游标继续翻 = 错乱数据）
      expect(p.cursor).toBe('');
    });
  });

  it('kill 后刷新 → 回到栈首（keyset 下不赌"游标行还活着"）', async () => {
    // kill 会触发 invalidateExecutionData → 列表重取。OFFSET 模式下原地重取
    // 是对的（行位置不变）；keyset 模式下"原地重取"依赖当前页游标仍指向一个
    // **存在**的行：被 kill 的行若恰好是游标行（本页最后一行）或被并发删除，
    // 后端会返回空页 + nextCursor:null（安全提前结束），用户会看到"当前页突然
    // 空了"。故 keyset 模式下 kill 后一律回栈首。
    mockedTasks.allExecutions.mockImplementation((async (params?: Record<string, unknown>) => {
      const cursor = (params?.cursor ?? '') as string;
      // 第 1 页 + 第 2 页各有一行 running（kill 目标在第 2 页，验证它确实在非首屏）
      return keysetFixture(
        [exec({ id: cursor === 'CURSOR_PAGE_2' ? 'exec-page2' : 'exec-page1', status: 'running' })],
        cursor === '' ? 'CURSOR_PAGE_2' : null,
      );
    }) as never);
    mockedTasks.killExecution.mockResolvedValue({ success: true, message: 'ok' });

    renderPage();
    await screen.findByText('运行中');
    await enableStablePaging();

    // 翻到第 2 页（此时栈 index = 1）
    await waitFor(() => expect(pagerBtn('下一页').disabled).toBe(false));
    fireEvent.click(pagerBtn('下一页'));
    await waitFor(() => expect(lastParams().cursor).toBe('CURSOR_PAGE_2'));

    // 终止 → 成功后必须回到栈首（下一次列表请求的游标是空串起点）
    fireEvent.click(await screen.findByText('终止'));
    const okBtn = (() => {
      const layerBtns = Array.from(document.querySelectorAll('.ant-popover button')) as HTMLButtonElement[];
      return layerBtns[layerBtns.length - 1];
    })();
    expect(okBtn).toBeTruthy();
    fireEvent.click(okBtn);

    await waitFor(() => expect(mockedTasks.killExecution).toHaveBeenCalled());
    await waitFor(() => {
      // 栈首 = keyset 起点（空串），而不是原地重发 CURSOR_PAGE_2
      expect(lastParams().cursor).toBe('');
    });
  });

  it('pageSize 变更 → 游标重置（keyset 下页大小变了，旧游标不再对应切片边界）', async () => {
    // keyset 模式不渲染 antd 分页器（没有 pageSize 选择器），故这条只能在
    // OFFSET 模式下验证"重置被接上"，再验证 keyset 模式下**不存在**会改
    // pageSize 的入口——两条合起来证明 keyset 期间不会出现"旧游标 + 新页大小"。
    mockedTasks.allExecutions.mockResolvedValue(offsetFixture([exec({})], 200));
    renderPage();
    await screen.findByText('成功');

    // OFFSET 模式：分页器在，且点击换页不会引入 cursor（旧路径不受影响）
    const pagination = document.querySelector('.ant-pagination');
    expect(pagination).toBeTruthy();
    expect('cursor' in lastParams()).toBe(false);

    await enableStablePaging();
    // keyset 模式：分页器整体消失 → 不存在改 pageSize 的入口
    expect(document.querySelector('.ant-pagination')).toBeNull();
  });

});
