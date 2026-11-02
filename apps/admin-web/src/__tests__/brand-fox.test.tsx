/**
 * BRAND（2026-11-02）：吉祥物「小狐」的形象位测试。
 *
 * 为什么值得单独测：狐狸出现在**四个**不同的页面里（侧边栏、登录页、404、控制台空态），
 * 而每一处都长得像「一张 img」——把它换回 antd 默认插图或一个 icon，页面照样渲染、
 * 测试照样绿（历史截图里就是这么无声丢掉的）。这里钉三条**行为**判据：
 *   ① 这些位置渲染出来的确实是 `acf-fox.svg`（不是别的图 / 不是 icon）；
 *   ② 默认是**装饰**（`alt=""` + `aria-hidden`）——旁边已有可读标题，读屏不该多念；
 *   ③ 传了 `alt` 就进无障碍树（`aria-hidden` 撤掉）——将来当信息图用时不至于读屏哑掉。
 *
 * 断言纪律与仓内其它 UX 测试一致：不写快照，全部断言 DOM 语义与属性。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BrandFox from '../components/BrandFox';
import NotFoundPage from '../pages/NotFoundPage';

// jsdom 缺 antd 依赖的浏览器 API（与既有页面测试同款 shim）
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
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('BrandFox —— 中台吉祥物', () => {
  it('默认指向 /acf-fox.svg，按 size 落宽高（布局不跳）', () => {
    const { container } = render(<BrandFox size={96} />);
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/acf-fox.svg');
    // 显式 width/height 属性 + 内联样式同值：图片解码前后都占位，不推挤标题（CLS）
    expect(img.getAttribute('width')).toBe('96');
    expect(img.getAttribute('height')).toBe('96');
    expect(img.style.width).toBe('96px');
    expect(img.style.height).toBe('96px');
  });

  it('默认是装饰图：alt 为空串且 aria-hidden，不进无障碍树', () => {
    const { container } = render(<BrandFox />);
    const img = container.querySelector('img')!;
    expect(img.getAttribute('alt')).toBe('');
    expect(img.getAttribute('aria-hidden')).toBe('true');
    // 读屏查询接口拿不到它——这才是「装饰」的实际效果，而不是只看 alt 文本
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('显式传 alt 即视为信息图：撤掉 aria-hidden，可被读屏按图查询', () => {
    render(<BrandFox size={160} alt="AutoCodeFlow mascot" />);
    const img = screen.getByRole('img');
    expect(img.getAttribute('aria-hidden')).toBeNull();
    expect(img.getAttribute('alt')).toBe('AutoCodeFlow mascot');
  });

  it('默认尺寸 32 不是随手取的：低于它狐狸在真实渲染里只是一团糊（品牌文档实测）', () => {
    const { container } = render(<BrandFox />);
    const img = container.querySelector('img')!;
    expect(Number(img.getAttribute('width'))).toBeGreaterThanOrEqual(32);
  });
});

describe('404 页的品牌形象位', () => {
  it('渲染狐狸 + 语义 h1，而不是 antd Result 的 div 标题', () => {
    render(
      <MemoryRouter>
        <NotFoundPage />
      </MemoryRouter>,
    );
    const img = document.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/acf-fox.svg');
    // h1 是 a11y 判据：antd Result 的 title 是 div，404 页此前整页无 h1
    const h1 = document.querySelector('h1');
    expect(h1).toBeTruthy();
    expect(h1!.textContent).toBe('页面不存在');
  });
});
