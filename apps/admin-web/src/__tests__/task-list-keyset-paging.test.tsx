/**
 * §2.1（PLAN-BACKEND-ARCHITECTURE 游标分页推广）TaskListPage 消费 keyset
 * `nextCursor` 的前端契约。**这是前端最后一个接入页面。**
 *
 * ## 为什么单开一个文件
 * 既有 `task-list-deep.test.tsx` / `task-list-rbac.test.tsx` / `task-list-columns`
 * 等是页面功能面（渲染/操作/权限/列显隐），本份只钉**分页契约**。混在一起会让
 * "哪条断言的失败代表契约被破坏"变得不可读（与 audit-keyset-paging.test.tsx
 * 同一取舍）。
 *
 * ## 本轮要守住的八件事（每件都由用例钉死）
 *
 * ① **默认零风险**：开关关闭时请求里**不存在** `cursor` 这个键。断言打在
 *    `useTasksList` 收到的参数对象上，用 `'cursor' in params` 而不是
 *    `params.cursor === undefined`——只有前者能区分"键不存在"与"键存在但为
 *    undefined"，而"键不存在"才是"旧路径没被碰"的强证据（后端契约：不带
 *    cursor → 响应逐字节不变，连 nextCursor 都不出现）。
 *    注意：`tasksApi.list` 层还有一道 `taskListRequestConfig` 的显式键构造
 *    保证（见 api/tasks.ts），两道一起才叫"代码保证"。
 *
 * ② **`undefined` ≠ `''`**：关闭 = 键不出现（OFFSET）；开启 = 空串（`?cursor=`，
 *    keyset 起点）。前端一旦用 `cursor ?? ''` 或 `if (cursor)` 归一，keyset
 *    起点就永远进不去（表现为"开了开关但一直在第一页"，且**不报错**）。
 *
 * ③ **游标原样回传**：第二页必须带上一页响应里的 `nextCursor`，逐字节相同。
 *    游标不透明，前端不得解析/截断/重新编码。夹具刻意用真实形状的 base64url
 *    串（解出来是 `<ISO>|<uuid>`），以防将来有人"顺手"去 parse 它。
 *
 * ④ **重置时机（本页有 6 个 URL 同步字段与即时应用筛选）**：任何改变结果集的
 *    入口（q/status/trigger/lastStatus/清除筛选/pageSize）都必须重置游标栈。
 *    带着旧筛选的游标继续翻，后端把游标条件与过滤器取交集，返回"从某条不相干
 *    的行往后"的错乱内容——不报错、不空白，只是数据错了。
 *
 * ⑤ **URL→state 深链也必须重置游标栈（本页独有重点）**。深链（`/tasks?status=
 *    paused`）会让筛选变但游标**不在 URL 里**（不透明令牌不该进地址栏）。
 *    若 URL→state 的 setter 不重置栈，keyset 模式下载第 3 页的游标会带着新
 *    筛选继续请求 → 错乱数据。这条只能用**真实路由导航**复现（同组件内点按钮
 *    改 state 一直是好的）。
 *
 * ⑥ **lastStatus + keyset 不发会 400 的请求（本页独有的后端硬约束）**。
 *    `task.service.ts` 的 `assertCursorCompatibleWithQuery` 规定 cursor 与
 *    lastStatus 同时出现 → 400 VALIDATION_FAILED。故本页在 keyset 模式下：
 *    · 「最近执行」下拉被禁用（含可见原因 Tooltip 与提示文案）；
 *    · **更关键**：请求里 lastStatus 恒为 undefined（代码保证，而不是只靠 UI
 *      禁用——UI 禁用挡不住 URL 深链这类绕过路径）。
 *    `sortBy` 同理被后端拒绝，但本页无排序 UI（名称列的 sorter 是纯客户端
 *    排序，不发 sortBy/sortOrder），故不存在该组合。
 *
 * ⑦ **末页**：`nextCursor: null` →「下一页」禁用且点击不发请求。
 *
 * ⑧ **keyset 下没有页码器**：保留页码会让用户点「第 5 页」其实还在第 2 页。
 *
 * 隔离方式对齐 executions-keyset-paging.test.tsx 先例：mock `api/tasks`，
 * 断言读 `useTasksList` / `tasksApi.list` 的参数对象；路由用真实 MemoryRouter
 * （深链用例必需）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TaskListPage from '../pages/TaskListPage';
import { tasksApi, type Task } from '../api/tasks';
import { useAuthStore } from '../store/auth';

// 页面经 useTasksList → tasksApi.list 取数。只 mock 这个模块里的 tasksApi，
// 保留其余导出（summarizeBatch 等被页面直接调用）。
vi.mock('../api/tasks', async () => {
  const actual = await vi.importActual<typeof import('../api/tasks')>('../api/tasks');
  return {
    ...actual,
    tasksApi: {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      clone: vi.fn(),
      trigger: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      batchTrigger: vi.fn(),
      batchPause: vi.fn(),
      batchResume: vi.fn(),
      batchDelete: vi.fn(),
    },
  };
});
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
    removeEventListener: () => {},
    addEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/**
 * 真实形状的游标夹具（不透明令牌）。
 *
 * 值是把 `<ISO 8601 微秒>|<uuid>` 做 base64url 得来的，与后端
 * `encodeKeysetCursor` 同构——刻意如此：若有人在前端悄悄解析游标、或按别的
 * 形状去校验它，这些串会立刻暴露问题。前端只该原样搬运。
 */
