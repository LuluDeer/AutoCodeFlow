/**
 * §2.1（PLAN-BACKEND-ARCHITECTURE 游标分页推广）AuditLogPage 消费 keyset
 * `nextCursor` 的前端契约。
 *
 * ## 为什么单开一个文件而不并进 audit-page.test.tsx
 * 那份是 QA-03 的页面功能面（渲染/筛选/导出/空态），本份只钉**分页契约**：
 * 旧路径是否真的没被碰、游标的三种形态是否在状态层就分开、栈的回退是否真
 * 回退到"当初那一页的令牌"。混在一起会让"哪条断言的失败代表契约被破坏"
 * 变得不可读。
 *
 * ## 本轮要守住的六件事（每件都由一条用例钉死）
 *
 * ① **默认零风险**：开关关闭时**请求 URL 里不存在** `cursor` 这个键。这是
 *    "旧路径没被碰到"的唯一可执行证据——后端契约规定不带 cursor → 响应
 *    逐字节不变（连 nextCursor 都不出现），故只要请求侧不带它，行为就必然
 *    与改动前一致。断言打在**真实请求 URL** 上（用 `URLSearchParams.has`），
 *    而不是断言某个对象里字段是 undefined：前者才是 axios 真的会发出去的东西。
 *
 * ② **`undefined` ≠ `''`**：`undefined` → 键不出现（OFFSET 路径）；空串 →
 *    `?cursor=`（keyset 起点）。前端一旦用 `cursor ?? ''` 或 `if (cursor)`
 *    归一，keyset 起点就永远进不去（表现为"开了开关但一直在第一页"）。
 *
 * ③ **游标原样回传**：第二页必须带上一页响应里的 `nextCursor`，逐字节相同。
 *    游标不透明（`audit_logs.id` 是 integer，编码里是数字段），前端不得解析/
 *    截断/重新编码。夹具刻意用**真实形状**的 base64url 串（解出来是
 *    `<ISO>|<数字 id>`），以防将来有人"顺手"去 parse 它。
 *
 * ④ **重置时机**：本页筛选是「草稿 pending → 点搜索才应用 filters」两段式，
 *    故重置点落在**应用**的瞬间（搜索 / 重置按钮）；另加 pageSize 变更。
 *    带着旧筛选的游标继续翻，后端的游标条件与过滤器取交集后会返回"从某条
 *    不相干的行往后"的错乱结果——不报错、不空白，只是内容错了，这是最难被
 *    发现的缺陷形态，故必须有断言。
 *
 * ⑤ **末页**：`nextCursor: null`（后端明确说没下一页，含"游标行被 180 天
 *    retention 删掉"的提前结束）→「下一页」禁用且点击不发请求。
 *
 * ⑥ **keyset 下没有页码器**：保留页码会让用户点「第 5 页」其实还在第 2 页。
 *
 * 隔离方式对齐 audit-page.test.tsx 先例：mock `api/client`（页面走
 * `listAuditLogs` → `client.get`），断言直接读真实请求 URL。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import AuditLogPage from '../pages/audit';
import { client } from '../api/client';

vi.mock('../api/client', () => ({
  client: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
const mockedClient = vi.mocked(client, true);

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
 * 值是把 `<ISO 8601 微秒>|<十进制 id>` 做 base64url 得来的，与后端
 * `encodeNumericKeysetCursor` 的一致——刻意如此：若有人在前端悄悄解析游标、
 * 或按 uuid 形状去校验它，这些串会立刻暴露问题。前端只该原样搬运。
 */
const CURSOR_PAGE_2 = 'MjAyNi0wOS0wN1QxMDowMDowMC4xMjM0NTZafDQy';
const CURSOR_PAGE_3 = 'MjAyNi0wOS0wN1QwOTowMDowMC42NTQzMjFafDQx';

const makeLog = (id: number) => ({
  id,
  action: 'task.create',
  resource: 'task',
  resourceId: `res-${id}`,
  userId: 1,
  username: 'root',
  ip: '10.0.0.1',
  result: 'success',
  createdAt: '2026-09-07T10:00:00Z',
});

/** 三行**动作各不相同**的 OFFSET 夹具：`findByText` 不能撞多命中（否则是
 *  "测试自己坏了"而不是契约坏了——同一句断言会因元素重复而超时）。 */
const OFFSET_ACTIONS = ['task.create', 'config.update', 'executor.delete'];

/**
 * OFFSET 路径的响应：**没有** `nextCursor` 键（后端逐字节不变的旧响应形态）。
 * 刻意不写 `nextCursor: undefined`——要复刻"键不存在"的真实形状。
 */
