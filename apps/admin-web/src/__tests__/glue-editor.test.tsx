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

// vitest 5：vi.hoisted 句柄与被 mock 模块的实例在「工厂闭包」「测试文件体」
// 两次实例化下不保证同源，mock 调用记录也会在 beforeEach 前被清空（实测）。
// 故 loader.config 的断言走 globalThis 上的普通数组（对 mock 生命周期免疫），
// Editor 保持 vi.fn、由 beforeEach 注入实现。
vi.mock('@monaco-editor/react', () => {
  const g = globalThis as Record<string, unknown> & { __acfMonacoLoaderConfigCalls?: unknown[] };
  g.__acfMonacoLoaderConfigCalls = [];
  return ({
    Editor: vi.fn(),
    loader: {
      config: (cfg: unknown) => {
        g.__acfMonacoLoaderConfigCalls!.push(cfg);
      },
      init: vi.fn(),
    },
  });
});

vi.mock('monaco-editor', () => ({
  default: { editor: {}, languages: {} },
}));

// 网络性能审计（2026-09-18）：monaco-setup 现在导出 { monaco }（tree-shaken
// editor.api 实例），mock 提供同名形状，loader.config 断言见用例 ①。
vi.mock('../components/monaco-setup', () => ({
  monaco: { editor: {}, languages: {} },
}));

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
import { Editor as mockedEditorMod } from '@monaco-editor/react';
import { tasksApi } from '../api/tasks';

// 与 GlueEditor 消费的是同一个被 mock 的模块实例——句柄直接取 vi.mocked 引用。
const mockEditor = mockedEditorMod as unknown as ReturnType<typeof vi.fn>;

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
    // GlueEditor 模块在 import 时即执行 loader.config({ monaco })。
    // 断言读工厂写入 globalThis 的普通数组——vitest 5 的 mock 调用记录
    // 生命周期与「import 期调用 + beforeEach」组合有清空时序，不可依赖。
    const calls = (globalThis as { __acfMonacoLoaderConfigCalls?: unknown[] }).__acfMonacoLoaderConfigCalls ?? [];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toHaveProperty('monaco');
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
