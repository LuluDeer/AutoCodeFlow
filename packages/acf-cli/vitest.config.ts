import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // 默认 5s 在 Windows CI runner 上不够：本套件有多个**真实计时**用例
    // （`acf task trigger --wait` 的轮询断言刻意等 2~4s，见 commands.test.ts
    // 的 N10 用例），叠加 Windows runner 的模块加载开销后，一些**纯 mock**
    // 用例也会因为同一文件的执行被拖过 5s 而报
    // `Error: Test timed out in 5000ms`（PR #8 实测：同一个纯 mock 用例在
    // 本地 16s 内跑完全部 99 项，CI 上却单独超时）。
    // 该失败与被测逻辑无关，只反映 runner 性能，却会挡住发布门禁——故显式
    // 放宽到 20s（仍远低于任何真实挂死场景，不会掩盖真正的死循环）。
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
