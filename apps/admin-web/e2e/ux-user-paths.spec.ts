import { test, expect, type Page } from '@playwright/test';

const USER = { id: 1, username: 'admin', email: 'admin@autoflow.local', role: 'admin' };
const ISO = (offset = 0) => new Date(Date.now() + offset).toISOString();

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

/** 与 ux-walkthrough.mjs 的 fixture 同源口径，但保持 spec 自包含、CI 可复现。 */
async function stubApi(page: Page) {
  const writes: string[] = [];
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api/, '');
    if (req.method() !== 'GET') writes.push(`${req.method()} ${path}`);
    if (path === '/auth/oidc/status') return route.fulfill(json({ enabled: false }));
    if (path === '/auth/login') {
      return route.fulfill(json({
        accessToken: 'ux-stub-access', refreshToken: 'ux-stub-refresh', user: USER,
      }));
    }
    if (path === '/auth/profile') return route.fulfill(json(USER));
    if (path === '/metrics/summary') {
      return route.fulfill(json({
        totalTasks: 8, todayRuns: 12, totalExecutors: 3, onlineExecutors: 2,
        executions: { total: 100, success: 92, failed: 8, running: 0 },
        successRate: 92, avgDurationMs: 1200,
      }));
    }
    if (path.startsWith('/metrics/')) return route.fulfill(json([]));
    if (path === '/tasks') {
      return route.fulfill(json({
        items: [{ id: 't-1001', name: '走查任务', runtime: 'python', entrypoint: 'main.py', status: 'active', triggerType: 'manual', maxRetry: 0, timeout: 60, createdAt: ISO(), updatedAt: ISO() }],
        total: 1, page: 1, pageSize: 20, totalPages: 1,
      }));
    }
    if (path === '/tasks/t-1001') {
      return route.fulfill(json({
        id: 't-1001', name: '走查任务', runtime: 'python', entrypoint: 'main.py', status: 'active',
        triggerType: 'manual', maxRetry: 0, timeout: 60, createdAt: ISO(), updatedAt: ISO(),
      }));
    }
    if (path === '/capabilities') return route.fulfill(json([]));
    if (path === '/capability-activation/stats') {
      return route.fulfill(json({ total: 0, byCapability: [], byProject: [] }));
    }
    if (path === '/capability-activation/quota-status') return route.fulfill(json([]));
    if (path === '/executors/install-cmd') {
      return route.fulfill(json({ cmd: 'echo install-fixture', token: 'stub-token', adminApiUrl: 'http://127.0.0.1' }));
    }
    if (path === '/config/executor-shared-token') return route.fulfill(json({ token: null, hasToken: false }));
    if (path === '/ai/providers') {
      return route.fulfill(json({ providers: [], errors: [], routes: {} }));
    }
    if (path === '/ai/sop-sessions') return route.fulfill(json({ items: [], total: 0 }));
    if (path === '/agent/inbox/counts') return route.fulfill(json({ deployments: 0, pendingApprovals: 0, waitingSessions: 0, failedSessions: 0, stalled: 0, backlogged: 0, queueStall: 0, degraded: false }));
    if (path === '/agent/approvals/pending') return route.fulfill(json({ items: [], total: 0, truncated: false, degraded: false }));
    if (path === '/agent/sessions/queue-stall') return route.fulfill(json({ stalled: false, reason: null, pendingJobs: 0, degraded: false, degradedCounts: false, workersKnown: true }));
    if (path === '/agent/sessions/queue-idle') return route.fulfill(json({ idleStuck: false, oldestAgeMs: 0, thresholdMs: 900000, waitingCount: 0, retried: false, suppressedBy: null, degraded: false }));
    if (path === '/agent/sessions/backlogged') return route.fulfill(json({ sessionIds: [], count: 0, probed: 0, truncated: false }));
    if (path === '/agent/sessions') return route.fulfill(json({ items: [], total: 0 }));
    if (path === '/sop') return route.fulfill(json({ items: [], total: 0 }));
    if (path === '/sop/clarifications/pending') return route.fulfill(json({ items: [], total: 0, truncated: false, degraded: false }));
    if (path === '/sop/assignments/lagging') return route.fulfill(json({ items: [], total: 0, truncated: false, degraded: false }));
    if (path === '/app-deployments/approvals/pending') return route.fulfill(json({ data: [], total: 0 }));
    if (path === '/app-deployments') return route.fulfill(json({ data: [], total: 0 }));
    return route.fulfill(json([], 404));
  });
  return writes;
}

async function authenticated(page: Page) {
  await page.addInitScript(([auth]) => {
    localStorage.setItem('autoflow-auth', auth);
    localStorage.setItem('autoflow-lang', 'zh');
  }, [JSON.stringify({ state: { token: 'ux-stub-access', refreshToken: 'ux-stub-refresh', user: USER }, version: 0 })]);
}

test.describe('UX authoritative browser-stub walkthrough', () => {
  test('真实登录提交写入 token 并落到 dashboard', async ({ page }) => {
    const writes = await stubApi(page);
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/login');
    await page.locator('input[autocomplete="username"]').fill('admin');
    await page.locator('input[autocomplete="current-password"]').fill('ux-stub-password');
    await page.locator('button[type="submit"]').click();

    await page.waitForURL(/\/dashboard(?:\?|$)/, { timeout: 10_000 });
    expect(writes).toContain('POST /auth/login');
    expect(await page.evaluate(() => !!localStorage.getItem('autoflow-auth'))).toBe(true);
    expect((await page.locator('body').textContent())?.length ?? 0).toBeGreaterThan(20);
    expect(errors).toEqual([]);
  });

  const PAGES = [
    '/tasks/t-1001/edit',
    '/executors/install',
    '/capabilities',
    '/activation-stats',
    '/workbench',
    '/sops/from-video',
    '/this-route-does-not-exist-ux',
  ];

  for (const path of PAGES) {
    test(`真实用户路径可达且无 JS 异常: ${path}`, async ({ page }) => {
      await stubApi(page);
      await authenticated(page);
      const errors: string[] = [];
      page.on('pageerror', (err) => errors.push(err.message));
      await page.goto(path);
      await page.waitForLoadState('domcontentloaded');
      expect((await page.locator('body').textContent())?.length ?? 0).toBeGreaterThan(10);
      expect(errors).toEqual([]);
    });
  }
});
