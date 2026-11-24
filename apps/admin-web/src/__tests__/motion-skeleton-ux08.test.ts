/**
 * B4 质感横切收口守卫（波2）：
 *  ① 动效令牌：index.css 定义 --motion-fast/normal/slow/easing，既有过渡引用令牌；
 *  ③ reduced-motion：全局 prefers-reduced-motion 块覆盖 transition / animation /
 *     迭代次数 / 平滑滚动（纯 CSS，不动焦点环）；
 *  ② 骨架判据：shouldShowPageSkeleton 共享纯函数的四态判定。
 *
 * 反证口径（变异红 → 逐字节还原绿演练见交付记录）：
 *  · 把谓词 `count === 0` 改成 `count > 0` → 首屏用例变红；
 *  · 删掉任一 --motion-* 令牌或 reduced-motion 覆写行 → 对应源码断言变红。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shouldShowPageSkeleton } from '../components/PageSkeleton';

const SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf-8');

const INDEX_CSS = read('index.css');

describe('② 骨架判据：shouldShowPageSkeleton 四态', () => {
  it('首屏在途（无数据、未出错）→ 骨架', () => {
    expect(shouldShowPageSkeleton(true, null, 0)).toBe(true);
    expect(shouldShowPageSkeleton(true, undefined, 0)).toBe(true);
  });

  it('已有数据（翻页/刷新态）→ 不走骨架，保留表格内建 loading', () => {
    expect(shouldShowPageSkeleton(true, null, 5)).toBe(false);
  });

  it('请求出错 → 不走骨架（交错误态/StateError 承接）', () => {
    expect(shouldShowPageSkeleton(true, new Error('boom'), 0)).toBe(false);
  });

  it('请求已结束（即便无数据）→ 不走骨架（交真空态/筛选空态承接）', () => {
    expect(shouldShowPageSkeleton(false, null, 0)).toBe(false);
  });
});

describe('① 动效令牌：index.css 收敛时长/缓动变量', () => {
  it('四枚 motion 令牌均已定义', () => {
    expect(INDEX_CSS).toContain('--motion-fast: 150ms');
    expect(INDEX_CSS).toContain('--motion-normal: 200ms');
    expect(INDEX_CSS).toContain('--motion-slow: 300ms');
    expect(INDEX_CSS).toContain('--motion-easing: ease');
  });

  it('既有主题/侧栏过渡引用令牌，不再裸写时长', () => {
    expect(INDEX_CSS).toContain('background-color var(--motion-normal) var(--motion-easing)');
    expect(INDEX_CSS).toContain('border-color var(--motion-normal) var(--motion-easing)');
    expect(INDEX_CSS).toContain('transform var(--motion-slow) var(--motion-easing)');
    // index.css 活规则里不得再残留裸时长过渡（死代码 App.css 不在本文件内）
    expect(INDEX_CSS).not.toMatch(/transition:[^;]*(200ms|0\.25s|0\.3s)/);
  });
});

describe('③ reduced-motion：全局降级块覆盖动效与平滑滚动', () => {
  it('存在 prefers-reduced-motion 媒体查询', () => {
    expect(INDEX_CSS).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('覆盖 transition / animation 时长、动画迭代次数与平滑滚动', () => {
    expect(INDEX_CSS).toContain('transition-duration: 0.01ms !important');
    expect(INDEX_CSS).toContain('animation-duration: 0.01ms !important');
    expect(INDEX_CSS).toContain('animation-iteration-count: 1 !important');
    expect(INDEX_CSS).toContain('scroll-behavior: auto !important');
  });
});
