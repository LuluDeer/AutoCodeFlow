/**
 * LOG-JSON-01：日志查看器里的 JSON 载荷渲染（集成层）。
 *
 * 本文件钉住两条渲染路径的行为，重点是**窗口化安全**：
 *  ① `LogWindow`（>500 行窗口化）：JSON 行必须渲染成**一个固定高的 DOM 行**，
 *     撑高层高度仍等于「行数 × LOG_ROW_HEIGHT」——多行展开会让虚拟滚动的
 *     行号整除换算与滚动条长度同时失效；
 *  ② `ExecutionLogSection` 的 `<pre>` 路径（≤500 行）：JSON 行着色，但
 *     textContent 与原文**逐字符一致**（复制/下载不受影响）；
 *  ③ 关键词搜索时不叠加 JSON 着色（mark 高亮为唯一视觉层级）。
 *
 * 反证：把 LogWindow 的 JSON 分支改成多行缩进渲染 → ①② 立即变红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import LogWindow, {
  JsonPrettyPopover,
  LOG_ROW_HEIGHT,
} from '../components/LogWindow';
import ExecutionDetailPage from '../pages/ExecutionDetailPage';
import { tasksApi } from '../api/tasks';
import { JSON_KIND_TOKEN, jsonLineTokens } from '../utils/logLevel';

vi.mock('../api/tasks', () => ({
  tasksApi: {
    execution: vi.fn(),
    executionLogs: vi.fn(),
    killExecution: vi.fn(),
    trigger: vi.fn(),
    analyzeExecution: vi.fn(),
    get: vi.fn(),
    executions: vi.fn(),
  },
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

/** 构造 N 行日志，其中第 1 行是 JSON 载荷 */
const JSON_LINE = '2026-09-06 10:00:01 [INFO] {"trace":"abc","retry":2,"ok":true,"x":null}';
const makeText = (n = 600) =>
  [JSON_LINE, ...Array.from({ length: n - 1 }, (_, i) => `plain-${String(i).padStart(4, '0')}`)].join(
    '\n',
  );

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('LOG-JSON-01 LogWindow：JSON 行单行着色（窗口化安全）', () => {
  it('JSON 行渲染为一个固定高行，撑高层高度仍 = 行数 × 行高', () => {
    const text = makeText(600);
    const { container } = render(<LogWindow text={text} testId="log-window" />);

    // 撑高层：600 行 × 20px = 12000px（多行展开会破坏这个数值）
    const spacer = container.querySelector('div[style*="height: 12000px"], div[style*="height:12000px"]');
    expect(spacer, '撑高层高度不再是 行数×行高——窗口化已被破坏').toBeTruthy();

    // JSON 行的着色节点存在（键/数字/字面量档）
    expect(container.querySelectorAll('[data-json-kind="key"]').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('[data-json-kind="number"]').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('[data-json-kind="literal"]').length).toBeGreaterThan(0);

    // 该行仍只占一个固定高 DOM 行：着色节点全部落在同一个 20px 行容器内
    const rowOfKey = container.querySelector('[data-json-kind="key"]')!.closest('div[style*="height"]');
    expect(rowOfKey).toBeTruthy();
    const rowStyle = (rowOfKey as HTMLElement).getAttribute('style') ?? '';
    expect(rowStyle).toContain(`height: ${LOG_ROW_HEIGHT}px`);
  });

  it('JSON 行的文本内容保真（着色不改变文本）', () => {
    const { container } = render(<LogWindow text={makeText(600)} testId="log-window" />);
    // 首窗包含该行；取承载着色节点的行容器，其 textContent 应 === 原始行
    const keyNode = container.querySelector('[data-json-kind="key"]')!;
    const row = keyNode.closest('div[style*="height"]') as HTMLElement;
    expect(row.textContent).toBe(JSON_LINE);
  });

  it('五档着色各自映射到 antd 语义色 token（暗色主题自动翻转）', () => {
    // 用 color*Text 而非 color*：前者是按「在容器底色上做前景文字」调校的档位
    expect(JSON_KIND_TOKEN.key).toBe('colorInfoText');
    expect(JSON_KIND_TOKEN.string).toBe('colorSuccessText');
    expect(JSON_KIND_TOKEN.number).toBe('colorWarningText');
    expect(JSON_KIND_TOKEN.literal).toBe('colorErrorText');
    expect(JSON_KIND_TOKEN.punct).toBe('colorTextTertiary');
    expect(JSON_KIND_TOKEN.plain).toBe('colorText');
  });

  it('关键词搜索时不叠加 JSON 着色（mark 高亮为唯一视觉层级）', () => {
    const { container } = render(
      <LogWindow text={makeText(600)} keyword="abc" testId="log-window" />,
    );
    // 命中渲染 mark
    expect(container.querySelectorAll('mark.log-search-hit').length).toBeGreaterThan(0);
    // 不叠 JSON 着色（否则 mark 与 token span 互相切断）
    expect(container.querySelectorAll('[data-json-kind]').length).toBe(0);
  });

  it('非法 JSON 行不着色，原样渲染纯文本', () => {
    const text = ['[INFO] {"broken": ', ...Array.from({ length: 600 }, (_, i) => `l-${i}`)].join('\n');
    const { container } = render(<LogWindow text={text} testId="log-window" />);
    expect(container.querySelectorAll('[data-json-kind]').length).toBe(0);
    // testing-library 的默认 normalizer 会裁掉首尾空白，故用函数匹配器比对
    expect(
      screen.getByText((_, el) => el?.textContent === '[INFO] {"broken": '),
    ).toBeTruthy();
  });
});

