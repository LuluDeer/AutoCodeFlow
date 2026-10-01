/**
 * PERF/UX（第四轮审计）— GlueEditor 主题联动全站明暗主题。
 *
 * 此前 theme 硬编码 "vs-dark"，亮色主题下「页面白、编辑器黑」割裂。修复后：
 *  - theme/store.ts 的 resolved 主题 → monaco：light→"vs"、dark→"vs-dark"；
 *  - store 切换（含 system 态跟随系统）触发重渲染 → theme prop 变化，
 *    @monaco-editor/react 内部调 monaco.editor.setTheme，切换即时生效。
 *
 * Monaco 重依赖在 jsdom 不可用——与 glue-editor.test.tsx 同策 mock
 * @monaco-editor/react，断言 Editor 收到的 theme 入参。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';

vi.mock('@monaco-editor/react', () => ({
  Editor: vi.fn(),
  loader: { config: vi.fn(), init: vi.fn() },
}));

vi.mock('monaco-editor', () => ({
  default: { editor: {}, languages: {} },
}));

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
import { useThemeStore } from '../theme/store';

const mockEditor = mockedEditorMod as unknown as ReturnType<typeof vi.fn>;

mockEditor.mockImplementation((props: { value?: string; language?: string; theme?: string }) =>
  createElement('div', {
    'data-testid': 'mock-monaco-editor',
    'data-value': props.value ?? '',
    'data-language': props.language ?? '',
    'data-theme': props.theme ?? '',
  }),
);

/** 最近一次 Editor 挂载收到的 theme 入参 */
function lastEditorTheme(): string {
  const last = mockEditor.mock.calls[mockEditor.mock.calls.length - 1][0] as { theme?: string };
  return last.theme ?? '';
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function renderEditor() {
  return render(
    <QueryClientProvider client={queryClient}>
      <GlueEditor taskId="task-1" initialSource="print('x')" initialLanguage="python" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockEditor.mockClear();
  // 逐用例归位主题（persist 到 localStorage 的 mode 会跨用例泄漏）
  act(() => useThemeStore.setState({ mode: 'light' }));
  mockEditor.mockImplementation((props: { value?: string; language?: string; theme?: string }) =>
    createElement('div', {
      'data-testid': 'mock-monaco-editor',
      'data-value': props.value ?? '',
      'data-language': props.language ?? '',
      'data-theme': props.theme ?? '',
    }),
  );
});
afterEach(() => {
  cleanup();
  act(() => useThemeStore.setState({ mode: 'light' }));
});

describe('GlueEditor 主题联动（第四轮审计）', () => {
  it('light 主题 → monaco "vs"', () => {
    act(() => useThemeStore.setState({ mode: 'light' }));
    renderEditor();
    expect(screen.getByTestId('mock-monaco-editor')).toBeTruthy();
    expect(lastEditorTheme()).toBe('vs');
  });

  it('dark 主题 → monaco "vs-dark"（不再硬编码）', () => {
    act(() => useThemeStore.setState({ mode: 'dark' }));
    renderEditor();
    expect(lastEditorTheme()).toBe('vs-dark');
  });

  it('system 主题 + 系统偏好 dark → monaco "vs-dark"', () => {
    // selectResolvedTheme 的 system 分支读 matchMedia('(prefers-color-scheme: dark)')
    const spy = vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
    } as unknown as MediaQueryList);
    try {
      act(() => useThemeStore.setState({ mode: 'system' }));
      renderEditor();
      expect(lastEditorTheme()).toBe('vs-dark');
    } finally {
      spy.mockRestore();
    }
  });

  it('挂载后切换主题 → Editor theme prop 即时更新（无需重挂载）', () => {
    act(() => useThemeStore.setState({ mode: 'light' }));
    renderEditor();
    expect(lastEditorTheme()).toBe('vs');
    act(() => useThemeStore.setState({ mode: 'dark' }));
    expect(lastEditorTheme()).toBe('vs-dark');
    act(() => useThemeStore.setState({ mode: 'light' }));
    expect(lastEditorTheme()).toBe('vs');
  });
});
