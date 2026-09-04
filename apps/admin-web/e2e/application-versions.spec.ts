import { test, expect, Page } from '@playwright/test';

const appId = 'app-1';

function makeApp(version: string, gitCommit: string) {
  return {
    id: appId,
    name: 'demo-app',
    description: 'Demo application',
    version,
    runtime: 'node',
    status: 'active',
    gitRepo: 'https://example.com/demo.git',
    gitBranch: 'main',
    gitCommit,
    packageUrl: null,
    entrypoint: 'index.js',
    env: {},
    manifest: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-02T00:00:00.000Z',
  };
}

async function seedAuth(page: Page) {
  await page.goto('/login');
  await page.evaluate(() => {
    localStorage.setItem('autoflow-auth', JSON.stringify({
      state: {
        token: 'test-token',
        refreshToken: 'refresh-token',
        user: { id: 1, username: 'admin', role: 'admin' },
      },
      version: 0,
    }));
  });
}

test.describe('Application version history', () => {
  test('marks current version from application state and refreshes after rollback', async ({ page }) => {
    let currentVersion = '2.0.0';
    let currentCommit = 'def4567890';
    let rollbackCount = 0;

    await seedAuth(page);

    await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, data: { items: [], total: 0 } }),
      });
    });

    await page.route((url) => url.pathname === '/api/applications/app-1', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, data: makeApp(currentVersion, currentCommit) }),
      });
    });

    await page.route((url) => url.pathname === '/api/applications/app-1/versions', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: [
            {
              id: 'version-2',
              deploymentId: null,
              sourceDeploymentId: null,
              version: '2.0.0',
              commit: 'def4567890',
              status: 'released',
              deployedAt: '2024-01-02T00:00:00.000Z',
              createdAt: '2024-01-02T00:00:00.000Z',
              executorAddress: null,
              deployCount: 1,
              snapshot: { version: '2.0.0' },
            },
            {
              id: 'deploy-1',
              deploymentId: 'deploy-1',
              sourceDeploymentId: 'deploy-1',
              version: '1.0.0',
              commit: 'abc1234567',
              status: 'released',
              deployedAt: '2024-01-01T00:00:00.000Z',
              createdAt: '2024-01-01T00:00:00.000Z',
              executorAddress: 'executor:3001',
              deployCount: 1,
            },
          ],
        }),
      });
    });

    await page.route((url) => url.pathname === '/api/applications/app-1/rollback/deploy-1', async (route) => {
      rollbackCount += 1;
      currentVersion = '1.0.0';
      currentCommit = 'abc1234567';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: { ok: true, rolledBackTo: '1.0.0', total: 1, succeeded: 1, failed: 0 },
        }),
      });
    });

    await page.goto(`/applications/${appId}?tab=versions`);

    await expect(page.getByRole('heading', { name: 'demo-app' })).toBeVisible();
    const v2Row = page.locator('tr').filter({ hasText: '2.0.0' }).filter({ hasText: 'def45678' });
    const v1Row = page.locator('tr').filter({ hasText: '1.0.0' }).filter({ hasText: 'abc12345' });

    await expect(v2Row.getByText('当前版本')).toBeVisible();
    await expect(v1Row.getByRole('button', { name: /回\s*滚/ })).toBeVisible();

    await v1Row.getByRole('button', { name: /回\s*滚/ }).click();
    await page.getByRole('button', { name: '确认回滚' }).last().click();

    await expect.poll(() => rollbackCount).toBe(1);
    await expect(v1Row.getByText('当前版本')).toBeVisible();
    await expect(v2Row.getByRole('button', { name: /回\s*滚/ })).toBeVisible();
    await expect(page.locator('body')).toContainText('已回滚到 1.0.0');
  });
});
