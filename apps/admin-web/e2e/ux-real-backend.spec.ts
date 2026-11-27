import { test, expect, type Page } from '@playwright/test';

const USERNAME = process.env.UX_E2E_USERNAME || 'admin';
const PASSWORD = process.env.UX_E2E_PASSWORD || 'admin123';

async function login(page: Page) {
  await page.goto('/login');
  await page.locator('input[autocomplete="username"]').fill(USERNAME);
  await page.locator('input[autocomplete="current-password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/dashboard(?:\?|$)/, { timeout: 20_000 });
}

test.describe('UX authoritative browser-real walkthrough', () => {
  test('真后端登录后可访问关键用户路径', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await login(page);
    expect(await page.evaluate(() => !!localStorage.getItem('autoflow-auth'))).toBe(true);

    for (const path of [
      '/dashboard',
      '/tasks',
      '/tasks/t-1001/edit',
      '/executors/install',
      '/capabilities',
      '/activation-stats',
      '/workbench',
      '/sops/from-video',
      '/inbox',
      '/this-route-does-not-exist-ux',
    ]) {
      await page.goto(path);
      await page.waitForLoadState('domcontentloaded');
      expect(new URL(page.url()).pathname, `path ${path}`).toBe(path);
      expect((await page.locator('body').textContent())?.length ?? 0, `body ${path}`).toBeGreaterThan(10);
    }

    expect(errors, errors.join('\n')).toEqual([]);
  });
});
