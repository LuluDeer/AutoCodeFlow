/**
 * T1（P2）/ T2（P3）无障碍回归：显式平滑滚动尊重 reduced-motion，
 * 自绘 role=button 卡片的 Space 键不滚页面。
 *
 * T1 的 CSS `@media (prefers-reduced-motion: reduce)` 兜底管不到显式
 * `behavior: 'smooth'`（CSSOM 显式值优先），故四个调用点统一读系统偏好降级为 auto。
 * T2 的 Div role=button 不自带原生按钮的默认行为，Space 仍会滚页面——
 * 先 preventDefault 再导航，与 DagCanvas 的既有先例一致。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { prefersReducedMotion } from '../utils/scroll-reduced';
import { scrollToSectionWhenReady } from '../utils/scroll-when-ready';
import ExecutorHeatBars, { type ExecutorHeatRow } from '../components/dashboard/ExecutorHeatBars';
import FailureTopList, { type FailureTopItem } from '../components/dashboard/FailureTopList';

const SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf-8');

const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');

/** 可控 prefers-reduced-motion 偏好（其余查询恒 false，不干扰主题测试） */
function setReducedMotion(reduce: boolean | null) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (q: string) =>
      ({
        matches: reduce !== null && q.includes('prefers-reduced-motion') ? reduce : false,
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  });
}

beforeEach(() => setReducedMotion(null));
afterEach(() => {
  cleanup();
  if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
  else Reflect.deleteProperty(window, 'matchMedia');
  vi.restoreAllMocks();
});

