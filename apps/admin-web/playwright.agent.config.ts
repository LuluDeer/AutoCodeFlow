import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Standalone, deterministic smoke test: build the real SPA, but use only the
// browser suite's API fixtures. Never reuse a running development server.
const port = 4176;
const baseURL = `http://127.0.0.1:${port}`;
const outDir = 'node_modules/.cache/agent-journey-dist';
export default defineConfig({
  ...base,
  testMatch: '**/agent-session-journey.spec.ts',
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
