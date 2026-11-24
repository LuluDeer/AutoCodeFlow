import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// 部署定位深链（桌面复制 → 中台行级定位）的真浏览器验收入口。
// 与 playwright.appversions.config.ts 对称：自带 build+preview 的离线环境、系统
// chrome 通道（PLAYWRIGHT_CHROMIUM_CHANNEL）、独立端口 4179，不复用开发服务器、
// 不污染权威套件。仅用于 deploy-locator-deeplink.spec.ts 的独立验收。
const port = 4179;
const baseURL = `http://127.0.0.1:${port}`;
const outDir = 'node_modules/.cache/deeplink-dist';
export default defineConfig({
  ...base,
  testMatch: '**/deploy-locator-deeplink.spec.ts',
  use: { ...base.use, baseURL },
  projects: base.projects?.map(project => ({
    ...project,
    use: { ...project.use, channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || undefined },
  })),
  webServer: {
    command: `npm run build -- --outDir ${outDir} && npm run preview -- --outDir ${outDir} --host 127.0.0.1 --port ${port} --strictPort`,
    env: { VITE_API_URL_INTERNAL: '/api', VITE_API_URL_EXTERNAL: '' },
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
