import { test, expect } from '@playwright/test';

// Set localStorage token before each protected-page test
async function setAuthStorage(page: any) {
  await page.context().addInitScript(() => {
    window.localStorage.setItem('access_token', 'fake-token');
    window.localStorage.setItem(
      'user',
      JSON.stringify({ id: 1, username: 'admin', role: 'admin' })
    );
  });
}

test.describe('Page rendering smoke tests', () => {
  test('login page loads without crash', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/login');
    await page.waitForLoadState('domcontentloaded');
    // Filter out known irrelevant errors
    const fatal = errors.filter(
      (e) => !e.includes('favicon') && !e.includes('401') && !e.includes('403')
    );
    expect(fatal).toHaveLength(0);
    // Page should render something
    const body = await page.locator('body').textContent();
    expect(body!.length).toBeGreaterThan(0);
  });

  test('dashboard page loads (may redirect to login)', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/dashboard');
    await page.waitForLoadState('domcontentloaded');
    const fatal = errors.filter(
      (e) => !e.includes('favicon') && !e.includes('401') && !e.includes('403')
    );
    expect(fatal).toHaveLength(0);
    const url = page.url();
    expect(url).toMatch(/localhost:5176/);
  });

  test('tasks page loads (may redirect to login)', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/tasks');
    await page.waitForLoadState('domcontentloaded');
    const fatal = errors.filter(
      (e) => !e.includes('favicon') && !e.includes('401') && !e.includes('403')
    );
    expect(fatal).toHaveLength(0);
  });

  test('executors page loads (may redirect to login)', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/executors');
    await page.waitForLoadState('domcontentloaded');
    const fatal = errors.filter(
      (e) => !e.includes('favicon') && !e.includes('401') && !e.includes('403')
    );
    expect(fatal).toHaveLength(0);
  });

  test('non-existent route does not crash', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/this-route-does-not-exist-xyz');
    await page.waitForLoadState('domcontentloaded');
    const fatal = errors.filter(
      (e) => !e.includes('favicon') && !e.includes('401') && !e.includes('403')
    );
    expect(fatal).toHaveLength(0);
    // Should render something (404 page or redirect)
    const body = await page.locator('body').textContent();
    expect(body!.length).toBeGreaterThan(0);
  });
});
