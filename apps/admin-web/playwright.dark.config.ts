import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// 暗色主题 parity 取证入口（离线 stub + vite dev，与 playwright.smoke.config.ts 对称）。
// 独立端口 4179（避开 smoke 4177 / dev 5176 / 8088），不复用运行中的开发服务器、
// 不污染权威套件。testMatch 仅圈定 e2e/dark-parity.spec.ts；既有 smoke/agent 等
// 配置与 spec 一律不动。系统 chrome 通道由 PLAYWRIGHT_CHROMIUM_CHANNEL 显式开启，
// 未设置时回落 Playwright 自带 chromium。
// 注：本机低内存下生产 rolldown build 必崩（0xC0000409），用户明令禁 Windows 生产构建，
// 故 webServer 直接起 vite dev（按需转换、峰值内存低），不预构建 dist、不走 preview。
const port = 4179;
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  ...base,
  testMatch: /e2e\/dark-parity\.spec\.ts$/,
  use: { ...base.use, baseURL },
  projects: base.projects?.map(project => ({
    ...project,
    // 默认走 Playwright 自带 headless-shell（1.65 对应 1254，已 install 就位）；
    // 系统 Chrome 157 过新，CDP 驱动侧栈溢出，不用其通道。需要时可用
    // PLAYWRIGHT_CHROMIUM_CHANNEL 覆盖。
    use: { ...project.use, channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || undefined },
  })),
  webServer: {
    // 起 vite dev（生产 build 在本机低内存下 rolldown 原生崩溃，已验证不可用；dev 按需转换峰值低）。
    // 不跑 tsc -b，收口类型门禁由编排方统一执行。
    command: `npx vite dev --host 127.0.0.1 --port ${port} --strictPort`,
    env: { VITE_API_URL_INTERNAL: '/api', VITE_API_URL_EXTERNAL: '' },
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
