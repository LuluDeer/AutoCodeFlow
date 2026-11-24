/**
 * B3 可视化升级真机取证（离线 stub + vite dev，真浏览器渲染）。
 *
 * 覆盖用户路径：
 *   ① Dashboard 趋势图：执行量 + 日成功率双轴渲染；切 7/30 天窗，实际 trend
 *      请求 days 参数随之改变（聚合纯函数 utils/trendSeries.ts）；
 *   ② 空数据态：trend 全空时图表区不崩、无错误边界；
 *   ③ 执行详情时间线（报告 Tab）：阶段耗时（排队等待/运行耗时）可见、失败点
 *      高亮（归类 Tag + 原始错误信息）、重试链关联（第 N 次尝试 · 链上共 M 次），
 *      「查看重试链」跳转重试链 Tab。
 *
 * 离线口径（同 b2-efficiency.spec.ts 范式）：
 *   · storageState 种子 localStorage：autoflow-lang=zh、autoflow-auth（token 非空过
 *     PrivateRoute，role=admin 过 RequireAdmin）；
 *   · context.route 仅拦截同源 /api/ 前缀（pathname 前缀匹配，不误截 /src/api/ 源码）；
 *     非 API 静态资源直通。
 *
 * 取证边界（如实标注）：dev server + stub 响应，未连真实后端；趋势行数据由 stub
 * 按 days 生成，成功率口径（成功/(成功+失败+超时)）由前端纯函数计算，后端聚合端点
 * 契约由既有单测与 admin-api 守卫覆盖。产物：test-results/b3-timeline-trend/<case>.png
 * + 同名 .json 审计记录。
 */
import { test as base, expect, type Route } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const OUT =
  process.env.B3_OUT || path.join(process.cwd(), 'test-results', 'b3-timeline-trend');

const STUB_PROFILE = { id: 1, username: 'admin', role: 'admin', totpEnabled: false };

function trendRows(days: number): Array<{ date: string; success: number; failed: number; timeout: number }> {
  const rows: Array<{ date: string; success: number; failed: number; timeout: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    rows.push({
      date: d.toISOString().slice(0, 10),
      success: 8 - (i % 3),
      failed: i % 2,
      timeout: i % 4 === 3 ? 1 : 0,
    });
  }
  return rows;
}

const FAIL_EXEC = {
  id: 'exec-fail-1',
  taskId: 'task-1',
  taskName: 'B3 取证失败执行',
  status: 'failed',
  triggerType: 'cron',
  executorAddress: '10.0.0.1:3002',
  executorId: 'aaaa1111-2222-3333-4444-555566667777',
  startTime: '2026-11-24T01:00:05.000Z',
  endTime: '2026-11-24T01:05:00.000Z',
  duration: 295000,
  params: null,
  createdAt: '2026-11-24T01:00:00.000Z',
  retryCount: 1,
  failureReason: 'script_error',
  errorMessage: 'ZeroDivisionError: division by zero (B3 取证)',
  traceId: 'trace-b3-0001',
  aiAnalysis: null,
};

const SIBLINGS = [
  { ...FAIL_EXEC, id: 'exec-orig-0', retryCount: 0, status: 'failed', errorMessage: 'first attempt failed' },
  FAIL_EXEC,
  { ...FAIL_EXEC, id: 'exec-pending-2', retryCount: 2, status: 'waiting', startTime: null, endTime: null, duration: null, errorMessage: null },
];

