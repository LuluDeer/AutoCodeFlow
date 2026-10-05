/**
 * HOTKEY-01：useGlobalHotkeys 单测。
 *
 * 覆盖（对齐 hooks/useGlobalHotkeys.ts 头注的状态机与护栏顺序）：
 *  1. g 前缀序列：g d/t/e/x/a 五路跳转（路由断言走 LocationProbe，真实 location.pathname）；
 *  2. 超时重置：g 后超过 G_SEQUENCE_TIMEOUT_MS 未按第二键 → 序列失效；
 *     窗口边界内（-1ms）仍生效；
 *  3. 输入态忽略：input/textarea/select/contentEditable 聚焦时 g 序列与 ? 均不触发；
 *  4. 弹层忽略：焦点在 .ant-modal / .ant-drawer 内不触发；
 *  5. 全局弹层打开（isOverlayOpen=true，⌘K 面板/速查 Modal）：一律忽略；
 *  6. ?（Shift+/）切换速查 onToggleHelp；
 *  7. 组合键让路（ctrl/meta/alt）、e.repeat 连发不触发；
 *  8. 非命中第二键重置；重复按 g 重新起手（g g d 仍可跳转）；
 *  9. 卸载清理：移除监听后按键零副作用。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import useGlobalHotkeys, {
  G_SEQUENCE_TIMEOUT_MS,
  GOTO_HOTKEYS,
  isEditableTarget,
  isInsideOverlay,
} from '../hooks/useGlobalHotkeys';

function LocationProbe() {
  const location = useLocation();
  return <div>route:{location.pathname}</div>;
}

interface HostProps {
  onToggleHelp: () => void;
  isOverlayOpen?: () => boolean;
}

function HotkeyHost({ onToggleHelp, isOverlayOpen }: HostProps) {
  useGlobalHotkeys({
    onToggleHelp,
    isOverlayOpen: isOverlayOpen ?? (() => false),
  });
  return null;
}

/** 初始路由用 /settings（不在任何 g 目标集合内），保证每次跳转都能从 pathname 观测 */
function renderHotkeys(opts: Partial<HostProps> = {}) {
  return render(
    <MemoryRouter initialEntries={['/settings']}>
      <HotkeyHost
        onToggleHelp={opts.onToggleHelp ?? (() => {})}
        isOverlayOpen={opts.isOverlayOpen ?? (() => false)}
      />
      <Routes>
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

const press = (key: string, init: Record<string, unknown> = {}) =>
  fireEvent.keyDown(window, { key, bubbles: true, ...init });

beforeEach(() => {
  cleanup();
});

afterEach(() => {
  cleanup();
});

describe('useGlobalHotkeys — g 前缀序列跳转（HOTKEY-01）', () => {
  it('g d → 仪表盘（从 /tasks 出发）', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/tasks']}>
        <HotkeyHost onToggleHelp={() => {}} />
        <Routes>
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    press('g');
    press('d');
    expect(container.textContent).toContain('route:/dashboard');
  });

  it('五路目标逐一命中：g t/e/x/a（GOTO_HOTKEYS 是唯一事实源）', () => {
    for (const hotkey of GOTO_HOTKEYS) {
      const { container, unmount } = renderHotkeys();
      press('g');
      press(hotkey.secondKey);
      expect(container.textContent).toContain(`route:${hotkey.path}`);
      unmount();
    }
  });

  it('超时重置：g 后超过 G_SEQUENCE_TIMEOUT_MS，第二键不再生效', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { container } = renderHotkeys();
      press('g');
      act(() => {
        vi.advanceTimersByTime(G_SEQUENCE_TIMEOUT_MS);
      });
      press('d');
      expect(container.textContent).toContain('route:/settings');
    } finally {
      vi.useRealTimers();
    }
  });

  it('超时边界：g 后 G_SEQUENCE_TIMEOUT_MS - 1ms 按第二键仍生效', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { container } = renderHotkeys();
      press('g');
      act(() => {
        vi.advanceTimersByTime(G_SEQUENCE_TIMEOUT_MS - 1);
      });
      press('x');
      expect(container.textContent).toContain('route:/executions');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useGlobalHotkeys — 输入态 / 弹层忽略（HOTKEY-01）', () => {
  const renderWithInputs = (onToggleHelp = () => {}) =>
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <HotkeyHost onToggleHelp={onToggleHelp} />
        <Routes>
          <Route path="*" element={<LocationProbe />} />
        </Routes>
        <input aria-label="demo-input" />
        <textarea aria-label="demo-textarea" />
        <select aria-label="demo-select"><option value="a">a</option></select>
        <div contentEditable aria-label="demo-rich" />
      </MemoryRouter>,
    );

  it('input 聚焦时 g d 不跳转、? 不触发速查', () => {
    const onToggleHelp = vi.fn();
    const { container } = renderWithInputs(onToggleHelp);
    const input = screen.getByLabelText('demo-input') as HTMLInputElement;
    input.focus();
    fireEvent.keyDown(input, { key: 'g', bubbles: true });
    fireEvent.keyDown(input, { key: 'd', bubbles: true });
    fireEvent.keyDown(input, { key: '?', bubbles: true });
    expect(container.textContent).toContain('route:/settings');
    expect(onToggleHelp).not.toHaveBeenCalled();
  });

  it('textarea / select / contentEditable 聚焦时同样忽略 g 序列', () => {
    const { container } = renderWithInputs();
    for (const label of ['demo-textarea', 'demo-select', 'demo-rich']) {
      const el = screen.getByLabelText(label) as HTMLElement;
      // jsdom 未实现 contentEditable（isContentEditable 恒 false）——按真实浏览器
      // 行为桩成 true，验证 contentEditable 分支（textarea/select 走 tagName 分支）
      Object.defineProperty(el, 'isContentEditable', { value: label === 'demo-rich', configurable: true });
      el.focus();
      fireEvent.keyDown(el, { key: 'g', bubbles: true });
      fireEvent.keyDown(el, { key: 'd', bubbles: true });
      expect(container.textContent).toContain('route:/settings');
    }
  });

  it('焦点在 .ant-modal / .ant-drawer 内不触发（速查/触发弹窗等弹层键盘语义自持）', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/settings']}>
        <HotkeyHost onToggleHelp={() => {}} />
        <Routes>
          <Route path="*" element={<LocationProbe />} />
        </Routes>
        <div className="ant-modal">
          <button type="button" aria-label="modal-btn">ok</button>
        </div>
        <div className="ant-drawer">
          <button type="button" aria-label="drawer-btn">ok</button>
        </div>
      </MemoryRouter>,
    );
    for (const label of ['modal-btn', 'drawer-btn']) {
      const btn = screen.getByLabelText(label);
      btn.focus();
      fireEvent.keyDown(btn, { key: 'g', bubbles: true });
      fireEvent.keyDown(btn, { key: 'd', bubbles: true });
      expect(container.textContent).toContain('route:/settings');
    }
  });

  it('全局弹层打开（isOverlayOpen=true，⌘K 面板/速查 Modal）时 g 序列与 ? 一律忽略', () => {
    const onToggleHelp = vi.fn();
    const { container } = renderHotkeys({ onToggleHelp, isOverlayOpen: () => true });
    press('g');
    press('d');
    press('?');
    expect(container.textContent).toContain('route:/settings');
    expect(onToggleHelp).not.toHaveBeenCalled();
  });
});

