/**
 * DEEP-AUDIT D3-F-P2-1（2026-09-22）：全局未捕获异常兜底聚合的回归守卫。
 *
 * 钉三件事：
 *  ① installGlobalErrorHandlers() 真的在 window 上注册了两个全局监听——
 *     合成派发 'error' / 'unhandledrejection' 事件后，console.error 收到
 *     带上下文（文件/行列、reason 摘要）的聚合输出；
 *  ② 幂等：重复 install 不叠加监听（同一次事件只聚合一次）；
 *  ③ main.tsx 入口确实接线了（源扫描守卫，防止接线被删/移到别处后无声退化）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  installGlobalErrorHandlers,
  type InstalledGlobalErrorHandlers,
} from '../utils/installGlobalErrorHandlers';

let installedHandle: InstalledGlobalErrorHandlers | null = null;
let consoleSpy: ReturnType<typeof vi.spyOn> | null = null;

afterEach(() => {
  installedHandle?.uninstall();
  installedHandle = null;
  consoleSpy?.mockRestore();
  consoleSpy = null;
});

function spyConsoleError() {
  consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
}

describe('D3-F-P2-1: 全局未捕获异常兜底聚合', () => {
  it("注册了 window 'error' 监听：未捕获异常聚合为带上下文的 console.error", () => {
    spyConsoleError();
    installedHandle = installGlobalErrorHandlers();

    const err = new Error('boom-from-test');
    window.dispatchEvent(
      new ErrorEvent('error', {
        message: 'Uncaught Error: boom-from-test',
        filename: 'app.js',
        lineno: 42,
        colno: 7,
        error: err,
      }),
    );

    expect(consoleSpy).toHaveBeenCalledWith(
      '[admin-web][unhandled-error]',
      'Uncaught Error: boom-from-test',
      expect.objectContaining({
        filename: 'app.js',
        lineno: 42,
        colno: 7,
        error: expect.objectContaining({ message: 'boom-from-test' }),
      }),
    );
  });

  it("注册了 window 'unhandledrejection' 监听：reason 摘要进 console.error", () => {
    spyConsoleError();
    installedHandle = installGlobalErrorHandlers();

    window.dispatchEvent(
      new PromiseRejectionEvent('unhandledrejection', {
        reason: new Error('async-nope'),
        promise: Promise.resolve(),
      }),
    );

    expect(consoleSpy).toHaveBeenCalledWith(
      '[admin-web][unhandled-rejection]',
      expect.objectContaining({ name: 'Error', message: 'async-nope' }),
    );
  });

  it('非 Error 的 rejection reason（字符串/对象）原样聚合，不崩', () => {
    spyConsoleError();
    installedHandle = installGlobalErrorHandlers();

    window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', { reason: 'raw-string-reject', promise: Promise.resolve() }));
    expect(consoleSpy).toHaveBeenCalledWith('[admin-web][unhandled-rejection]', 'raw-string-reject');
  });

  it('幂等：重复 install 不叠加监听，同一事件只聚合一次', () => {
    spyConsoleError();
    installedHandle = installGlobalErrorHandlers();
    installGlobalErrorHandlers(); // 二次调用

    window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', { reason: 'once', promise: Promise.resolve() }));

    const calls = consoleSpy?.mock.calls.filter(
      (c: unknown[]) => c[0] === '[admin-web][unhandled-rejection]',
    );
    expect(calls?.length).toBe(1);
  });

  it('uninstall 后监听移除：不再聚合', () => {
    spyConsoleError();
    installedHandle = installGlobalErrorHandlers();
    installedHandle.uninstall();
    installedHandle = null;

    window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', { reason: 'gone', promise: Promise.resolve() }));
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('入口守卫：main.tsx 在渲染前接线 installGlobalErrorHandlers', () => {
    const mainSrc = readFileSync(join(__dirname, '..', 'main.tsx'), 'utf8');
    expect(mainSrc).toMatch(
      /import\s*{\s*installGlobalErrorHandlers\s*}\s*from\s*['"]\.\/utils\/installGlobalErrorHandlers['"]/,
    );
    expect(mainSrc).toMatch(/installGlobalErrorHandlers\(\)/);
  });
});