const offsetFixture = (total = 3) => ({
  data: OFFSET_ACTIONS.map((action, i) => ({ ...makeLog(i + 1), action })),
  total,
});

/** keyset 路径的响应：键必然存在，`null` = 末页。 */
const keysetFixture = (nextCursor: string | null, total = 200) => ({
  data: [makeLog(1)],
  total,
  nextCursor,
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AuditLogPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 最近一次 /audit **列表**请求的 URL 查询参数（导出请求分开统计，勿混）。 */
function lastListParams(): URLSearchParams {
  const calls = mockedClient.get.mock.calls.filter(([url]) => {
    const u = String(url);
    // 导出端点前缀相同（/audit/export），必须先排除
    return u.startsWith('/audit?') || u === '/audit';
  });
  const url = String(calls[calls.length - 1]?.[0] ?? '');
  return new URL(url, 'http://localhost').searchParams;
}

/** 列表请求次数（判定"点击禁用按钮没发请求"用）。 */
const listCallCount = (): number =>
  mockedClient.get.mock.calls.filter(([url]) => {
    const u = String(url);
    return u.startsWith('/audit?') || u === '/audit';
  }).length;

/**
 * 无状态的假后端：**响应只由请求的 cursor 决定**。
 *
 * 为什么不用 `mockResolvedValueOnce` 序列：本页有多个请求源（初始挂载、开关
 * 切换、翻页、筛选重查），"第 N 次调用返回第 N 个值"的序列会与真实调用次数
 * 错位——测试就变成在赌内部执行顺序，红/绿都不代表行为。纯函数式 mock 让每
 * 一页的语义一目了然，也让"上一页重发旧游标"这类断言真正检验栈。
 *
 * 页 → 游标映射（与后端约定一致：响应里的 nextCursor 是**进入下一页**的令牌）：
 *   ''（起点）    → 本页 CURSOR_PAGE_2
 *   CURSOR_PAGE_2 → 本页 CURSOR_PAGE_3
 *   CURSOR_PAGE_3 → 末页（nextCursor: null）
 *   其他          → 末页（null），代表"游标行已被删"时的安全提前结束
 */
function installFakeBackend() {
  mockedClient.get.mockImplementation((async (url: unknown) => {
    const u = new URL(String(url), 'http://localhost');
    if (u.pathname === '/audit/export') return new Blob(['id\n'], { type: 'text/csv' });
    const cursor = u.searchParams.get('cursor');
    // `has` 而非 `get === null` 的差别在这里不重要（get 缺键返回 null），
    // 但语义上要读的是"这一页的游标是哪一个"。
    const key = cursor ?? '';
    const nextByCursor: Record<string, string | null> = {
      '': CURSOR_PAGE_2,
      [CURSOR_PAGE_2]: CURSOR_PAGE_3,
      [CURSOR_PAGE_3]: null,
    };
    const nextCursor = key in nextByCursor ? nextByCursor[key]! : null;
    return { data: [makeLog(1)], total: 200, ...(cursor === null ? {} : { nextCursor }) };
  }) as never);
}

/**
 * R67-A1：往 action 过滤器里自由输入关键词。
 *
 * 该过滤器已从 Input 换成 tags 模式 Select（选项来自 GET /audit/actions）：键入的
 * 文字要**回车**才成为一个 tag（= 一个过滤值）。本套件里 /audit/actions 与 /audit
 * 共用一个 {data,total} 桩，故清单为空 → 下拉不展开 → 回车走"提交自由文本"路径，
 * 与改造前的行为等价（这也是"下拉失败仍能筛"的兜底路径）。
 */
function typeActionKeyword(value: string) {
  // antd 6 的 Select 不再把 placeholder 放到 input 的 placeholder 属性上
  // （渲染成 .ant-select-placeholder 浮层，选中值后还会消失），故用「本页唯一的
  // 多选控件」做锚点：.ant-select-multiple 只属于 action 过滤器。
  const root = document.querySelector('.ant-select-multiple') as HTMLElement | null;
  expect(root, '未找到 action 过滤器（tags 模式 Select）').toBeTruthy();
  const input = root!.querySelector('input') as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13 });
}

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

/** 打开「稳定翻页」开关（antd Switch 渲染成 role="switch" 的 button）。 */
async function enableStablePaging() {
  const sw = await screen.findByRole('switch');
  fireEvent.click(sw);
  // 切换会把游标栈重置成 keyset 起点并重取一次
  await waitFor(() => {
    const p = lastListParams();
    expect(p.has('cursor')).toBe(true);
    expect(p.get('cursor')).toBe('');
  });
}

