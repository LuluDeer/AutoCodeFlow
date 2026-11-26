/**
 * 能力用量看板 · 真浏览器 e2e —— GCO 证伪判据：
 *   「统计端点返回的聚合数据能被真实浏览器渲染成概览 + 两张表；空数据呈现 Empty」
 *
 * ⚠️ 验收级别 = 浏览器（传输层 mock，真浏览器 DOM；不证明真后端数据）：
 *   - 真浏览器 DOM：真实 Chromium 渲染真实 SPA（/activation-stats，RequireAdmin 门控，
 *     注入 admin role 会话），全部断言走 innerText / role / data-testid。
 *   - 传输层 mock：page.route('**' + '/*') 只拦 fetch/xhr，按 pathname **后缀**分派，
 *     响应统一 { code: 0, data } 信封（client interceptor 解包 data）。
 *     匹配与 VITE_API_URL_INTERNAL 形态无关（'/api' 或 http://localhost:3105 绝对 URL
 *     都可命中）；**切勿覆盖 VITE_API_URL_\* 环境变量**。
 *   - 本环境不提供真后端（PG/JWT），故传输层造假；本 spec 不证明后端真的产出这些数字。
 *
 * 登录策略：沿用 e2e/ 既有 seedAuth 约定——localStorage('autoflow-auth') 注入
 *   admin role 会话（RequireAdmin 只认 user.role==='admin'，已有 role 不再拉 profile）。
 * config：playwright.config.ts（testDir './e2e'，默认 5176）；dev server 本轮跑 5177，
 *   故在文件内 test.use 覆盖 baseURL（可用 PLAYWRIGHT_BASE_URL 显式改写）。
 */
import { test, expect, type Page, type Route } from '@playwright/test';

test.use({ baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5177' });

interface StatsFixture {
  total: number;
  byCapability: Array<{
    capabilityKey: string;
    count: number;
    success: number;
    failure: number;
    blocked: number;
  }>;
  byProject: Array<{ projectId: string | null; count: number }>;
}

/** 契约 fixture：逐字段对齐 capability-activation.ts 的 ActivationStats。 */
const STATS_FIXTURE: StatsFixture = {
  total: 8,
  byCapability: [
    { capabilityKey: 'workbench.commit', count: 4, success: 2, failure: 1, blocked: 1 },
    { capabilityKey: 'browser.export', count: 4, success: 3, failure: 1, blocked: 0 },
  ],
  byProject: [
    { projectId: 'proj-alpha', count: 3 },
    { projectId: null, count: 3 },
  ],
};

const EMPTY_FIXTURE: StatsFixture = { total: 0, byCapability: [], byProject: [] };

/**
 * 传输层 mock：与 baseURL 形态完全无关。
 * 全部用「resourceType ∈ {fetch,xhr} + pathname 后缀」判定，绝不用 startsWith('/api/')。
 * 静态资源 / document 导航一律 continue，避免把 SPA 自身 mock 掉。
 */
async function seedApi(page: Page, fixture: StatsFixture) {
  const statsCalls: Array<{ from?: string; to?: string }> = [];
  const reply = (route: Route, data: unknown, status = 200) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data }),
    });

  await page.route('**/*', async (route) => {
    const req = route.request();
    const rt = req.resourceType();
    if (rt !== 'fetch' && rt !== 'xhr') return route.continue();
    const url = new URL(req.url());
    const path = url.pathname;

    if (path.endsWith('/capability-activation/stats')) {
      if (req.method() !== 'GET') return route.continue();
      statsCalls.push({
        from: url.searchParams.get('from') ?? undefined,
        to: url.searchParams.get('to') ?? undefined,
      });
      return reply(route, fixture);
    }
    // 顶栏 / 引导组件兜底（沿用 workbench-preview.spec.ts 的 seedApi 口径）：
    // /metrics/failures 的 data 被直接 .filter()，必须是数组，否则顶栏崩溃。
    if (path.endsWith('/metrics/failures')) return reply(route, []);
    if (path.endsWith('/projects')) return reply(route, []);
    if (path.endsWith('/auth/profile')) return reply(route, { id: 1, username: 'admin', role: 'admin' });
    if (path.endsWith('/agent/inbox/counts')) {
      return reply(route, {
        pendingApprovals: 0, waitingSessions: 0, stalled: 0, backlogged: 0,
        backlogTruncated: false, deployments: 0, queueStall: 0,
        failedSessions: 0, failedWindowHours: 24, degraded: false,
      });
    }
    if (path.endsWith('/app-deployments/approvals/pending')) return reply(route, { data: [], total: 0 });
    if (path.endsWith('/agent/approvals/pending')) {
      return reply(route, { items: [], total: 0, sessionTotal: 0, returned: 0, truncated: false, degraded: false });
    }
    if (path.endsWith('/sop/clarifications/pending') || path.endsWith('/sop/assignments/lagging')) {
      return reply(route, { items: [], data: [], total: 0, returned: 0, truncated: false, degraded: false });
    }
    if (path.endsWith('/agent/budget')) {
      return reply(route, { maxSteps: 12, maxTokens: 4000, maxToolCalls: 6, wallClockMs: 60_000 });
    }
    return reply(route, { items: [], total: 0 });
  });
  return { statsCalls };
}

