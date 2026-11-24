import { test, expect, Page } from '@playwright/test';

// 桌面复制部署定位 → 中台 URL 深链行级定位：真浏览器级验收。
// 只用某行已知 deploymentId + 另一个 version 证明「deploymentId 优先」；
// 每例收集 pageerror，末尾断言为空（中性降级路径要求页面不崩）。
const appId = 'app-1';
const DEPLOY_UUID = '11111111-1111-4111-8111-111111111111';
const OTHER_UUID = '22222222-2222-4222-8222-222222222222';
const TABLE = '[data-testid="releases-table"]';
const ROWS = `${TABLE} .ant-table-tbody tr`;

function makeApp() {
  return {
    id: appId,
    name: 'demo-app',
    description: 'Demo application',
    version: '2.0.0',
    runtime: 'node',
    status: 'active',
    gitRepo: 'https://example.com/demo.git',
    gitBranch: 'main',
    gitCommit: '22222222',
    packageUrl: null,
    entrypoint: 'index.js',
    env: {},
    manifest: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-02T00:00:00.000Z',
  };
}

/** 与 AppReleaseRow 逐字段对齐（apps/admin-web/src/api/applications.ts:129）。 */
function releaseRow(over: Record<string, unknown> = {}) {
  return {
    id: 'ver-2',
    version: '2.0.0',
    packageUrl: null,
    gitCommit: '22222222',
    deployedAt: '2024-01-02T00:00:00.000Z',
    latestDeploymentId: DEPLOY_UUID,
    deploymentStatus: 'running',
    deploymentCount: 1,
    executorAddress: 'executor:3002',
    runMode: 'daemon',
    triggerType: 'manual',
    operator: null,
    operatorSource: 'application_versions.createdBy',
    operatorMissingReason: 'not populated by any write path',
    sourceDeploymentId: DEPLOY_UUID,
    status: 'released',
    createdAt: '2024-01-02T00:00:00.000Z',
    synthetic: false,
    ...over,
  };
}

const releaseRows = [
  releaseRow(),
  releaseRow({
    id: 'ver-1',
    version: '1.0.0',
    gitCommit: '11111111',
    latestDeploymentId: OTHER_UUID,
    sourceDeploymentId: OTHER_UUID,
    deploymentStatus: 'stopped',
    deploymentCount: 3,
    runMode: 'once',
    triggerType: 'upgrade',
    deployedAt: '2024-01-01T00:00:00.000Z',
    createdAt: '2024-01-01T00:00:00.000Z',
  }),
  releaseRow({
    id: 'ver-0',
    version: '0.9.0',
    gitCommit: '00000000',
    latestDeploymentId: null,
    sourceDeploymentId: null,
    deploymentStatus: null,
    deploymentCount: 0,
    executorAddress: null,
    runMode: null,
    triggerType: null,
    deployedAt: null,
    createdAt: '2023-12-31T00:00:00.000Z',
  }),
];

async function seedAuth(page: Page) {
  await page.goto('/login');
  await page.evaluate(() => {
    // 中文断言需要显式语言种子：detectLanguage 无该键时默认英文。
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

async function seedApi(page: Page) {
  // 通配兜底先注册；Playwright route 为 LIFO，后面注册的具体路由优先命中。
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: { items: [], total: 0 } }),
    });
  });

  // 顶栏 InboxBadge 轮询路由：数组/对象 shape 必须与前端消费对齐，否则
  // 通配的 `{items:[],total:0}` 会让 `w.filter is not a function` 崩溃。
  // 与 application-versions.spec.ts:57-80 同批路由（LIFO：均在通配之后）。
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

  // 应用详情：GET /applications/:id。
  await page.route((url) => url.pathname === `/api/applications/${appId}`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: makeApp() }),
    });
  });

  // 发布行：GET /applications/:id/releases（AppReleasesPage 信封，data 为行数组）。
  await page.route((url) => url.pathname === `/api/applications/${appId}/releases`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: {
        data: releaseRows,
        total: releaseRows.length,
        page: 1,
        pageSize: 20,
        truncated: false,
        retainedButTruncated: [],
      } }),
    });
  });

  // releases Tab 内嵌事件流：GET /app-deployments/applications/:id/events。
  await page.route(
    (url) => url.pathname === `/api/app-deployments/applications/${appId}/events`,
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, data: { data: [], total: 0, page: 1, pageSize: 20 } }),
      });
    },
  );
}

