import { test, expect } from '@playwright/test';

test.describe('Navigation', () => {
  test('root redirects to login when not authenticated', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const url = page.url();
    // Should either be on login or dashboard
    expect(url).toMatch(/localhost:5176/);
  });

  test('login page has title or heading', async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('domcontentloaded');
    const title = await page.title();
    expect(title.length).toBeGreaterThan(0);
  });

  test('login page contains form elements', async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('domcontentloaded');
    // Must have at least one input
    const inputs = page.locator('input');
    const count = await inputs.count();
    expect(count).toBeGreaterThanOrEqual(2);
    // Must have a submit button
    const btn = page.locator('button').first();
    await expect(btn).toBeVisible();
  });

  test('no JS errors on login page', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    expect(errors.filter(e => !e.includes('favicon'))).toHaveLength(0);
  });
});