beforeEach(() => {
  mockedClient.get.mockReset();
  mockedClient.get.mockResolvedValue(offsetFixture() as never);
});
afterEach(() => cleanup());

describe('AuditLogPage keyset 分页：默认路径零风险', () => {
  it('开关默认关闭，且请求里**不存在** cursor 键（旧 OFFSET 路径逐字节不变）', async () => {
    renderPage();
    await screen.findByText('创建任务');

    const p = lastListParams();
    // 核心断言：键**根本不存在**。断言打在真实请求 URL 上——`p.get('cursor')`
    // 返回 null 只说明"读不到"，而 `has` 为 false 才是"发出去的东西里没有它"。
    expect(p.has('cursor')).toBe(false);
    expect(p.get('page')).toBe('1');
    expect(p.get('pageSize')).toBe('20');

    // 默认模式下不渲染自绘分页器，antd 页码器仍在（旧形态）
    expect(findBtn(document.body, '上一页')).toBeNull();
    expect(findBtn(document.body, '下一页')).toBeNull();
  });

  it('开关具备可访问名（aria-label），且是原生 button → Tab 可聚焦、Space/Enter 可切换', async () => {
    renderPage();
    await screen.findByText('创建任务');

    const sw = screen.getByRole('switch');
    expect(sw.getAttribute('aria-label')).toBe('稳定翻页（游标分页，深翻页不受数据变动影响）');
    expect(sw.getAttribute('aria-checked')).toBe('false');
    // antd Switch 渲染为 <button role="switch">：原生按钮语义自带键盘可达性
    // （Tab 聚焦 + Space/Enter 激活），无需补 keydown 处理。这里把这条依赖
    // 钉住——若哪天换成 div 实现，键盘用户会静默失去这个入口。
    expect(sw.tagName).toBe('BUTTON');
    expect((sw as HTMLButtonElement).disabled).toBe(false);
  });

  it('开关关回去 → 请求里 cursor 键重新消失（两种模式互不污染）', async () => {
    renderPage();
    await screen.findByText('创建任务');
    await enableStablePaging();
    expect(lastListParams().has('cursor')).toBe(true);

    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => {
      expect(lastListParams().has('cursor')).toBe(false);
    });
    // 页码器恢复（OFFSET 形态原样）
    expect(document.querySelector('.ant-pagination')).toBeTruthy();
  });
});