const CURSOR_PAGE_2 = 'MjAyNi0wOS0wN1QxMDowMDowMC4xMjM0NTZafGEzZjFjMmQ0LWU1YjYtNDc4OS04YTFhLTFjMmQzZTRmNWc2aA';
const CURSOR_PAGE_3 = 'MjAyNi0wOS0wN1QwOTowMDowMC42NTQzMjFafGI3ZTJkM2M0LWY2YTctNDg5MC05YjJiLTJkM2U0ZjVhNmI3Yw';

const makeTask = (id: string, name: string, status = 'active'): Task => ({
  id,
  name,
  runtime: 'python',
  entrypoint: 'main.py',
  status,
  triggerType: 'manual',
  maxRetry: 0,
  timeout: 60,
  createdAt: '2026-09-07T10:00:00Z',
  updatedAt: '2026-09-07T10:00:00Z',
});

/**
 * OFFSET 路径的响应：**没有** `nextCursor` 键（后端逐字节不变的旧响应形态）。
 * 刻意不写 `nextCursor: undefined`——要复刻"键不存在"的真实形状。
 *
 * 三行**名字各不相同**：`findByText` 不能撞多命中（否则是"测试自己坏了"而不是
 * 契约坏了）。
 */
const offsetFixture = (total = 3) => ({
  items: [
    makeTask('t-1', '每日备份'),
    makeTask('t-2', '报表导出'),
    makeTask('t-3', '日志清理'),
  ],
  total,
  page: 1,
  pageSize: 20,
});

/** keyset 路径的响应：键必然存在，`null` = 末页。 */
const keysetFixture = (name: string, nextCursor: string | null, total = 200) => ({
  items: [makeTask(`t-${name}`, name)],
  total,
  page: 1,
  pageSize: 20,
  nextCursor,
});

// useAuthStore：本页写操作按钮依赖 role（筛选用例不涉及，但保持与真实环境一致）
useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });

/**
 * 外部导航触发器：模拟通知铃铛 / Dashboard 的深链。
 * 与页面同级渲染（不在页面内部），点击即 push 一个新 URL——这正是
 * 「组件已挂载时 URL 变化」的现场（深链用例的核心手法，见
 * executions-deeplink.test.tsx）。
 */
function ExternalNav() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate('/tasks?status=paused')}>
        goto-status-deeplink
      </button>
      <button type="button" onClick={() => navigate('/tasks?lastStatus=failed')}>
        goto-laststatus-deeplink
      </button>
    </>
  );
}