function stubData(pathname: string, query: URLSearchParams, opts: { emptyTrend: boolean }): unknown {
  if (pathname === '/api/auth/profile') return STUB_PROFILE;
  if (pathname === '/api/auth/oidc/status') return { enabled: false };
  if (pathname === '/api/metrics/summary') {
    return { totalTasks: 2, todayRuns: 6, totalExecutors: 1, onlineExecutors: 1,
      executions: { total: 12, success: 9, failed: 2, running: 1 }, successRate: 75, avgDurationMs: 42000 };
  }
  if (pathname === '/api/metrics/trend') {
    if (opts.emptyTrend) return [];
    const days = Number(query.get('days') ?? '7');
    return trendRows(Number.isFinite(days) && days > 0 ? days : 7);
  }
  if (['/api/metrics/executors', '/api/metrics/failures'].includes(pathname)) return [];
  if (pathname === '/api/metrics/scheduler') {
    return { counters: {}, derived: {}, queue: {}, scheduler: { healthy: true, isLeader: true }, instance: { pid: 0, hostname: 'stub' } };
  }
  if (pathname === '/api/tasks/scheduler/stats') return { healthy: true, isLeader: true };
  if (pathname === '/api/tasks/task-1') {
    return { id: 'task-1', name: 'B3 取证任务', maxRetry: 2, status: 'active', triggerType: 'cron' };
  }
  if (pathname === '/api/tasks/task-1/executions') return { items: SIBLINGS, total: 3, page: 1, pageSize: 100 };
  if (pathname === '/api/tasks/task-1/executions/exec-fail-1') return FAIL_EXEC;
  if (pathname === '/api/tasks/task-1/executions/exec-fail-1/report') {
    return {
      execution: FAIL_EXEC,
      timeline: [
        { phase: 'created', at: FAIL_EXEC.createdAt, detail: 'trigger=cron' },
        { phase: 'started', at: FAIL_EXEC.startTime, detail: 'executor=10.0.0.1:3002' },
        { phase: 'finished', at: FAIL_EXEC.endTime, detail: 'status=failed' },
      ],
      report: null,
    };
  }
  if (pathname.endsWith('/logs')) return { lines: [], totalLines: 0, truncated: false, logRetention: { days: 30 } };
  if (pathname.includes('/artifacts')) return { items: [], total: 0 };
  if (pathname === '/api/agent/inbox/counts') {
    return { pendingApprovals: 0, waitingSessions: 0, stalled: 0, backlogged: 0,
      backlogTruncated: false, deployments: 0, queueStall: 0, failedSessions: 0,
      failedWindowHours: 24, degraded: false };
  }
  if (pathname === '/api/agent/approvals/pending') return { items: [], total: 0, sessionTotal: 0, returned: 0, truncated: false, degraded: false };
  if (pathname === '/api/agent/telemetry/status') return { consent: false };
  if (['/api/projects', '/api/applications', '/api/api-keys', '/api/executor-packages',
    '/api/notification/channels', '/api/notification/silences', '/api/config',
    '/api/mutex-groups', '/api/executors', '/api/executors/groups', '/api/executors/tags',
    '/api/auth/sessions', '/api/sop/assignable-executors', '/api/registry/npm/packages',
  ].includes(pathname)) return [];
  if (pathname === '/api/executors/picker') return { items: [], total: 0 };
  if (pathname === '/api/executors/runtime-config') return {};
  if (pathname === '/api/ai/config') return {};
  if (pathname === '/api/ai/providers') return { providers: [] };
  return { items: [], total: 0, data: [] };
}

interface B3Stubs {
  errors: string[];
  trendRequests: string[];
}

const test = base.extend<{ b3: B3Stubs & { emptyTrend: boolean } }>({
  b3: [async ({ context }, use) => {
    const state: B3Stubs & { emptyTrend: boolean } = { errors: [], trendRequests: [], emptyTrend: false };
    context.on('pageerror', (err) => state.errors.push(err.message));
    await context.route((url) => url.pathname.startsWith('/api/'), async (route: Route) => {
      const req = route.request();
      const { pathname, searchParams } = new URL(req.url());
      if (req.method() === 'OPTIONS') {
        return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
      }
      if (req.method() === 'GET' && pathname === '/api/metrics/trend') {
        state.trendRequests.push(req.url());
      }
      return route.fulfill({
        status: 200,
        headers: { 'access-control-allow-origin': '*' },
        json: { code: 200, message: 'success', data: stubData(pathname, searchParams, state) },
      });
    });
    await use(state);
  }, { auto: true }],
});

function seedInitScript() {
  return `(() => {
    try {
      localStorage.setItem('autoflow-lang', 'zh');
      localStorage.setItem('autoflow-auth', JSON.stringify({ state: {
        token: 'stub-access', refreshToken: 'stub-refresh',
        user: { id: 1, username: 'admin', role: 'admin', totpEnabled: false },
      }, version: 0 }));
    } catch (e) {}
  })();`;
}

