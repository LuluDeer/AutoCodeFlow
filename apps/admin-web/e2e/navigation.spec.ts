import { test, expect } from '@playwright/test';

test.describe('Navigation', () => {
  test('root redirects to login when not authenticated', async ({ page }) => {
    await page.goto('/');
    // 断言重定向目标路径而非具体端口/主机：未登录的根路由应落到 /login。
    // 用 domcontentloaded + URL 显式等待，规避 networkidle 在 SSE/轮询页的不稳定。
    await page.waitForURL(/\/login(?:\?|$)/);
    const pathname = new URL(page.url()).pathname;
    expect(pathname).toBe('/login');
  });

  test('login page has title or heading', async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('domcontentloaded');
    const title = await page.title();
    expect(title.length).toBeGreaterThan(0);
  });

  test('login page contains form elements', async ({ page }) => {
    await page.goto('/login');
    // 登录页是 lazy route：domcontentloaded 时可能仍显示 PageFallback 骨架屏。
    // 显式等真实表单控件挂载，避免 count() 断言跑在骨架屏上；等到的必须是
    // 带对应 aria-label 的用户名/密码输入框（antd Input/Input.Password）。
    const username = page.getByLabel(/用户名|username/i);
    const password = page.getByLabel(/密码|password/i);
    await expect(username).toBeVisible();
    await expect(password).toBeVisible();
    // 必须是提交按钮，而非骨架屏占位或任意 button。
    await expect(page.getByRole('button', { name: /登录|login|sign in/i })).toBeVisible();
  });

  test('no JS errors on login page', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    expect(errors.filter(e => !e.includes('favicon'))).toHaveLength(0);
  });
});