function renderPage(initialUrl = '/tasks') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialUrl]}>
        <ExternalNav />
        <Routes>
          <Route path="/tasks" element={<TaskListPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 最后一次 `tasksApi.list` 的参数对象（页面调 hook → hook 调 api）。 */
const lastParams = (): Record<string, unknown> =>
  (mockedTasks.list.mock.calls[mockedTasks.list.mock.calls.length - 1]?.[0] ?? {}) as Record<
    string,
    unknown
  >;

/** 列表请求次数（判定"点击禁用按钮没发请求"用）。 */
const listCallCount = (): number => mockedTasks.list.mock.calls.length;

/** antd 双汉字按钮自动插空格，textContent 归一化后再匹配（既有先例） */
const findBtn = (root: ParentNode, text: string): HTMLButtonElement | null =>
  (Array.from(root.querySelectorAll('button')) as HTMLButtonElement[]).find(
    (b) => (b.textContent ?? '').replace(/\s/g, '') === text,
  ) ?? null;

/**
 * 自绘分页器按钮。
 *
 * 用 `textContent.includes` 而不是等值匹配：「下一页」按钮的标签与
 * `<RightOutlined />` 相邻（无 `Split` 时两者之间不会插空格），等值匹配会因
 * 图标空白而漏掉。`includes` 对「上一页 / 下一页」这两个互不为子串的词仍是精确的。
 */
const pagerBtn = (label: '上一页' | '下一页'): HTMLButtonElement => {
  const btn = (Array.from(document.querySelectorAll('button')) as HTMLButtonElement[]).find(
    (b) => (b.textContent ?? '').replace(/\s/g, '').includes(label),
  );
  expect(btn, `未找到分页按钮：${label}`).toBeTruthy();
  return btn!;
};

/**
 * 无状态的假后端：**响应只由请求的 cursor 决定**。
 *
 * 为什么不用 `mockResolvedValueOnce` 序列：本页有多个请求源（初始挂载、开关
 * 切换、翻页、筛选重查、URL 回写），"第 N 次调用返回第 N 个值"的序列会与真实
 * 调用次数错位——测试就变成在赌内部执行顺序，红/绿都不代表行为。纯函数式
 * mock 让每一页的语义一目了然，也让"上一页重发旧游标"这类断言真正检验栈。
 *
 * 页 → 游标映射（与后端约定一致：响应里的 nextCursor 是**进入下一页**的令牌）：
 *   ''（起点）    → 本页 CURSOR_PAGE_2
 *   CURSOR_PAGE_2 → 本页 CURSOR_PAGE_3
 *   CURSOR_PAGE_3 → 末页（nextCursor: null）
 *   其他          → 末页（null），代表"游标行已被删"时的安全提前结束
 */
function installFakeBackend() {
  mockedTasks.list.mockImplementation((async (params?: Record<string, unknown>) => {
    // 键不存在（OFFSET 路径）与空串（keyset 起点）必须区别对待——这正是 ② 的
    // 被测语义。前者返回**没有 nextCursor 键**的旧响应形状。
    if (!params || !('cursor' in params)) return offsetFixture() as never;
    const cursor = String(params.cursor ?? '');
    const nextByCursor: Record<string, string | null> = {
      '': CURSOR_PAGE_2,
      [CURSOR_PAGE_2]: CURSOR_PAGE_3,
      [CURSOR_PAGE_3]: null,
    };
    const nextCursor = cursor in nextByCursor ? nextByCursor[cursor]! : null;
    return keysetFixture(cursor === '' ? '第一页' : cursor === CURSOR_PAGE_2 ? '第二页' : '第三页', nextCursor) as never;
  }) as never);
}

/** 打开「稳定翻页」开关（antd Switch 渲染成 role="switch" 的 button）。
 *
 * ⚠️ 不能用 `getByRole('switch')` 兜底定位：本页每行「启用」列也是一个 Switch
 * （同一 role），全页会有 N+1 个。稳定翻页开关是**唯一**带 `aria-label` 且
 * 文案含「稳定翻页」的那个，故按可访问名精确取——顺带钉住它的可访问名。
 */
async function enableStablePaging() {
  const sw = await screen.findByRole('switch', { name: /稳定翻页/ });
  fireEvent.click(sw);
  // 切换会把游标栈重置成 keyset 起点并重取一次
  await waitFor(() => {
    const p = lastParams();
    expect('cursor' in p).toBe(true);
    expect(p.cursor).toBe('');
  });
}

/**
 * 切到一个下拉选项。
 *
 * antd Select 在 jsdom 下的既有驱动方式（audit-keyset-paging 先例）：
 * mouseDown 打开 → findByText 选中 option 内容 → click。
 *
 * 定位占位符时**先按 `.ant-select-placeholder` 过滤**（executor-packages-keyset
 * 先例）：本页的「状态」「触发方式」既是筛选占位符也是表格列标题，`getByText`
 * 会撞到两个元素而炸掉——那是测试自身的问题，不是契约的问题。
 */
async function selectOption(placeholderText: string, optionText: string) {
  const placeholder = screen
    .getAllByText(placeholderText)
    .find((el) => (el as HTMLElement).classList?.contains('ant-select-placeholder'));
  expect(placeholder, `未找到筛选占位符：${placeholderText}`).toBeTruthy();
  fireEvent.mouseDown(placeholder!);
  const option = await screen.findByText(optionText, { selector: '.ant-select-item-option-content' });
  fireEvent.click(option);
}

beforeEach(() => {
  mockedTasks.list.mockReset();
  mockedTasks.list.mockResolvedValue(offsetFixture() as never);
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
});
afterEach(() => cleanup());

// ── ① 默认路径零风险 ─────────────────────────────────────────────────────

describe('TaskListPage keyset 分页：默认路径零风险', () => {
  it('开关默认关闭，且请求里**不存在** cursor 键（旧 OFFSET 路径逐字节不变）', async () => {
    renderPage();
    await screen.findByText('每日备份');

    const p = lastParams();
    // 核心断言：键**根本不存在**。`p.cursor === undefined` 无法区分"键不存在"
    // 与"键存在且为 undefined"，前者才是"我们没碰旧路径"的强证据。
    expect('cursor' in p).toBe(false);
    expect(p.page).toBe(1);
    expect(p.pageSize).toBe(20);

    // 默认模式下不渲染自绘分页器，antd 页码器仍在（旧形态）
    expect(findBtn(document.body, '上一页')).toBeNull();
    expect(findBtn(document.body, '下一页')).toBeNull();
    expect(document.querySelector('.ant-pagination')).toBeTruthy();
  });

  it('开关具备可访问名（aria-label），且是原生 button → Tab 可聚焦、Space/Enter 可切换', async () => {
    renderPage();
    await screen.findByText('每日备份');

    // 每行「启用」列也是 role="switch"，故按可访问名精确定位稳定翻页开关
    // （这也顺带证明它有唯一可辨识的可访问名，读屏用户不会听到 N 个无名 switch）。
    const sw = screen.getByRole('switch', { name: '稳定翻页（游标分页，深翻页不受数据变动影响）' });
    expect(sw.getAttribute('aria-label')).toBe('稳定翻页（游标分页，深翻页不受数据变动影响）');
    expect(sw.getAttribute('aria-checked')).toBe('false');
    // antd Switch 渲染为 <button role="switch">：原生按钮语义自带键盘可达性
    // （Tab 聚焦 + Space/Enter 激活），无需补 keydown 处理。这里把这条依赖
    // 钉住——若哪天换成 div 实现，键盘用户会静默失去这个入口。
    expect(sw.tagName).toBe('BUTTON');
    expect((sw as HTMLButtonElement).disabled).toBe(false);
  });

  it('开关关回去 → 请求里 cursor 键重新消失（两种模式互不污染）', async () => {
    installFakeBackend();
    renderPage();
    await screen.findByText('每日备份');

    await enableStablePaging();
    expect('cursor' in lastParams()).toBe(true);

    fireEvent.click(screen.getByRole('switch', { name: /稳定翻页/ }));
    await waitFor(() => {
      expect('cursor' in lastParams()).toBe(false);
    });
    // 页码器恢复（OFFSET 形态原样）
    expect(document.querySelector('.ant-pagination')).toBeTruthy();
  });
});

// ── ②③ 起点与下一页 ─────────────────────────────────────────────────────

describe('TaskListPage keyset 分页：起点与下一页', () => {
  it('打开开关 → 第一页带 cursor=""（空串 = keyset 起点，不是"不带参数"）', async () => {
    installFakeBackend();
    renderPage();
    await screen.findByText('每日备份');

    await enableStablePaging();

    const p = lastParams();
    expect('cursor' in p).toBe(true);
    // 必须是空串：若实现把它归一成"不带参数"，后端会走 OFFSET 分支，
    // keyset 模式就静默失效了（用户只会看到"开关没效果"）。
    expect(p.cursor).toBe('');
    expect(p.cursor).not.toBeUndefined();
  });

  it('第二页 → 带上一页响应里的 nextCursor（原样回传，不解析）', async () => {
    installFakeBackend();
    renderPage();
    await screen.findByText('每日备份');
    await enableStablePaging();

    // 必须等 keyset 模式**首屏响应落地**再点：`nextCursor` 从 data 派生，
    // 首屏 data 到达前按钮是禁用的（点一个禁用按钮什么都不会发生）。
    await waitFor(() => expect(pagerBtn('下一页').disabled).toBe(false));
    fireEvent.click(pagerBtn('下一页'));

    await waitFor(() => {
      expect(lastParams().cursor).toBe(CURSOR_PAGE_2);
    });
    // 不透明令牌：客户端不得加工（截断/解码/拼接），必须是逐字节相同的那串。
    expect(lastParams().cursor).not.toBe('');
    expect(lastParams().cursor).toBe(CURSOR_PAGE_2);
  });

  it('后端返回 nextCursor: null → 「下一页」禁用（且点击不发请求）', async () => {
    installFakeBackend();
    renderPage();
    await screen.findByText('每日备份');
    await enableStablePaging();

    // 走到末页：起点 → 页2 → 页3（页3 的 nextCursor 为 null）
    await waitFor(() => expect(pagerBtn('下一页').disabled).toBe(false));
    fireEvent.click(pagerBtn('下一页'));
    await waitFor(() => expect(lastParams().cursor).toBe(CURSOR_PAGE_2));
    await waitFor(() => expect(pagerBtn('下一页').disabled).toBe(false));
    fireEvent.click(pagerBtn('下一页'));
    await waitFor(() => expect(lastParams().cursor).toBe(CURSOR_PAGE_3));

    await waitFor(() => expect(pagerBtn('下一页').disabled).toBe(true));

    const callsBefore = listCallCount();
    fireEvent.click(pagerBtn('下一页'));
    // 禁用按钮点击不应产生"翻到不存在的下一页"的请求
    await new Promise((r) => setTimeout(r, 30));
    expect(listCallCount()).toBe(callsBefore);
  });

  it('上一页 → 回到栈中前一页的游标（栈首额外禁用）', async () => {
    installFakeBackend();
    renderPage();
    await screen.findByText('每日备份');
    await enableStablePaging();

    // 每步都等新数据落地（按钮可用 = nextCursor 已到），否则第二下点的是
    // 上一页残留的令牌。
    await waitFor(() => expect(pagerBtn('下一页').disabled).toBe(false));
    expect(pagerBtn('上一页').disabled).toBe(true); // 栈首禁用
    fireEvent.click(pagerBtn('下一页'));
    await waitFor(() => expect(lastParams().cursor).toBe(CURSOR_PAGE_2));

    await waitFor(() => expect(pagerBtn('下一页').disabled).toBe(false));
    fireEvent.click(pagerBtn('下一页'));
    await waitFor(() => expect(lastParams().cursor).toBe(CURSOR_PAGE_3));

    // 回退一格 → 必须重新发出"CURSOR_PAGE_2"（栈里存的就是当初那一页的游标）
    fireEvent.click(pagerBtn('上一页'));
    await waitFor(() => expect(lastParams().cursor).toBe(CURSOR_PAGE_2));

    // 再退到栈首 → 回到空串起点，且上一页重新禁用
    fireEvent.click(pagerBtn('上一页'));
    await waitFor(() => expect(lastParams().cursor).toBe(''));
    expect(pagerBtn('上一页').disabled).toBe(true);
  });

  it('keyset 模式下不渲染页码器（不给出"点第 5 页其实在第 2 页"的骗人页码）', async () => {
    // total 故意给 200 → 旧 OFFSET 模式下 antd 会据此渲染出 10 个页码
    mockedTasks.list.mockResolvedValue(keysetFixture('第一页', CURSOR_PAGE_2, 200) as never);
    renderPage();
    await screen.findByText('第一页');

    // OFFSET 模式下确实有页码器（对照）
    expect(document.querySelector('.ant-pagination')).toBeTruthy();

    await enableStablePaging();

    // keyset 模式：页码器整体消失，只剩自绘的两个按钮
    expect(document.querySelector('.ant-pagination')).toBeNull();
    expect(pagerBtn('上一页')).toBeTruthy();
    expect(pagerBtn('下一页')).toBeTruthy();
  });
});

// ── ④ 结果集变化 → 游标重置（即时应用筛选） ────────────────────────────

describe('TaskListPage keyset 分页：游标必须在结果集变化时重置', () => {
  /**
   * 先造出一个非空游标（翻到第 2 页），再触发某个"改变结果集"的入口，
   * 最后断言下一次请求带的是 keyset 起点（空串）而不是旧游标。
   */
  async function gotoPageTwo() {
    installFakeBackend();
    renderPage();
    await screen.findByText('每日备份');
    await enableStablePaging();
    await waitFor(() => expect(pagerBtn('下一页').disabled).toBe(false));
    fireEvent.click(pagerBtn('下一页'));
    await waitFor(() => expect(lastParams().cursor).toBe(CURSOR_PAGE_2));
  }

  it('关键词搜索（q）→ 游标重置（下一次请求带空串而非旧游标）', async () => {
    await gotoPageTwo();

    fireEvent.change(screen.getByPlaceholderText('搜索任务名、描述'), {
      target: { value: '对象存储' },
    });

    // 防抖 300ms
    await waitFor(
      () => {
        const p = lastParams();
        expect(p.q).toBe('对象存储');
        // 关键：不是 CURSOR_PAGE_2（带着旧筛选的游标继续翻 = 错乱数据）
        expect(p.cursor).not.toBe(CURSOR_PAGE_2);
        expect(p.cursor).toBe('');
      },
      { timeout: 3000 },
    );
  });

  it('状态筛选 → 游标重置', async () => {
    await gotoPageTwo();

    await selectOption('全部状态', '已暂停');

    await waitFor(() => {
      const p = lastParams();
      expect(p.status).toBe('paused');
      expect(p.cursor).toBe('');
    });
  });

  it('触发方式筛选 → 游标重置', async () => {
    await gotoPageTwo();

    // 选项文案取自 taskList.trigger.*：manual=手动 / cron=Cron / fixed_rate=定时。
    // 用「定时」（fixed_rate）而不是「Cron」——后者是纯 ASCII，与本页其它文本
    // 不易撞，但「定时」更能代表三个选项里的中文本地化路径。
    await selectOption('触发方式', '定时');

    await waitFor(() => {
      const p = lastParams();
      expect(p.triggerType).toBe('fixed_rate');
      expect(p.cursor).toBe('');
    });
  });

  it('「清除筛选」→ 游标重置回 keyset 起点（仍是 keyset 模式，故是空串而非无键）', async () => {
    await gotoPageTwo();

    // 先应用一个筛选，让「清除筛选」按钮出现
    fireEvent.change(screen.getByPlaceholderText('搜索任务名、描述'), {
      target: { value: '备份' },
    });
    await waitFor(() => expect(findBtn(document.body, '清除筛选')).toBeTruthy());
    // 搜索已把栈重置，需要重新造出非空游标
    await waitFor(() => expect(pagerBtn('下一页').disabled).toBe(false));
    fireEvent.click(pagerBtn('下一页'));
    await waitFor(() => expect(lastParams().cursor).toBe(CURSOR_PAGE_2));

    fireEvent.click(findBtn(document.body, '清除筛选')!);

    await waitFor(() => {
      const p = lastParams();
      expect(p.q).toBeUndefined();
      // 清除后仍是 keyset 模式（开关没关），故是空串起点而不是"不带 cursor"
      expect('cursor' in p).toBe(true);
      expect(p.cursor).toBe('');
    });
  });
});

// ── ⑤ URL→state 深链（本页独有重点） ──────────────────────────────────

describe('TaskListPage keyset 分页：URL→state 深链改筛选也必须重置游标', () => {
  /**
   * 缺陷现场（ExecutionsPage 那一轮的同型问题）：
   * 深链让筛选变，但游标**不在 URL 里**。若 URL→state 的 setter 不清栈，
   * keyset 模式下载第 2 页的游标会带着新筛选继续请求——后端把游标条件与过滤器
   * 取交集，返回"从旧筛选某个不相干位置往后"的数据：不报错、不空白，只是错了。
   *
   * 这条**必须**用真实路由导航复现：同组件内点按钮改 state 一直是好的，只有
   * 外部导航才暴露 URL→state 方向的问题。
   */
  async function gotoPageTwoViaKeyset() {
    installFakeBackend();
    renderPage();
    await screen.findByText('每日备份');
    await enableStablePaging();
    await waitFor(() => expect(pagerBtn('下一页').disabled).toBe(false));
    fireEvent.click(pagerBtn('下一页'));
    await waitFor(() => expect(lastParams().cursor).toBe(CURSOR_PAGE_2));
  }

  it('已挂载时外部导航到 ?status=paused → 筛选生效**且**游标重置为空串', async () => {
    await gotoPageTwoViaKeyset();

    fireEvent.click(screen.getByText('goto-status-deeplink'));

    await waitFor(() => {
      const p = lastParams();
      expect(p.status).toBe('paused');
      // 核心断言：**不能**是 CURSOR_PAGE_2。修复缺失时这里会看到旧游标 +
      // 新筛选的组合，正是"结果集错乱但不报错"的形态。
      expect(p.cursor).not.toBe(CURSOR_PAGE_2);
      expect(p.cursor).toBe('');
    });
  });

  it('已挂载时外部导航改 URL 的筛选不会被回写抹掉（深链真的生效）', async () => {
    await gotoPageTwoViaKeyset();

    fireEvent.click(screen.getByText('goto-status-deeplink'));
    await waitFor(() => expect(lastParams().status).toBe('paused'));

    // 回写是 replace 语义：若 state 没跟上，URL 会被清回裸 /tasks，
    // 后续所有请求又会变回无筛选——这里再等一拍仍应是 paused。
    await new Promise((r) => setTimeout(r, 50));
    expect(lastParams().status).toBe('paused');
    expect(lastParams().cursor).toBe('');
  });
});

// ── ⑥ lastStatus + keyset 不发会 400 的请求（本页独有硬约束） ──────────

describe('TaskListPage keyset 分页：与 lastStatus 的后端互斥（cursor+lastStatus = 400）', () => {
  /**
   * 后端判据（admin-api/task.service.ts 的 assertCursorCompatibleWithQuery）：
   * 请求同时带 cursor 与 lastStatus → AppError VALIDATION_FAILED（HTTP 400）。
   *
   * 本页的处置：keyset 模式下 **请求里 lastStatus 恒为 undefined**（代码保证），
   * 且「最近执行」下拉被禁用 + 给可见说明（不让人选完再吃 400）。两条都要钉。
   */
  it('keyset 模式下即使 URL 深链带了 ?lastStatus=failed，请求也不含 lastStatus（代码保证，不靠 UI 禁用）', async () => {
    installFakeBackend();
    renderPage();
    await screen.findByText('每日备份');
    await enableStablePaging();

    // 打开开关后再走外部深链：等价于"用户先开了稳定翻页，然后从通知里点了一个
    // 带 lastStatus 的链接"。UI 禁用挡不住这条路径，只有请求层保证挡得住。
    fireEvent.click(screen.getByText('goto-laststatus-deeplink'));

    await waitFor(() => {
      const p = lastParams();
      // 这一条才是"不会 400"的真正证明
      expect(p.lastStatus).toBeUndefined();
      expect('cursor' in p).toBe(true);
    });

    // 再等一拍：确保不是"某一帧碰巧还没带上"的假绿
    await new Promise((r) => setTimeout(r, 50));
    const p = lastParams();
    expect(p.lastStatus).toBeUndefined();
    expect(p.cursor).toBe('');
  });

  it('keyset 开启时「最近执行」下拉被禁用，并给出可见原因（不让用户选完再吃 400）', async () => {
    installFakeBackend();
    renderPage();
    await screen.findByText('每日备份');

    // 关闭时可用（既有能力不变）：三个筛选 Select 都没有 disabled 态
    expect(document.querySelectorAll('.ant-select-disabled').length).toBe(0);

    await enableStablePaging();

    // 被禁用：antd 给 Select 外层加 .ant-select-disabled。
    // 本页恰好只有一个 Select 会在 keyset 下被禁用（「最近执行」），故数量断言
    // 同时钉住"没有误伤状态/触发方式两个筛选"。
    await waitFor(() => {
      expect(document.querySelectorAll('.ant-select-disabled').length).toBe(1);
    });
    // 被禁用的那个确实是「最近执行」：它的占位符文本在里面
    const disabled = document.querySelector('.ant-select-disabled') as HTMLElement;
    expect(disabled.textContent).toContain('最近执行');

    // 禁用原因必须是**常驻可见文本**，而不是只挂 Tooltip：Tooltip 需要悬停，
    // 键盘/读屏用户拿不到，等于把"后端不支持这个组合"的事实藏起来。
    const note = screen.getByTestId('tasklist-laststatus-disabled-note');
    expect(note.textContent).toContain('不能按最近执行状态筛选');
    // 有可见说明时不再叠一条"筛选已失效"（后者只在确实选过值时出现）
    expect(screen.queryByTestId('tasklist-laststatus-ignored')).toBeNull();
    // 说明与被禁用的控件建立程序化关联（读屏会在焦点落在控件时读出来）
    expect(disabled.querySelector('[aria-describedby="tasklist-laststatus-note"]')).toBeTruthy();
  });

  it('关闭开关后 lastStatus 重新可以透传（两种模式互不污染）', async () => {
    installFakeBackend();
    renderPage('/tasks?lastStatus=failed');
    await waitFor(() => expect(lastParams().lastStatus).toBe('failed'));

    // 开着已选 lastStatus 再点开关：keyset 打开后 lastStatus 必须消失
    await enableStablePaging();
    expect(lastParams().lastStatus).toBeUndefined();

    // 关回去 → lastStatus 恢复透传（原行为逐字节回来）
    fireEvent.click(screen.getByRole('switch', { name: /稳定翻页/ }));
    await waitFor(() => {
      const p = lastParams();
      expect('cursor' in p).toBe(false);
      expect(p.lastStatus).toBe('failed');
    });
  });

  it('已选 lastStatus 时开稳定翻页 → 页内显式提示该筛选已失效（不静默混数据）', async () => {
    installFakeBackend();
    renderPage('/tasks?lastStatus=failed');
    await waitFor(() => expect(lastParams().lastStatus).toBe('failed'));

    await enableStablePaging();

    expect(screen.getByTestId('tasklist-laststatus-ignored')).toBeTruthy();
  });
});

// ── pageSize 变更（本页有 size changer，是真会走到的路径） ──────────────

describe('TaskListPage keyset 分页：pageSize 入口在 keyset 下不存在（杜绝"旧游标 + 新页大小"）', () => {
  it('OFFSET 模式有 size changer；keyset 模式页码器整体消失 → 没有改 pageSize 的入口', async () => {
    mockedTasks.list.mockResolvedValue(keysetFixture('第一页', CURSOR_PAGE_2, 200) as never);
    renderPage();
    await screen.findByText('第一页');

    // OFFSET 模式：分页器在，且请求不带 cursor（旧路径不受影响）
    expect(document.querySelector('.ant-pagination')).toBeTruthy();
    expect('cursor' in lastParams()).toBe(false);

    await enableStablePaging();
    // keyset 模式：分页器整体消失 → 不存在改 pageSize 的入口，
    // 故不可能出现"旧游标配新页大小"的切片错位。
    expect(document.querySelector('.ant-pagination')).toBeNull();
  });
});