async function settle(page: import('@playwright/test').Page) {
  await page.waitForTimeout(900);
}

async function recordShot(page: import('@playwright/test').Page, caseKey: string, stubs: B3Stubs, extra: Record<string, unknown> = {}) {
  fs.mkdirSync(OUT, { recursive: true });
  const shotPath = path.join(OUT, `${caseKey}.png`);
  await page.screenshot({ path: shotPath, fullPage: true });
  const fatal = stubs.errors.filter((e) => !e.includes('favicon') && !e.includes('401') && !e.includes('403'));
  const boundaryHit = await page.evaluate(() => !!document.querySelector('.ant-result-status-error'));
  if (boundaryHit) fatal.push('render error boundary shown (.ant-result-status-error)');
  const record = { case: caseKey, url: page.url(), fatalErrors: fatal, screenshot: shotPath, ...extra };
  fs.writeFileSync(path.join(OUT, `${caseKey}.json`), JSON.stringify(record, null, 2));
  expect(fatal, `fatal page errors on ${caseKey}`).toEqual([]);
}

test.describe('B3 可视化升级取证', () => {
  test('① 趋势图：成功率曲线渲染，切 30 天窗实际改变 trend 请求 days 参数', async ({ page, b3 }) => {
    await page.context().addInitScript(seedInitScript());
    await page.goto('/dashboard');
    await settle(page);

    // 图例三类序列：成功 / 失败 / 成功率。
    await expect(page.getByText('成功率', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('成功', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('失败', { exact: true }).first()).toBeVisible();

    // 初始 7 天窗：trend 请求带 days=7。
    await expect(b3.trendRequests.some((u) => u.includes('days=7'))).toBeTruthy();

    // 切到 30 天：新请求带 days=30。
    await page.getByText('30天', { exact: true }).click();
    await settle(page);
    expect(b3.trendRequests.some((u) => u.includes('days=30'))).toBeTruthy();

    await recordShot(page, '01-trend-window', b3, {
      trendRequests: b3.trendRequests,
    });
  });

  test('② 空数据态：trend 全空时图表区不崩、无错误边界', async ({ page, b3 }) => {
    b3.emptyTrend = true;
    await page.context().addInitScript(seedInitScript());
    await page.goto('/dashboard');
    await settle(page);

    const boundaryHit = await page.evaluate(() => !!document.querySelector('.ant-result-status-error'));
    expect(boundaryHit).toBe(false);
    await recordShot(page, '02-trend-empty', b3);
  });

  test('③ 执行详情时间线：阶段耗时 + 失败点高亮 + 重试链关联', async ({ page, b3 }) => {
    await page.context().addInitScript(seedInitScript());
    await page.goto('/tasks/task-1/executions/exec-fail-1?tab=report');
    await settle(page);

    // 阶段耗时：排队等待（started 段）/ 运行耗时（finished 段）。
    await expect(page.getByText('排队等待').first()).toBeVisible();
    await expect(page.getByText('运行耗时').first()).toBeVisible();

    // 失败点高亮：归类 Tag + 原始错误信息。
    const point = page.getByTestId('timeline-failure-point');
    await expect(point).toBeVisible();
    await expect(point).toContainText('ZeroDivisionError: division by zero (B3 取证)');

    // 重试链关联：第 2 次尝试 · 链上共 3 次。
    await expect(page.getByTestId('timeline-attempt-meta')).toContainText('第 2 次尝试 · 链上共 3 次');

    // 跳转前先留报告 Tab 时间线视图证据（阶段耗时 + 失败点 + 链元信息）。
    await recordShot(page, '03-timeline-report', b3);

    // 「查看重试链」跳转重试链 Tab。
    await page.getByTestId('timeline-view-retry').click();
    await settle(page);
    const retryTab = page.locator('.ant-tabs-tab', { has: page.getByTestId('tab-label-retry') });
    await expect(retryTab).toHaveClass(/ant-tabs-tab-active/);

    await recordShot(page, '04-retry-chain', b3);
  });
});