async function seedAuth(page: Page) {
  await page.goto('/login');
  await page.evaluate(() => {
    localStorage.setItem('autoflow-lang', 'zh');
    localStorage.setItem('autoflow-auth', JSON.stringify({
      state: {
        token: 'e2e-activation-stats-access',
        refreshToken: 'e2e-activation-stats-refresh',
        user: { id: 1, username: 'admin', role: 'admin' },
      },
      version: 0,
    }));
  });
}

test('stats 数据由真浏览器渲染成 total=8、能力/项目两张表（传输层 mock）', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (e) => pageErrors.push(e));
  const { statsCalls } = await seedApi(page, STATS_FIXTURE);
  await seedAuth(page);

  await page.goto('/activation-stats');
  const root = page.getByTestId('activation-stats-page');
  await expect(root).toBeVisible();

  // 请求真的发出且只发一次，带近 30 天默认 from/to（ISO 字符串）。
  await expect.poll(() => statsCalls.length).toBe(1);
  const call = statsCalls[0];
  expect(call.from).toBeTruthy();
  expect(call.to).toBeTruthy();
  const fromMs = Date.parse(call.from!);
  const toMs = Date.parse(call.to!);
  expect(Number.isFinite(fromMs)).toBe(true);
  expect(Number.isFinite(toMs)).toBe(true);
  expect(toMs - fromMs).toBeGreaterThan(28 * 86_400_000);
  expect(toMs - fromMs).toBeLessThan(32 * 86_400_000);

  // 概览：累计激活次数 = total = 8（不是前端二次派生）。
  const totalStat = root.locator('.ant-statistic').filter({
    has: page.getByText('累计激活次数', { exact: true }),
  });
  await expect(totalStat.locator('.ant-statistic-content-value')).toHaveText('8');

  // 按能力表：workbench.commit 行 + 4 / 2 / 1 / 1 四态数值。
  const commitRow = root.locator('tr').filter({ hasText: 'workbench.commit' });
  await expect(commitRow).toBeVisible();
  await expect(commitRow.locator('td').nth(1)).toHaveText('4');
  await expect(commitRow.getByText('成功 2', { exact: true })).toBeVisible();
  await expect(commitRow.getByText('失败 1', { exact: true })).toBeVisible();
  await expect(commitRow.getByText('拦截 1', { exact: true })).toBeVisible();

  // 按项目表：proj-alpha + null 映射为「未归属项目」。
  await expect(root.getByText('proj-alpha', { exact: true })).toBeVisible();
  await expect(root.getByText('未归属项目', { exact: true })).toBeVisible();

  expect(pageErrors.map((e) => e.message)).toEqual([]);
});

test('total=0 且两张表为空时真浏览器呈现 Empty 文案（传输层 mock）', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (e) => pageErrors.push(e));
  const { statsCalls } = await seedApi(page, EMPTY_FIXTURE);
  await seedAuth(page);

  await page.goto('/activation-stats');
  const root = page.getByTestId('activation-stats-page');
  await expect(root).toBeVisible();
  await expect.poll(() => statsCalls.length).toBe(1);
  await expect(root.getByText('暂无能力激活记录', { exact: false })).toBeVisible();
  await expect(root.locator('table')).toHaveCount(0);

  expect(pageErrors.map((e) => e.message)).toEqual([]);
});