describe('useGlobalHotkeys — ? 速查与序列边界（HOTKEY-01）', () => {
  it('?（Shift+/）切换速查 onToggleHelp，每次按键调用一次', () => {
    const onToggleHelp = vi.fn();
    renderHotkeys({ onToggleHelp });
    press('?');
    press('?');
    press('/', { shiftKey: true });
    expect(onToggleHelp).toHaveBeenCalledTimes(3);
  });

  it('组合键让路：ctrl/meta/alt + g 不进入待定态，ctrl + ? 不触发速查', () => {
    const onToggleHelp = vi.fn();
    const { container } = renderHotkeys({ onToggleHelp });
    press('g', { ctrlKey: true });
    press('d');
    press('g', { metaKey: true });
    press('d');
    press('g', { altKey: true });
    press('d');
    press('?', { ctrlKey: true });
    expect(container.textContent).toContain('route:/settings');
    expect(onToggleHelp).not.toHaveBeenCalled();
  });

  it('e.repeat 连发不触发：repeat 的 g 不进入待定态', () => {
    const { container } = renderHotkeys();
    press('g', { repeat: true });
    press('d');
    expect(container.textContent).toContain('route:/settings');
  });

  it('非命中第二键消费序列：g z d 不跳转；重复按 g 重新起手（g g d 可跳转）', () => {
    const { container } = renderHotkeys();
    press('g');
    press('z');
    press('d');
    expect(container.textContent).toContain('route:/settings');
    press('g');
    press('g');
    press('d');
    expect(container.textContent).toContain('route:/dashboard');
  });

  it('卸载清理：移除监听后按键零副作用', () => {
    // 先挂载 hook，再 rerender 卸载 HotkeyHost（保留路由探针）——
    // 卸载后按 g d / ? 不得再产生任何跳转或速查调用
    const onToggleHelp = vi.fn();
    const { rerender, container } = render(
      <MemoryRouter initialEntries={['/settings']}>
        <HotkeyHost onToggleHelp={onToggleHelp} />
        <Routes>
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    rerender(
      <MemoryRouter initialEntries={['/settings']}>
        <Routes>
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    press('g');
    press('d');
    press('?');
    expect(container.textContent).toContain('route:/settings');
    expect(onToggleHelp).not.toHaveBeenCalled();
  });
});

describe('useGlobalHotkeys — 纯函数护栏判定', () => {
  it('isEditableTarget：input/textarea/select/contentEditable 为真，普通元素/window 为假', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const select = document.createElement('select');
    const rich = document.createElement('div');
    // jsdom 未实现 contentEditable（isContentEditable 恒 false）——直接桩属性验证分支
    Object.defineProperty(rich, 'isContentEditable', { value: true, configurable: true });
    const plain = document.createElement('div');
    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(textarea)).toBe(true);
    expect(isEditableTarget(select)).toBe(true);
    expect(isEditableTarget(rich)).toBe(true);
    expect(isEditableTarget(plain)).toBe(false);
    expect(isEditableTarget(window)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  it('isInsideOverlay：ant-modal/ant-drawer/ant-popover/ant-dropdown 内为真', () => {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="ant-modal"><button class="m">a</button></div>
      <div class="ant-drawer"><button class="d">b</button></div>
      <div class="ant-popover"><button class="p">c</button></div>
      <div class="ant-dropdown"><button class="u">d</button></div>`;
    document.body.appendChild(wrap);
    try {
      expect(isInsideOverlay(wrap.querySelector('.m'))).toBe(true);
      expect(isInsideOverlay(wrap.querySelector('.d'))).toBe(true);
      expect(isInsideOverlay(wrap.querySelector('.p'))).toBe(true);
      expect(isInsideOverlay(wrap.querySelector('.u'))).toBe(true);
      expect(isInsideOverlay(wrap)).toBe(false);
      expect(isInsideOverlay(document.createElement('button'))).toBe(false);
    } finally {
      wrap.remove();
    }
  });
});