describe('prefersReducedMotion — 系统偏好读取与回退', () => {
  it('开启减弱动效 → true；关闭 → false', () => {
    setReducedMotion(true);
    expect(prefersReducedMotion()).toBe(true);
    setReducedMotion(false);
    expect(prefersReducedMotion()).toBe(false);
  });

  it('无 matchMedia（旧 jsdom/SSR）回退 false，维持原平滑行为', () => {
    Object.defineProperty(window, 'matchMedia', { value: undefined, writable: true, configurable: true });
    expect(prefersReducedMotion()).toBe(false);
    expect(prefersReducedMotion(null)).toBe(false);
  });

  it('可注入 view（scroll-when-ready 的 doc.defaultView 通道）', () => {
    const view = {
      matchMedia: (q: string) => ({ matches: q.includes('prefers-reduced-motion') }),
    } as unknown as Window;
    expect(prefersReducedMotion(view)).toBe(true);
    setReducedMotion(false);
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe('scrollToSectionWhenReady — 显式 smooth 按偏好降级', () => {
  /** 手动 rAF 队列 + 可控 matchMedia 的假 defaultView */
  function makeDoc(reduce: boolean) {
    const queue: FrameRequestCallback[] = [];
    const el = document.createElement('div');
    el.id = 'motion-target';
    document.body.appendChild(el);
    const spy = vi.spyOn(el, 'scrollIntoView').mockImplementation(() => {});
    const doc = {
      getElementById: (id: string) => (id === el.id ? el : null),
      defaultView: {
        requestAnimationFrame: (cb: FrameRequestCallback) => queue.push(cb),
        matchMedia: (q: string) => ({ matches: q.includes('prefers-reduced-motion') && reduce }),
      },
    } as unknown as Document;
    return { doc, spy, pump: () => queue.splice(0).forEach((cb) => cb(0)) };
  }

  it('开启减弱动效：仍等待渲染就绪，但滚动行为为 auto', () => {
    const { doc, spy, pump } = makeDoc(true);
    scrollToSectionWhenReady('motion-target', doc);
    pump();
    pump();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });
  });

  it('未开启减弱动效：保持原 smooth 参数（既有测试口径不变）', () => {
    const { doc, spy, pump } = makeDoc(false);
    scrollToSectionWhenReady('motion-target', doc);
    pump();
    pump();
    expect(spy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });
});

describe('四处显式滚动调用点静态守卫（CSS 兜底覆盖不到的显式值）', () => {
  const targets = [
    ['ApplicationDetailPage', 'pages/ApplicationDetailPage.tsx'],
    ['TaskFormPage', 'pages/TaskFormPage.tsx'],
    ['useTaskFormValidation', 'pages/task-form/useTaskFormValidation.ts'],
    ['scroll-when-ready', 'utils/scroll-when-ready.ts'],
  ] as const;

  it('每处都经 prefersReducedMotion 三元降级，且无残留裸 smooth', () => {
    for (const [name, rel] of targets) {
      const src = read(rel);
      expect(src, `${name} 未包含 prefersReducedMotion 降级`).toMatch(
        /behavior:\s*prefersReducedMotion\([^)]*\)\s*\?\s*'auto'\s*:\s*'smooth'/,
      );
      expect(src, `${name} 仍有显式 behavior: 'smooth'`).not.toMatch(/behavior:\s*'smooth'/);
    }
  });
});

describe('T3 — 纯色状态点的可访问名复用既有 i18n 键', () => {
  it('ExecutorPackagesPage 的 success Badge 带 aria-label，且在 zh/en 都有词条', () => {
    const src = read('pages/ExecutorPackagesPage.tsx');
    expect(src).toContain("aria-label={t('execList.status.online')}");
    for (const locale of ['zh', 'en']) {
      expect(read(`locales/${locale}.ts`), `${locale} 缺少 execList.status.online`).toContain(
        "'execList.status.online'",
      );
    }
  });
});

/** 捕获 Space 的默认行为是否已被 React 处理器阻止（document 气泡晚于 React root） */
async function spaceDoesNotScroll(row: HTMLElement) {
  const user = userEvent.setup();
  const scrollSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  const captured: boolean[] = [];
  const listener = (e: KeyboardEvent) => {
    if (e.key === ' ') captured.push(e.defaultPrevented);
  };
  document.addEventListener('keydown', listener);
  row.focus();
  await user.keyboard(' ');
  document.removeEventListener('keydown', listener);
  expect(captured.length, 'Space 键盘事件未派发').toBeGreaterThan(0);
  expect(captured.every(Boolean), 'Space 未 preventDefault，页面会滚动').toBe(true);
  expect(scrollSpy).not.toHaveBeenCalled();
}

const heatRow: ExecutorHeatRow = {
  id: 'ex-a', appName: 'RPA5', address: '10.0.0.1:3002', status: 'online',
  cpuUsage: 10, memUsage: 20, runningTaskCount: 1,
};
const failRow: FailureTopItem = {
  taskId: 'task-a', taskName: 'nightly', failCount: 3,
  lastFailedAt: '2026-11-24T10:00:00Z', lastError: 'boom',
};

describe('Space 键不滚页面（role=button 自绘卡片）', () => {
  it('ExecutorHeatBars 行：Space 阻止默认且仍打开执行器', async () => {
    const onOpen = vi.fn();
    render(<ExecutorHeatBars executors={[heatRow]} onOpenExecutor={onOpen} />);
    const row = screen.getByTestId('executor-heat-row');
    await spaceDoesNotScroll(row);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith('ex-a');
  });

  it('FailureTopList 行：Space 阻止默认且仍打开任务', async () => {
    const onOpen = vi.fn();
    render(<FailureTopList failures={[{ id: 'f1', taskId: failRow.taskId, taskName: failRow.taskName, errorMessage: failRow.lastError, createdAt: failRow.lastFailedAt }]} onOpenTask={onOpen} />);
    const row = screen.getByTestId('failure-top-row');
    await spaceDoesNotScroll(row);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith('task-a');
  });

  it('Enter 分支保持不变：仍打开目标，不引入额外拦截', async () => {
    const onOpen = vi.fn();
    render(<ExecutorHeatBars executors={[heatRow]} onOpenExecutor={onOpen} />);
    const user = userEvent.setup();
    screen.getByTestId('executor-heat-row').focus();
    await user.keyboard('{Enter}');
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('三处 role=button 键盘处理一致：先 preventDefault 再导航（Space 分支）', () => {
    for (const rel of [
      'components/dashboard/ExecutorHeatBars.tsx',
      'components/dashboard/FailureTopList.tsx',
      'components/task-dag/DagCanvas.tsx',
    ]) {
      const src = read(rel);
      expect(src, `${rel} 缺少 role button 声明`).toMatch(/role=("button"|\{[^}]*'button')/);
      expect(src, `${rel} 缺少 preventDefault`).toContain('e.preventDefault()');
    }
    expect(read('components/dashboard/ExecutorHeatBars.tsx')).toContain("if (e.key === ' ') e.preventDefault();");
    expect(read('components/dashboard/FailureTopList.tsx')).toContain("if (e.key === ' ') e.preventDefault();");
    const dagCanvas = read('components/task-dag/DagCanvas.tsx');
    expect(dagCanvas).toContain("e.key === ' '");
    expect(dagCanvas).toContain('onNavigate(node.id)');
    expect(dagCanvas).toContain('onDoubleClick');
  });
});
