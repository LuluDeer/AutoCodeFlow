/**
 * F-38（DEEP_REVIEW 0ef3bbe）：GlueEditor 组件行为级测试。
 *
 * F-01 修复核心：loader.config({ monaco }) 注入本地 monaco 实例，
 * 而非从 jsdelivr CDN 动态加载。本测试断言：
 * ① 模块加载时 loader.config 被调用（本地 monaco 注入生效，不打 CDN）；
 * ② 渲染后语言选择器、模板按钮、保存按钮行为正确；
 * ③ 保存调用 tasksApi.updateGlue(taskId, source, language)。
 *
 * Monaco 重依赖（worker/CDN）在 jsdom 不可用——按 F-38 指引 mock
 * @monaco-editor/react，断言 loader.config 被调用即可。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';

// vi.mock 被 hoist 到文件顶部——用 vi.hoisted 定义 mock 句柄
const { mockLoaderConfig, mockEditor } = vi.hoisted(() => {
  return {
    mockLoaderConfig: vi.fn(),
    mockEditor: vi.fn(),
  };
});

vi.mock('@monaco-editor/react', () => ({
  Editor: (props: unknown) => mockEditor(props),
  loader: {
    config: mockLoaderConfig,
    init: vi.fn(),
  },
}));

vi.mock('monaco-editor', () => ({
  default: { editor: {}, languages: {} },
}));

vi.mock('../components/monaco-setup', () => ({}));

vi.mock('../api/tasks', () => ({
  tasksApi: {
    updateGlue: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>();
  return {
    ...actual,
    message: { success: vi.fn(), error: vi.fn() },
  };
});

import GlueEditor from '../components/GlueEditor';
import { tasksApi } from '../api/tasks';

// jsdom shims
const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// mockEditor 返回一个占位 div（在 hoist 后用 createElement）
mockEditor.mockImplementation((props: { value?: string; language?: string }) => {
  return createElement('div', {
    'data-testid': 'mock-monaco-editor',
    'data-value': props.value ?? '',
    'data-language': props.language ?? '',
  });
});

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function renderEditor(over: Partial<Parameters<typeof GlueEditor>[0]> = {}) {
  return render(
    <QueryClientProvider client={queryClient}>
      <GlueEditor taskId="task-1" initialSource="print('hello')" initialLanguage="python" {...over} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  // 不 vi.clearAllMocks——mockLoaderConfig 在模块加载时已调用（F-01 断言），
  // clearAllMocks 会清掉那次调用记录。仅清测试间会变的 mock。
  mockEditor.mockClear();
  vi.mocked(tasksApi.updateGlue).mockClear();
  mockEditor.mockImplementation((props: { value?: string; language?: string }) => {
    return createElement('div', {
      'data-testid': 'mock-monaco-editor',
      'data-value': props.value ?? '',
      'data-language': props.language ?? '',
    });
  });
});

afterEach(() => {
  cleanup();
});

describe('GlueEditor（F-01 本地 Monaco + F-38 行为覆盖）', () => {
  it('① 模块加载时 loader.config 被调用——注入本地 monaco，不从 CDN 加载', () => {
    // GlueEditor 模块在 import 时即执行 loader.config({ monaco })
    expect(mockLoaderConfig).toHaveBeenCalled();
    const configArg = mockLoaderConfig.mock.calls[0][0];
    expect(configArg).toHaveProperty('monaco');
  });

  it('② 渲染初始 source + language 传入 mock Editor', () => {
    renderEditor();
    const editorDiv = screen.getByTestId('mock-monaco-editor');
    expect(editorDiv).toBeTruthy();
    const lastCall = mockEditor.mock.calls[mockEditor.mock.calls.length - 1][0];
    expect(lastCall).toMatchObject({
      value: "print('hello')",
      language: 'python',
    });
  });

  it('③ 切换语言 → dirty 标记 → 保存调 updateGlue', async () => {
    renderEditor();
    const saveBtn = screen.getByRole('button', { name: /保存|save/i }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);

    const langSelect = document.querySelector('.ant-select') as HTMLElement;
    fireEvent.mouseDown(langSelect);
    const jsOption = await screen.findByText('JavaScript');
    fireEvent.click(jsOption);

    await waitFor(() => expect(saveBtn.disabled).toBe(false));
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(tasksApi.updateGlue).toHaveBeenCalledWith('task-1', "print('hello')", 'javascript');
    });
  });

  it('④ 使用模板按钮 → source 更新为模板内容', () => {
    renderEditor();
    const tplBtn = screen.getByRole('button', { name: /模板|template/i });
    fireEvent.click(tplBtn);
    const lastCall = mockEditor.mock.calls[mockEditor.mock.calls.length - 1][0];
    expect(lastCall.value).toContain('Glue script for task execution');
  });
});
