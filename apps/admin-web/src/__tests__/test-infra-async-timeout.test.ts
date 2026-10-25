import { describe, it, expect } from 'vitest';
// 探针用例刻意走 @testing-library/react 入口——162 处测试导入全部经它拿
// waitFor/findBy（0 处直接 import '@testing-library/dom'），「测试侧实例」
// 就是它内部持有的那份 dom。若改从 dom 入口断言，可能又踩回同一坑：
// 用例文件本身再加载出第三份实例，断言的不是被测对象。
import { getConfig } from '@testing-library/react';

// ── 测试基建守卫（2026-10-25，forks 池双模块实例根治）─────────────────
// test-setup.ts 曾从 '@testing-library/dom' 入口 configure(asyncUtilTimeout
// : 10_000)，但 forks 池下 setup 文件与测试文件走两条模块管线，加载出
// **两份不同的 dom 实例**——上轮探针实锤：setup 侧 = 10000，测试侧 = 1000
// （globalThis.__SETUP_DOM === domMod 为 false）。全仓「默认 waitFor」
// 实际都跑 1s 预算，历次「超时」假红反复复发即此根因。
//
// 修复：setup 改从 '@testing-library/react' 入口 configure——react 入口
// 内部 re-export 的 dom 与测试侧同实例（上轮已实测生效），且全仓 162 处
// 测试导入无一例外走 react 入口，不存在绕过该实例的消费者。
//
// 本用例把「全局 10s 生效」钉死：配置漂移 / 升级改变模块拓扑 / 有人改回
// dom 入口，都会让 1000 复活、此处变红——防止静默失效。
describe('test infra: global asyncUtilTimeout takes effect on the test-side dom instance', () => {
  it('getConfig().asyncUtilTimeout === 10000 (setup configure reaches tests)', () => {
    expect(getConfig().asyncUtilTimeout).toBe(10_000);
  });
});
