import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// application-versions.spec.ts 的独立浏览器级验收入口（正式保留）。
// 与 playwright.agent.config.ts 对称：自带 build+preview 的离线环境、系统 chrome
// 通道（PLAYWRIGHT_CHROMIUM_CHANNEL）、独立端口 4178，不复用运行中的开发服务器、
// 不污染权威套件。仅用于该 spec 的独立验收。
const port = 4178;
const baseURL = `http://127.0.0.1:${port}`;
const outDir = 'node_modules/.cache/app-versions-dist';
export default defineConfig({
  ...base,
  testMatch: '**/application-versions.spec.ts',
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
