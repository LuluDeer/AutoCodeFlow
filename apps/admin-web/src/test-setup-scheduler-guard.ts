// ── F-21（UIAUDIT P3）scheduler Immediate 守卫：本文件必须是 setupFiles[0] ──
//
// 根因（两层，为什么包裹必须放在独立的零 import 文件里跑在最前）：
// 1) react-dom 的 scheduler 在**模块加载时**捕获 setImmediate 引用
//    （scheduler.development.js 顶层 localSetImmediate = setImmediate），
//    之后再改 globalThis.setImmediate 对它无效；
// 2) ESM 的 import 提升：test-setup.ts 文件体执行前，它的 import
//    （@testing-library/react → react-dom → scheduler）已先完成——
//    在该文件体里包裹永远晚于 scheduler 的捕获。
// 故把包裹拆到本文件：零 import、setupFiles 顺序最前，保证 scheduler
// 捕获到的就是这里的 wrapped 版本。
//
// wrapped 做两件事：
// · 维护「已排队未执行」深度计数（test-setup.ts 的 afterEach 据此把
//   Immediate 队列排空——见该文件 F-21 注释）；
// · 吞掉 teardown 形态的 ReferenceError（window/document 等已删除全局）。
//   只匹配消息白名单的精确形态，被测/测试代码自身的 ReferenceError 照常
//   抛出——这是 jsdom 拆卸伪影，不是任何被测行为的信号。
const gImmediate = globalThis as unknown as {
  setImmediate: typeof setImmediate;
  __acfRawSetImmediate?: typeof setImmediate;
  __acfImmediateDepth?: { n: number };
};
if (!gImmediate.__acfRawSetImmediate) {
  const raw = gImmediate.setImmediate.bind(gImmediate);
  const depth = { n: 0 };
  const wrapped = ((fn: (...args: unknown[]) => void, ...rest: unknown[]) => {
    depth.n += 1;
    return raw((...args: unknown[]) => {
      depth.n -= 1;
      try {
        fn(...args);
      } catch (err) {
        const teardownArtifact =
          err instanceof ReferenceError &&
          /^(window|document|navigator|localStorage|location) is not defined$/.test(
            err.message,
          );
        if (!teardownArtifact) throw err;
      }
    }, ...rest);
  }) as typeof setImmediate;
  gImmediate.setImmediate = wrapped;
  gImmediate.__acfRawSetImmediate = raw;
  gImmediate.__acfImmediateDepth = depth;
}