describe('LOG-JSON-01 浮层：点开查看缩进美化形态', () => {
  it('点击 JSON 行展开浮层，浮层内是缩进后的 JSON（多行，但不影响行高）', async () => {
    const { container } = render(<LogWindow text={makeText(600)} testId="log-window" />);
    // 触发面：可聚焦、有可访问名的 role=button（行内文本本身）
    const trigger = container.querySelector('[role="button"][aria-label]') as HTMLElement;
    expect(trigger).toBeTruthy();
    expect(trigger.getAttribute('aria-label')).toBe('展开查看格式化 JSON');
    expect(trigger.tabIndex).toBe(0);

    fireEvent.click(trigger);
    const pretty = await screen.findByTestId('log-json-pretty');
    // 缩进形态：含换行与两空格缩进
    expect(pretty.textContent).toContain('\n  "trace": "abc"');
    // 撑高层高度不受浮层影响（浮层挂到 body，不参与滚动容器布局）
    const spacer = container.querySelector('div[style*="height: 12000px"], div[style*="height:12000px"]');
    expect(spacer).toBeTruthy();
  });

  it('非 JSON 行没有浮层触发器（零额外 DOM）', () => {
    const text = Array.from({ length: 600 }, (_, i) => `plain-${i}`).join('\n');
    const { container } = render(<LogWindow text={text} testId="log-window" />);
    expect(container.querySelectorAll('[role="button"]').length).toBe(0);
  });
});

describe('LOG-JSON-01 <pre> 路径（≤500 行）：着色 + textContent 保真', () => {
  function mockExecution(logs: string) {
    vi.mocked(tasksApi.execution).mockResolvedValue({
      id: 'e1',
      taskId: 't1',
      taskName: 'demo',
      status: 'failed',
      triggerType: 'manual',
      createdAt: '2026-09-06T10:00:00Z',
      logs,
    } as never);
    vi.mocked(tasksApi.get).mockResolvedValue({
      id: 't1',
      name: 'demo',
      runtime: 'python',
      entrypoint: 'main.py',
      maxRetry: 0,
      retryDelay: 0,
      timeout: 60,
      status: 'active',
      triggerType: 'manual',
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    } as never);
    vi.mocked(tasksApi.executions).mockResolvedValue({
      items: [{ id: 'e1', retryCount: 0, status: 'failed' }],
      total: 1,
      page: 1,
      pageSize: 100,
    } as never);
  }

  function renderPage() {
    return render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/tasks/t1/executions/e1']}>
          <Routes>
            <Route path="/tasks/:taskId/executions/:execId" element={<ExecutionDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('JSON 行着色，且 pre 的 textContent 与原始日志逐字符一致', async () => {
    const logs = [
      '2026-09-06 10:00:00 [INFO] start',
      '2026-09-06 10:00:01 [INFO] {"trace":"abc","retry":2,"ok":true}',
      '2026-09-06 10:00:02 [WARN] done',
    ].join('\n');
    mockExecution(logs);
    renderPage();
    await screen.findByText(/start/);

    const pre = document.querySelector('pre') as HTMLPreElement;
    // 保真：着色 token 拼接 === 原文（复制/下载不受影响）
    expect(pre.textContent).toBe(logs);
    // 着色确实生效
    expect(pre.querySelectorAll('[data-json-kind="key"]').length).toBeGreaterThan(0);
    expect(pre.querySelectorAll('[data-json-kind="number"]').length).toBeGreaterThan(0);
  });

  it('纯文本日志不产生任何着色节点（零回归）', async () => {
    const logs = ['plain line one', 'plain line two'].join('\n');
    mockExecution(logs);
    renderPage();
    await screen.findByText(/plain line one/);
    const pre = document.querySelector('pre') as HTMLPreElement;
    expect(pre.textContent).toBe(logs);
    expect(pre.querySelectorAll('[data-json-kind]').length).toBe(0);
  });
});

describe('LOG-JSON-01 token 与行内容的对应关系', () => {
  it('jsonLineTokens 对典型日志形态返回着色 token 且文本拼接 === 原文', () => {
    const tokens = jsonLineTokens(JSON_LINE);
    expect(tokens).toBeTruthy();
    expect(tokens!.map((tk) => tk.text).join('')).toBe(JSON_LINE);
  });
});


/**
 * 第 6 轮审计 P2：JSON 行的「点开美化」此前只有鼠标可达——role=button +
 * tabIndex 是一个「承诺了动作」的死焦点。键盘必须能激活（Enter/Space），
 * 且展开态要能被读屏播报（aria-expanded）。
 */
describe('JsonPrettyPopover · 键盘可达（第 6 轮审计 P2）', () => {
  it('Enter / Space 切换展开，aria-expanded 同步', async () => {
    render(
      <JsonPrettyPopover line='{"a":1}'>
        row-content
      </JsonPrettyPopover>,
    );
    const trigger = screen.getByRole('button');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(trigger, { key: 'Enter' });
    await waitFor(() =>
      expect(trigger.getAttribute('aria-expanded')).toBe('true'),
    );
    fireEvent.keyDown(trigger, { key: ' ' });
    await waitFor(() =>
      expect(trigger.getAttribute('aria-expanded')).toBe('false'),
    );
  });
});
