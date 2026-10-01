import { test, expect } from '@playwright/test';

/**
 * UI-09 移动端（375px）真机走查 —— TaskFormPage 提交链路。
 *
 * 断言口径（审计要求「真机断言从宽」）：375px 视口下 sticky 提交条与提交
 * 按钮**可见、可点**即可，不做像素级校验、不真正创建任务（避免对环境写
 * 入脏数据）。像素级布局由 UI-09 单测（ui09-mobile-pages.test.tsx）锚定
 * 渲染产物、人工巡检承担视觉验收。
 *
 * 登录方式对齐 functional.spec：API 取 token + 注入 zustand persist 格式
 * localStorage（绕过登录表单限流）。
 */

const BASE_URL = 'http://localhost:5176';
const API_URL = 'http://localhost:3105';
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'admin123';

test.describe('UI-09 移动端（375px）：TaskFormPage 提交链路', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('任务表单 sticky 提交条与「创建任务」按钮在 375px 下可见可点', async ({ page }) => {
    // —— 登录态准备（API 登录 + localStorage 注入，与 functional.spec 同源）——
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState('networkidle');

    const resp = await page.evaluate(
      async ({ apiUrl, user, pass }) => {
        const r = await fetch(`${apiUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: user, password: pass }),
        });
        return r.json();
      },
      { apiUrl: API_URL, user: ADMIN_USER, pass: ADMIN_PASS },
    );
    if (!resp?.data?.accessToken) {
      throw new Error(`登录失败（需本地 admin-api + admin/${ADMIN_PASS}）: ${JSON.stringify(resp).slice(0, 200)}`);
    }
    await page.evaluate(({ token, refresh }) => {
      const state = {
        state: { token, refreshToken: refresh, user: { id: 1, username: 'admin' } },
        version: 0,
      };
      localStorage.setItem('autoflow-auth', JSON.stringify(state));
    }, { token: resp.data.accessToken, refresh: resp.data.refreshToken ?? null });

    // —— 375px 打开新建任务页 ——
    await page.goto(`${BASE_URL}/tasks/new`);
    await page.waitForLoadState('domcontentloaded');
    const anchor = page.locator('[data-testid="task-form-anchor"]');
    await anchor.waitFor({ state: 'visible', timeout: 15_000 });

    // 提交条 sticky 常驻（375px 长表单无需滚到底）
    const bar = page.locator('[data-testid="task-form-submit-bar"]');
    await expect(bar).toBeVisible();

    // 提交按钮（admin）：可见且可点（enabled）。文案对齐 zh locale
    // taskForm.submit.create；为抗文案改动，按 primary 样式兜底定位。
    const submit = bar.locator('button.ant-btn-primary').first();
    await expect(submit).toBeVisible();
    await expect(submit).toBeEnabled();
  });
});
