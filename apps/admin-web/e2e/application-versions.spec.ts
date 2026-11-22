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
    // 中文断言需要显式语言种子：detectLanguage 无该键时默认英文（与 R293 agent spec 同款）。
    localStorage.setItem('autoflow-lang', 'zh');
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
    let setCurrentCount = 0;

    await seedAuth(page);

    await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, data: { items: [], total: 0 } }),
      });
    });

    // 顶栏 InboxBadge 的轮询路由：必须在通配之后注册（Playwright route 为 LIFO，
    // 后注册者优先命中），否则会被通配的 `{items:[],total:0}` Shape 打中并让前端
    // 解包崩溃（w.filter is not a function）——与 R293 修复同批路由。
    // 以下 3 条 shape 与前端消费对齐（CodeGraph 已核实）：
    //  - inbox/counts：AgentInboxCountsResponseDto (agent-inbox.dto.ts:117)，readInboxCounts (inbox.ts:498)
    //  - clarifications/pending：readSopClarificationTotal (inbox.ts:678) 读 res.total
    //  - assignments/lagging：readSopBlockedTotal (inbox.ts:796) 读 res.total
    //  另 2 条数组路由见下方：前端按数组消费，通配对象兜底会让 `.filter` 崩溃
    //  （与 R293 agent spec 的 `reply(route, [])` 同款）。
    await page.route((url) => url.pathname === '/api/metrics/failures', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, data: [] }),
      });
    });

    await page.route((url) => url.pathname === '/api/projects', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, data: [] }),
      });
    });

    await page.route((url) => url.pathname === '/api/executors', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, data: [] }),
      });
    });

    await page.route((url) => url.pathname === '/api/agent/inbox/counts', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, data: {
          pendingApprovals: 0,
          waitingSessions: 0,
          stalled: 0,
          backlogged: 0,
          backlogTruncated: false,
          deployments: 0,
          queueStall: 0,
          failedSessions: 0,
          failedWindowHours: 24,
          degraded: false,
        } }),
      });
    });

    await page.route((url) => url.pathname === '/api/sop/clarifications/pending', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, data: {
          items: [], data: [], total: 0, returned: 0, truncated: false, degraded: false,
        } }),
      });
    });

    await page.route((url) => url.pathname === '/api/sop/assignments/lagging', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, data: {
          items: [], data: [], total: 0, returned: 0, truncated: false, degraded: false,
        } }),
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

    // R1 部署模型：旧「回滚」已拆为「设为当前版本」（只恢复字段、不下发设备）。
    await page.route((url) => url.pathname === '/api/applications/app-1/set-current-version', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      setCurrentCount += 1;
      currentVersion = '1.0.0';
      currentCommit = 'abc1234567';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: { ok: true, dispatched: false, version: '1.0.0', versionId: 'version-1' },
        }),
      });
    });

    await page.goto(`/applications/${appId}?tab=versions`);

    await expect(page.getByRole('heading', { name: 'demo-app' })).toBeVisible();
    const v2Row = page.locator('tr').filter({ hasText: '2.0.0' }).filter({ hasText: 'def45678' });
    const v1Row = page.locator('tr').filter({ hasText: '1.0.0' }).filter({ hasText: 'abc12345' });

    await expect(v2Row.getByText('当前版本')).toBeVisible();
    await expect(v1Row.getByRole('button', { name: '设为当前版本' })).toBeVisible();

    await v1Row.getByRole('button', { name: '设为当前版本' }).click();
    await page.getByRole('button', { name: '确认设置' }).last().click();

    await expect.poll(() => setCurrentCount).toBe(1);
    await expect(v1Row.getByText('当前版本')).toBeVisible();
    await expect(v2Row.getByRole('button', { name: '设为当前版本' })).toBeVisible();
    await expect(page.locator('body')).toContainText('已设为当前版本 1.0.0');
  });
});
