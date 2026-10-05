/**
 * HOTKEY-01：快捷键速查 Modal（ShortcutHelpModal）渲染与开关测试。
 *
 * 覆盖：
 *  1. open=false 不渲染弹层；open=true 标题/分组/键帽行齐全；
 *  2. 键帽行与 useGlobalHotkeys 的 GOTO_HOTKEYS 对齐（g d/t/e/x/a 五行）；
 *  3. ⌘K 提示按平台判定——jsdom 默认非 Mac → 'Ctrl K'；navigator.platform 桩成
 *     MacIntel → '⌘K'（shortcut-hint.ts 双分支单测的组件级补充）；
 *  4. Esc 关闭（组件显式 document keydown 兜底路径）；
 *  5. i18n zh/en 成对：两语言下标题/分组/跳转行文案各自正确渲染。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import ShortcutHelpModal from '../components/ShortcutHelpModal';
import { GOTO_HOTKEYS } from '../hooks/useGlobalHotkeys';
import i18n, { setLanguage, STORAGE_KEY as LANG_STORAGE_KEY } from '../i18n';

const gotoRowKeys = GOTO_HOTKEYS.map((h) => `g ${h.secondKey}`);

beforeEach(async () => {
  cleanup();
  // 语言状态复位（其他测试文件可能改过 localStorage——forks 池下单进程内仍要防串扰）
  await i18n.changeLanguage('zh');
});

afterEach(async () => {
  cleanup();
  localStorage.removeItem(LANG_STORAGE_KEY);
  await i18n.changeLanguage('zh');
});

describe('ShortcutHelpModal — 渲染与开关（HOTKEY-01）', () => {
  it('open=false 不渲染弹层', () => {
    render(<ShortcutHelpModal open={false} onOpenChange={vi.fn()} />);
    expect(screen.queryByTestId('shortcut-help-modal')).toBeNull();
    expect(screen.queryByText('快捷键')).toBeNull();
  });

  it('open=true：标题、两个分组与全部键帽行齐全（跳转行与 GOTO_HOTKEYS 对齐）', () => {
    render(<ShortcutHelpModal open onOpenChange={vi.fn()} />);
    expect(screen.getByText('快捷键')).toBeTruthy();
    expect(screen.getByText('全局')).toBeTruthy();
    expect(screen.getByText('页面跳转（先按 g，1 秒内按第二个键）')).toBeTruthy();
    // 全局组：Ctrl K（jsdom 非 Mac）+ ?
    expect(screen.getByText('Ctrl K')).toBeTruthy();
    expect(screen.getByText('?')).toBeTruthy();
    expect(screen.getByText('全局搜索 / 命令面板')).toBeTruthy();
    expect(screen.getByText('打开快捷键速查')).toBeTruthy();
    // 跳转组五行：键帽与文案一一对应
    for (const keys of gotoRowKeys) {
      expect(screen.getByText(keys)).toBeTruthy();
    }
    expect(screen.getByText('跳转仪表盘')).toBeTruthy();
    expect(screen.getByText('跳转任务列表')).toBeTruthy();
    expect(screen.getByText('跳转执行器')).toBeTruthy();
    expect(screen.getByText('跳转执行记录')).toBeTruthy();
    expect(screen.getByText('跳转应用')).toBeTruthy();
    // 可访问名：列表 landmark
    expect(screen.getByRole('list', { name: '可用快捷键列表' })).toBeTruthy();
  });

  it('Mac 平台提示 ⌘K（navigator.platform 桩），非 Mac 为 Ctrl K', () => {
    const { unmount } = render(<ShortcutHelpModal open onOpenChange={vi.fn()} />);
    expect(screen.getByText('Ctrl K')).toBeTruthy();
    unmount();

    const platformSpy = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    try {
      render(<ShortcutHelpModal open onOpenChange={vi.fn()} />);
      expect(screen.getByText('⌘K')).toBeTruthy();
      expect(screen.queryByText('Ctrl K')).toBeNull();
      unmount();
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('Esc 关闭：onOpenChange(false)（显式 document keydown 兜底路径）', () => {
    const onOpenChange = vi.fn();
    render(<ShortcutHelpModal open onOpenChange={onOpenChange} />);
    fireEvent.keyDown(document.body, { key: 'Escape', bubbles: true });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('ShortcutHelpModal — i18n zh/en 成对（HOTKEY-01）', () => {
  it('en 语言下标题/分组/跳转行渲染英文文案（en 包按需加载）', async () => {
    await setLanguage('en');
    render(<ShortcutHelpModal open onOpenChange={vi.fn()} />);
    expect(screen.getByText('Keyboard shortcuts')).toBeTruthy();
    expect(screen.getByText('Global')).toBeTruthy();
    expect(screen.getByText('Go to page (press g, then the second key within 1s)')).toBeTruthy();
    expect(screen.getByText('Global search / command palette')).toBeTruthy();
    expect(screen.getByText('Open shortcut cheat sheet')).toBeTruthy();
    expect(screen.getByText('Go to dashboard')).toBeTruthy();
    expect(screen.getByText('Go to task list')).toBeTruthy();
    expect(screen.getByText('Go to executors')).toBeTruthy();
    expect(screen.getByText('Go to executions')).toBeTruthy();
    expect(screen.getByText('Go to applications')).toBeTruthy();
  });
});
