import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// B3 可视化升级取证入口（离线 stub + vite dev，与 b2/onboarding 配置对称）。
// 独立端口 4182（避开 smoke 4177 / agent 4176 / appversions 4178 / dark 4179 /
// onboarding 4180 / b2 4181 / dev 5176 / 8088），不复用运行中的开发服务器。
// 注：本机低内存下生产 rolldown build 必崩（0xC0000409），用户明令禁 Windows 生产
// 构建，故 webServer 直接起 vite dev（按需转换、峰值内存低），不预构建 dist。
const port = 4182;
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  ...base,
  testMatch: /e2e\/b3-timeline-trend\.spec\.ts$/,
  use: { ...base.use, baseURL },
  projects: base.projects?.map(project => ({
    ...project,
    use: { ...project.use, channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || undefined },
  })),
  webServer: {
    command: `npx vite dev --host 127.0.0.1 --port ${port} --strictPort`,
    env: { VITE_API_URL_INTERNAL: '/api', VITE_API_URL_EXTERNAL: '' },
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