/** 行定位：不改源码加 testid，用稳定表格容器 + 行内 version 文本。 */
function rowFor(page: Page, version: string) {
  return page.locator(ROWS).filter({ hasText: version }).first();
}

async function openReleases(page: Page, query = '?tab=releases') {
  await page.goto(`/applications/${appId}${query}`);
  await expect(page.locator(TABLE)).toBeVisible();
  // 三行都渲染完成再断言命中态，避免把「还没加载」误判成「中性降级」。
  await expect(rowFor(page, '2.0.0')).toBeVisible();
  await expect(rowFor(page, '1.0.0')).toBeVisible();
  await expect(rowFor(page, '0.9.0')).toBeVisible();
}

function expectNoPageErrors(errors: Error[]) {
  expect(errors.map((e) => e.message)).toEqual([]);
}

test.describe('部署定位深链 → 发布行级定位（真浏览器）', () => {
  test('(a) deploymentId 优先于 version：UUID 所在行命中并带锚点 id', async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (err) => pageErrors.push(err));
    await seedApi(page);
    await seedAuth(page);

    // version 故意指向 1.0.0 行，deploymentId 属于 2.0.0 行 → 证明优先级。
    const query = `?tab=releases&deploymentId=${encodeURIComponent(DEPLOY_UUID)}&version=${encodeURIComponent('1.0.0')}`;
    await openReleases(page, query);

    await expect(page.locator(`${TABLE} .app-release-deploy-hit`)).toHaveCount(1);
    const hitRow = rowFor(page, '2.0.0');
    await expect(hitRow).toHaveClass(/app-release-deploy-hit/);
    await expect(hitRow).toHaveAttribute('id', /^app-release-deploy-/);
    await expect(rowFor(page, '1.0.0')).not.toHaveClass(/app-release-deploy-hit/);
    await expect(rowFor(page, '0.9.0')).not.toHaveClass(/app-release-deploy-hit/);
    expectNoPageErrors(pageErrors);
  });

  test('(b) 仅 version 深链命中对应版本行', async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (err) => pageErrors.push(err));
    await seedApi(page);
    await seedAuth(page);

    await openReleases(page, `?tab=releases&version=${encodeURIComponent('1.0.0')}`);

    await expect(page.locator(`${TABLE} .app-release-deploy-hit`)).toHaveCount(1);
    const hitRow = rowFor(page, '1.0.0');
    await expect(hitRow).toHaveClass(/app-release-deploy-hit/);
    await expect(hitRow).toHaveAttribute('id', /^app-release-deploy-/);
    await expect(rowFor(page, '2.0.0')).not.toHaveClass(/app-release-deploy-hit/);
    await expect(rowFor(page, '0.9.0')).not.toHaveClass(/app-release-deploy-hit/);
    expectNoPageErrors(pageErrors);
  });

  test('(c) 非法 deploymentId + 缺失 version：中性降级、页面不崩', async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (err) => pageErrors.push(err));
    await seedApi(page);
    await seedAuth(page);

    await openReleases(page, '?tab=releases&deploymentId=not-a-uuid');

    await expect(page.locator(`${TABLE} .app-release-deploy-hit`)).toHaveCount(0);
    for (const v of ['2.0.0', '1.0.0', '0.9.0']) {
      await expect(rowFor(page, v)).not.toHaveClass(/app-release-deploy-hit/);
    }
    expectNoPageErrors(pageErrors);
  });

  test('(d) 正例控制组：无深链时无任何高亮', async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (err) => pageErrors.push(err));
    await seedApi(page);
    await seedAuth(page);

    await openReleases(page);

    await expect(page.locator(`${TABLE} .app-release-deploy-hit`)).toHaveCount(0);
    for (const v of ['2.0.0', '1.0.0', '0.9.0']) {
      await expect(rowFor(page, v)).not.toHaveClass(/app-release-deploy-hit/);
    }
    expectNoPageErrors(pageErrors);
  });
});