describe('AuditLogPage keyset 分页：起点与下一页', () => {
  it('打开开关 → 第一页带 cursor=""（空串 = keyset 起点，不是"不带参数"）', async () => {
    installFakeBackend();
    renderPage();
    await screen.findByText('创建任务');

    await enableStablePaging();

    const p = lastListParams();
    expect(p.has('cursor')).toBe(true);
    // 必须是空串：若实现把它归一成"不带参数"，后端会走 OFFSET 分支，
    // keyset 模式就静默失效了（用户只会看到"开关没效果"）。
    expect(p.get('cursor')).toBe('');
  });

  it('第二页 → 带上一页响应里的 nextCursor（原样回传，不解析）', async () => {
    installFakeBackend();
    renderPage();
    await screen.findByText('创建任务');
    await enableStablePaging();

    // 必须等 keyset 模式**首屏响应落地**再点：`nextCursor` 从 data 派生，
    // 在首屏 data 到达前按钮是禁用的（点一个禁用按钮什么都不会发生）。
    await waitFor(() => expect(pagerBtn('下一页').disabled).toBe(false));
    fireEvent.click(pagerBtn('下一页'));

    await waitFor(() => {
      expect(lastListParams().get('cursor')).toBe(CURSOR_PAGE_2);
    });
    // 不透明令牌：客户端不得加工（截断/解码/拼接），必须是逐字节相同的那串。
    // 顺带证明前端没有把它当 uuid 之类去"修正"形状（audit_logs.id 是 integer）。
    expect(lastListParams().get('cursor')).toBe(CURSOR_PAGE_2);
    expect(lastListParams().get('cursor')).not.toBe('');
  });

  it('后端返回 nextCursor: null → 「下一页」禁用（且点击不发请求）', async () => {
    // 末页：游标 CURSOR_PAGE_3 之后没有更多（也覆盖"游标行被删 → 空页"语义）
    installFakeBackend();
    renderPage();
    await screen.findByText('创建任务');
    await enableStablePaging();

    // 走到末页：起点 → 页2 → 页3（页3 的 nextCursor 为 null）
    await waitFor(() => expect(pagerBtn('下一页').disabled).toBe(false));
    fireEvent.click(pagerBtn('下一页'));
    await waitFor(() => expect(lastListParams().get('cursor')).toBe(CURSOR_PAGE_2));
    await waitFor(() => expect(pagerBtn('下一页').disabled).toBe(false));
    fireEvent.click(pagerBtn('下一页'));
    await waitFor(() => expect(lastListParams().get('cursor')).toBe(CURSOR_PAGE_3));

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
    await screen.findByText('创建任务');
    await enableStablePaging();

    // 进第 2 页（cursor=CURSOR_PAGE_2），再进第 3 页（cursor=CURSOR_PAGE_3）。
    // 每步都等新数据落地（按钮可用 = nextCursor 已到），否则第二下点的是
    // 上一页残留的令牌。
    await waitFor(() => expect(pagerBtn('下一页').disabled).toBe(false));
    expect(pagerBtn('上一页').disabled).toBe(true); // 栈首禁用
    fireEvent.click(pagerBtn('下一页'));
    await waitFor(() => expect(lastListParams().get('cursor')).toBe(CURSOR_PAGE_2));

    await waitFor(() => expect(pagerBtn('下一页').disabled).toBe(false));
    fireEvent.click(pagerBtn('下一页'));
    await waitFor(() => expect(lastListParams().get('cursor')).toBe(CURSOR_PAGE_3));

    // 回退一格 → 必须重新发出"CURSOR_PAGE_2"（栈里存的就是当初那一页的游标）
    fireEvent.click(pagerBtn('上一页'));
    await waitFor(() => expect(lastListParams().get('cursor')).toBe(CURSOR_PAGE_2));

    // 再退到栈首 → 回到空串起点，且上一页重新禁用
    fireEvent.click(pagerBtn('上一页'));
    await waitFor(() => expect(lastListParams().get('cursor')).toBe(''));
    expect(pagerBtn('上一页').disabled).toBe(true);
  });

  it('keyset 模式下不渲染页码器（不给出"点第 5 页其实在第 2 页"的骗人页码）', async () => {
    // total 故意给 200 → 旧 OFFSET 模式下 antd 会据此渲染出 10 个页码
    mockedClient.get.mockResolvedValue(keysetFixture(CURSOR_PAGE_2, 200) as never);
    renderPage();
    await screen.findByText('创建任务');

    // OFFSET 模式下确实有页码器（对照）
    expect(document.querySelector('.ant-pagination')).toBeTruthy();

    await enableStablePaging();

    // keyset 模式：页码器整体消失，只剩自绘的两个按钮
    expect(document.querySelector('.ant-pagination')).toBeNull();
    expect(pagerBtn('上一页')).toBeTruthy();
    expect(pagerBtn('下一页')).toBeTruthy();
  });
});

