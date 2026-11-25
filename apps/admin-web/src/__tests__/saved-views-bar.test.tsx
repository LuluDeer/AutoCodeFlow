/**
 * SavedViewsBar 可访问性回归：
 *  1. 空名提交失败 → 错误以 role="alert" 暴露给读屏；修正输入 / 成功提交后消失；
 *  2. 内联确认按钮 aria-label 跟随界面语言（zh=确认 / en=Confirm），补齐
 *     i18n-scan（只扫硬编码中文）与 i18n-key-check（只管缺键）的覆盖盲区。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import SavedViewsBar, { type SaveResult } from '../components/views/SavedViewsBar';
import i18n, { STORAGE_KEY as LANG_STORAGE_KEY } from '../i18n';

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

function renderBar(onSave = vi.fn((): SaveResult => ({ ok: false, reason: 'empty' }))) {
  return render(
    <SavedViewsBar
      views={[]}
      activeId={null}
      onSave={onSave}
      onRename={vi.fn()}
      onRemove={vi.fn()}
      onApply={vi.fn()}
      onClearActive={vi.fn()}
    />,
  );
}

beforeEach(async () => {
  cleanup();
  await i18n.changeLanguage('zh');
});

afterEach(async () => {
  cleanup();
  localStorage.removeItem(LANG_STORAGE_KEY);
  await i18n.changeLanguage('zh');
});

describe('SavedViewsBar — 可访问性', () => {
  it('空名提交后错误以 role=alert 播报，修正输入 / 成功提交后消失', async () => {
    const onSave = vi.fn((): SaveResult => ({ ok: false, reason: 'empty' }));
    renderBar(onSave);

    fireEvent.click(screen.getByRole('button', { name: /保存视图/ }));
    expect(screen.queryByRole('alert')).toBeNull();

    const input = screen.getByPlaceholderText('视图名称');
    fireEvent.click(screen.getByLabelText('确认'));
    expect(onSave).toHaveBeenCalledWith('');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('请输入视图名称');

    fireEvent.change(input, { target: { value: '部署失败' } });
    expect(screen.queryByRole('alert')).toBeNull();

    onSave.mockReturnValue({ ok: true });
    fireEvent.click(screen.getByLabelText('确认'));
    expect(onSave).toHaveBeenLastCalledWith('部署失败');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('内联确认按钮 aria-label 跟随界面语言（zh=确认 / en=Confirm）', async () => {
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: /保存视图/ }));
    expect(screen.getByLabelText('确认')).toBeTruthy();
    expect(screen.queryByLabelText('confirm')).toBeNull();

    cleanup();
    await i18n.changeLanguage('en');
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: /Save view/ }));
    expect(screen.getByLabelText('Confirm')).toBeTruthy();
    expect(screen.queryByLabelText('confirm')).toBeNull();
  });
});
