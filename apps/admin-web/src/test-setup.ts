import { vi, afterEach } from 'vitest';
// ⚠️ configure 必须从 '@testing-library/react' 入口拿（TINFRA-1，2026-10-25）：
// forks 池下 setup 文件与测试文件走两条模块管线，从 '@testing-library/dom'
// 入口 configure 会加载出与测试侧不同的另一份 dom 实例，全局 10s 从未生效
// （探针实证：setup 侧 = 10000、测试侧 = 1000）。react 入口 re-export 的
// configure 操作的正是测试侧同一实例（162 处测试导入全部经 react 入口）。
// 守卫用例 src/__tests__/test-infra-async-timeout.test.ts 钉住该值。
import { configure, act } from '@testing-library/react';

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

// ── 界面语言统一钉为 zh（LANG-DEFAULT，本轮）──────────────────────────
// 背景：`detectLanguage()`（src/i18n/index.ts）的默认语言已按产品要求改为
// **优先跟随浏览器语言、其次默认英文**。而 jsdom 的 `navigator.language` 是
// `en-US`、且 localStorage 为空，于是测试进程会判定成 **英文**——但本仓绝大多数
// 用例断言的是**中文**文案（它们写于「默认中文」的年代，如
// task-detail-maintenance / app-deployment-* 等 119 个文件）。
//
// 为什么在 setup 里统一钉、而不是逐个测试文件加 `setLanguage('zh')`：
//   · 这是**环境**属性（"测试进程跑在中文界面下"），不是某个用例的语义；
//     逐个加会有 119 处重复，且新增用例极易忘记而再次大面积变红；
//   · 与上方 matchMedia 桩同款理由——在 jsdom 就绪后**单点**建立确定的基线。
//
// 需要在英文界面下断言文案的用例（i18n-infra / shortcut-help-modal /
// error-code-i18n 等）自行调用 `await setLanguage('en')` 覆盖本基线，行为不变。
//
// ⚠️ 必须做存在性判断：本 setup 是**全局**的，而个别测试文件带
// `// @vitest-environment node`（如 monaco-first-paint.perf01.test.ts），
// 那种环境下没有 localStorage——直接调用会以
// `ReferenceError: localStorage is not defined` 让该套件**整个无法加载**
// （no tests，而非 skip）。node 环境下没有 localStorage 也就不存在
// detectLanguage 的持久化分支，故跳过本基线是正确的。
if (typeof localStorage !== 'undefined') {
  localStorage.setItem('autoflow-lang', 'zh');
}

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
