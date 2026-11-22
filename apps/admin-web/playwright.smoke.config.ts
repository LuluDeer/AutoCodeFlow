import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// navigation.spec.ts / pages.spec.ts 的离线 smoke 验收入口（正式保留）。
// 与 playwright.agent.config.ts、playwright.appversions.config.ts 对称：自带
// build+preview 的离线环境、系统 chrome 通道（PLAYWRIGHT_CHROMIUM_CHANNEL）、
// 独立端口 4177，不复用运行中的开发服务器、不污染权威套件。
// testMatch 限定这两个无自带 webServer 的渲染 smoke spec；端口写在此处而非
// spec 里，spec 的断言一律用 pathname/URL 派生，保持环境无关。
const port = 4177;
const baseURL = `http://127.0.0.1:${port}`;
const outDir = 'node_modules/.cache/smoke-dist';
export default defineConfig({
  ...base,
  testMatch: /e2e\/(navigation|pages)\.spec\.ts$/,
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
