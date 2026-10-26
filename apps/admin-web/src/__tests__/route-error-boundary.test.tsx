/**
 * NETOPT-4：路由级错误兜底（RouteErrorBoundary）回归——
 *  - 此前全部路由无 errorElement，页面级错误落 react-router 7 data router
 *    内部默认边界，渲染英文调试页 "Unexpected Application Error"（含 stack）；
 *  - 根路由挂 errorElement 后：普通错误渲染 i18n 化的 ErrorFallback 形态；
 *  - 懒加载 chunk 失效（发版后旧 hash）渲染「版本已更新，请刷新」提示。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import RouteErrorBoundary, { isChunkLoadError, isOfflineNow } from '../components/RouteErrorBoundary';

// jsdom 缺失 antd 依赖的浏览器 API，先行补齐（对齐既有先例）
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

afterEach(() => {
  cleanup();
});

function renderThrowingRoute(errorToThrow: unknown): void {
  function Boom(): never {
    throw errorToThrow;
  }
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <Boom />,
        errorElement: <RouteErrorBoundary />,
      },
    ],
    { initialEntries: ['/'] },
  );
  render(<RouterProvider router={router} />);
}

describe('NETOPT-4 RouteErrorBoundary（路由级错误兜底）', () => {
  it('普通错误渲染 i18n 兜底文案，不出现 react-router 英文调试页', () => {
    renderThrowingRoute(new Error('页面级渲染失败'));

    expect(screen.getByText('页面出错了')).toBeTruthy();
    expect(screen.getByText('页面级渲染失败')).toBeTruthy();
    // react-router 默认边界的调试页标题不得出现
    expect(screen.queryByText(/Unexpected Application Error/)).toBeNull();
  });

  it('非 Error 抛出物（字符串）同样走 i18n 兜底', () => {
    renderThrowingRoute('裸字符串错误');

    expect(screen.getByText('页面出错了')).toBeTruthy();
    expect(screen.getByText('未知错误')).toBeTruthy();
    expect(screen.queryByText(/Unexpected Application Error/)).toBeNull();
  });

  it('chunk 拉取失败（Vite ESM 形态）渲染「版本已更新，请刷新」提示与刷新按钮', () => {
    renderThrowingRoute(
      new TypeError('Failed to fetch dynamically imported module: http://localhost/assets/app-abc123.js'),
    );

    expect(screen.getByText('版本已更新，请刷新')).toBeTruthy();
    expect(screen.getByText('刷新页面')).toBeTruthy();
    expect(screen.queryByText(/Unexpected Application Error/)).toBeNull();
  });

  it('isChunkLoadError：覆盖三类已知 chunk 失败形态，普通错误不误报', () => {
    expect(
      isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: http://x/a.js')),
    ).toBe(true);
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Loading chunk 5 failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('普通渲染错误'))).toBe(false);
    expect(isChunkLoadError('字符串错误')).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });

  // F-45（UIUX 审计 P2-3）：断网时 chunk 拉取失败被误报为「版本已更新，请刷新」
  // ——离线下刷新不可能成功，文案与真实原因（网络断开）完全错位。
  describe('F-45 离线分流（navigator.onLine=false）', () => {
    const originalOnLine = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine');

    afterEach(() => {
      if (originalOnLine) {
        Object.defineProperty(Navigator.prototype, 'onLine', originalOnLine);
      }
    });

    function setOnLine(value: boolean): void {
      Object.defineProperty(Navigator.prototype, 'onLine', {
        get: () => value,
        configurable: true,
      });
    }

    it('离线 + chunk 失败 → 「网络连接已断开」文案与重试按钮，不再谎报发版', () => {
      setOnLine(false);
      renderThrowingRoute(
        new TypeError('Failed to fetch dynamically imported module: http://localhost/assets/app-abc.js'),
      );

      expect(screen.getByText('网络连接已断开')).toBeTruthy();
      expect(screen.getByText('重试')).toBeTruthy();
      expect(screen.queryByText('版本已更新，请刷新')).toBeNull();
      expect(screen.queryByText('刷新页面')).toBeNull();
    });

    it('在线 + chunk 失败 → 维持「版本已更新，请刷新」原文案（isOfflineNow 回落安全）', () => {
      setOnLine(true);
      renderThrowingRoute(
        new TypeError('Failed to fetch dynamically imported module: http://localhost/assets/app-abc.js'),
      );

      expect(screen.getByText('版本已更新，请刷新')).toBeTruthy();
      expect(screen.getByText('刷新页面')).toBeTruthy();
      expect(screen.queryByText('网络连接已断开')).toBeNull();
    });

    it('isOfflineNow：仅在 navigator.onLine 明确为 false 时判离线（undefined/true → 在线）', () => {
      setOnLine(true);
      expect(isOfflineNow()).toBe(false);
      setOnLine(false);
      expect(isOfflineNow()).toBe(true);
    });
  });
});