describe('AuditLogPage keyset 分页：游标必须在结果集变化时重置', () => {
  /**
   * 先造出一个非空游标（翻到第 2 页），再触发某个"改变结果集"的入口，
   * 最后断言下一次请求带的是 keyset 起点（空串）而不是旧游标。
   */
  async function gotoPageTwo() {
    installFakeBackend();
    renderPage();
    await screen.findByText('创建任务');
    await enableStablePaging();
    await waitFor(() => expect(pagerBtn('下一页').disabled).toBe(false));
    fireEvent.click(pagerBtn('下一页'));
    await waitFor(() => expect(lastListParams().get('cursor')).toBe(CURSOR_PAGE_2));
  }

  it('应用关键词筛选（点搜索）→ 游标重置（下一次请求带空串而非旧游标）', async () => {
    await gotoPageTwo();

    typeActionKeyword('task');
    fireEvent.click(findBtn(document.body, '搜索')!);

    await waitFor(() => {
      const p = lastListParams();
      expect(p.get('action')).toBe('task');
      // 关键：不是 CURSOR_PAGE_2（带着旧筛选的游标继续翻 = 错乱数据）
      expect(p.get('cursor')).not.toBe(CURSOR_PAGE_2);
      expect(p.get('cursor')).toBe('');
    });
  });

  it('应用操作人筛选（点搜索）→ 游标重置', async () => {
    await gotoPageTwo();

    fireEvent.change(screen.getByPlaceholderText('操作人'), { target: { value: 'root' } });
    fireEvent.click(findBtn(document.body, '搜索')!);

    await waitFor(() => {
      const p = lastListParams();
      expect(p.get('username')).toBe('root');
      expect(p.get('cursor')).toBe('');
    });
  });

  it('应用资源类型筛选（下拉 + 搜索）→ 游标重置', async () => {
    await gotoPageTwo();

    fireEvent.mouseDown(screen.getByText('资源类型'));
    const option = await screen.findByText('executor', { selector: '.ant-select-item-option-content' });
    fireEvent.click(option);
    fireEvent.click(findBtn(document.body, '搜索')!);

    await waitFor(() => {
      const p = lastListParams();
      expect(p.get('resource')).toBe('executor');
      expect(p.get('cursor')).toBe('');
    });
  });

  it('应用资源 ID 筛选（AUTH-05）→ 游标重置', async () => {
    await gotoPageTwo();

    fireEvent.change(screen.getByPlaceholderText('资源 ID'), { target: { value: 'e-42' } });
    fireEvent.click(findBtn(document.body, '搜索')!);

    await waitFor(() => {
      const p = lastListParams();
      expect(p.get('resourceId')).toBe('e-42');
      expect(p.get('cursor')).toBe('');
    });
  });

  it('应用执行结果筛选（成功/失败）→ 游标重置', async () => {
    await gotoPageTwo();

    fireEvent.mouseDown(screen.getByText('执行结果'));
    const option = await screen.findByText('失败', { selector: '.ant-select-item-option-content' });
    fireEvent.click(option);
    fireEvent.click(findBtn(document.body, '搜索')!);

    await waitFor(() => {
      const p = lastListParams();
      expect(p.get('result')).toBe('failure');
      expect(p.get('cursor')).toBe('');
    });
  });

  /**
   * 时间范围筛选是**唯一**没有真实交互用例的入口。
   *
   * 原因不是它被漏掉，而是 antd 6.6.5 的 RangePicker 在 jsdom 下无法被
   * fireEvent 驱动到 onChange（无真实指针/布局，rc-picker 的区间落定要等
   * 指针/焦点序列；click / mouseDown+mouseUp / mouseenter / 双面板格子 /
   * 键入+Enter 均已由 executions-keyset-paging.test.tsx 逐个试过并记录）。
   * 它的重置逻辑与上面四处是**同一个** `handleSearch` 里的同一次
   * `resetCursorStack(stablePaging)` 调用（时间范围同样先进 pending、点搜索才
   * 应用），故由上述用例代表该链路，而不是编一个点了不发请求的假断言。
   */

  it('「重置」按钮（handleReset）→ 游标重置回 keyset 起点', async () => {
    await gotoPageTwo();

    // 先应用一个筛选，让「重置」按钮出现
    typeActionKeyword('task');
    fireEvent.click(findBtn(document.body, '搜索')!);
    await waitFor(() => expect(findBtn(document.body, '重置')).toBeTruthy());
    // 重新翻到第 2 页（搜索已把栈重置，需要重新造出非空游标）
    await waitFor(() => expect(pagerBtn('下一页').disabled).toBe(false));
    fireEvent.click(pagerBtn('下一页'));
    await waitFor(() => expect(lastListParams().get('cursor')).toBe(CURSOR_PAGE_2));

    fireEvent.click(findBtn(document.body, '重置')!);

    await waitFor(() => {
      const p = lastListParams();
      expect(p.get('action')).toBeNull();
      // 清除后仍是 keyset 模式（开关没关），故是空串起点而不是"不带 cursor"
      expect(p.has('cursor')).toBe(true);
      expect(p.get('cursor')).toBe('');
    });
  });

  it('pageSize 变更 → 游标重置（keyset 下页大小变了，旧游标不再对应切片边界）', async () => {
    // 本页 pageSize 恒为 20 且无 size changer 入口，故这条只能在 OFFSET 模式
    // 下验证"重置被接上"，再验证 keyset 模式下**不存在**会改 pageSize 的入口
    // ——两条合起来证明 keyset 期间不会出现"旧游标 + 新页大小"。
    mockedClient.get.mockResolvedValue(offsetFixture(200) as never);
    renderPage();
    await screen.findByText('创建任务');

    // OFFSET 模式：分页器在，且它的请求不带 cursor（旧路径不受影响）
    expect(document.querySelector('.ant-pagination')).toBeTruthy();
    expect(lastListParams().has('cursor')).toBe(false);

    await enableStablePaging();
    // keyset 模式：分页器整体消失 → 不存在改 pageSize 的入口
    expect(document.querySelector('.ant-pagination')).toBeNull();
  });
});
