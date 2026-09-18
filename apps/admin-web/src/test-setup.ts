import { vi, afterEach } from 'vitest';
import { configure } from '@testing-library/dom';
import { act } from '@testing-library/react';

// ── waitFor 默认预算统一（O-2，测试体系审计 2026-09-18）──────────────
// 全量跑（95 文件 jsdom + antd 重型页面 + coverage 仪器化）时，transform/
// import 累计数百秒，首轮渲染用例在空闲机 0.3~2s、并发/仪器化下远超 1s。
// 实测三处证据（同一 HEAD）：
//   * vitest 默认 testTimeout=5s → 空闲 2 红 / 中等负载 14 红 / 高负载 31 红；
//   * 抬至 30s 后 83/83、725/725 全绿；
//   * coverage 仪器化重跑：task-list-deep / task-template-prefill /
//     task-form-ui06 的 waitFor（默认 1s）与 15s 硬编码预算先后超时。
// 本文件统一两套 waitFor 的默认预算到 10s：
//   ① vi.waitFor（vitest 自带，默认 1000ms 且不可配置）——包装为默认 10s，
//      显式传入 timeout 的调用保持原样（...options 在后，显式值覆盖默认值）；
//   ② @testing-library/dom 的 waitFor（默认 1000ms）——configure 全局生效。
// 负向用例（断言"永不发生"）请用 queryBy* + expect 直断，勿依赖 waitFor
// 快速抛错；确需快速失败的 waitFor 应显式传小 timeout。
const originalWaitFor = vi.waitFor;
// vitest 的 waitFor 第二参是 `number | WaitForOptions | undefined`：number 是
// 「整体 timeout」简写形态，不可展开（直接 spread 会触发 TS2698）。这里先按
// 形态归一为对象，再套用 10s 默认 timeout——显式传参（含 number 简写）照旧生效。
type WaitForOptionsArg = Parameters<typeof originalWaitFor>[1];
type WaitForOptionsObj = Exclude<WaitForOptionsArg, number | undefined>;
vi.waitFor = ((callback: () => unknown, options?: WaitForOptionsArg) => {
  const merged: WaitForOptionsObj =
    typeof options === 'number' ? { timeout: options } : { timeout: 10_000, ...options };
  return originalWaitFor(callback, merged);
}) as typeof vi.waitFor;

configure({ asyncUtilTimeout: 10_000 });

// ── matchMedia 统一桩（R12：149 处测试文件顶层 `if (!window.matchMedia)`
//    在 forks 池 + coverage 仪器化下存在「模块加载先于 jsdom 就绪」的窗口期，
//    第十轮 admin-web-build 的 Unhandled ReferenceError: window is not defined
//    即此模式命中。setup 在 jsdom 环境就绪后执行，window 恒存在，故统一在此
//    建立桩，测试文件无需再在模块顶层碰 window。──
if (typeof window !== 'undefined' && !window.matchMedia) {
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

// ── React 并发渲染残留 flush（R12：第十/十一轮 admin-web-build 的
//    Unhandled ReferenceError: window is not defined 源于 react-dom
//    scheduler 的宏任务（MessageChannel）在测试文件结束、jsdom teardown
//    后才执行——prepareForCommit → getActiveElementDeep 访问已销毁的
//    window。CI 高负载（transform/import 数百秒、coverage 仪器化）下
//    React 并发根节点的未完成渲染更容易拖到 teardown 后。这里在每个测试
//    结束后显式排空宏任务队列 + flush React 更新，使 teardown 时无残留
//    scheduler 工作。──
afterEach(async () => {
  // 排空宏任务队列：React 的 concurrent commit 是多轮 MessageChannel 派发，
  // 单轮 setTimeout(0) 可能只执行完一轮 workLoop。这里连排多轮，确保
  // pending 的 commit/effect 链完全落地后才让 vitest 进入 jsdom teardown。
  for (let i = 0; i < 5; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  // 再 flush 一轮 React 更新（act 包裹的同步+微任务部分）。
  await act(async () => {});
});
