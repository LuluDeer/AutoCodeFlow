/**
 * B4 质感横切收口真机取证（离线 stub + vite dev，真浏览器渲染）。
 *
 * 覆盖路径：
 *   ① Dashboard 首屏骨架：汇总/趋势/机队/失败请求在途时，KPI 行与卡片呈现
 *      PageSkeleton（data-testid=page-skeleton），而非裸 Spin / 空白；
 *   ② 执行列表首屏骨架：/tasks/executions/all 在途时，列表区呈现行骨架；
 *   ③ reduced-motion：emulateMedia reducedMotion:'reduce' 下，body 计算样式
 *      transition-duration 降级到 ≤1ms（全局 prefers-reduced-motion 块生效）。
 *
 * 离线口径（同 b2/b3 范式）：
 *   · init script 种子 localStorage：autoflow-lang=zh、autoflow-auth（token 非空
 *     过 PrivateRoute，role=admin 过 RequireAdmin）；
 *   · context.route 仅拦截同源 /api/ 前缀（pathname 前缀匹配，不误截 /src/api/ 源码）；
 *     非 API 静态资源直通；EventSource（/metrics/stream SSE）不由 route 拦截，失败静默。
 *
 * 取证边界（如实标注）：dev server + stub 响应，未连真实后端；在途态由 stub 延迟
 * 2.5s 兑现构造，骨架判据纯函数 shouldShowPageSkeleton 的四态由单测
 * （__tests__/motion-skeleton-ux08.test.ts）守护。产物：
 * test-results/b4-motion-skeleton/<case>.png + 同名 .json 审计记录。
 */
import { test as base, expect, type Route } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const OUT =
  process.env.B4_OUT || path.join(process.cwd(), 'test-results', 'b4-motion-skeleton');

const STUB_PROFILE = { id: 1, username: 'admin', role: 'admin', totpEnabled: false };

/** 被挂起（延迟兑现）的端点集合；用例按面往里加，其余端点立即兑现。 */
const HANG_ENDPOINTS = new Set<string>([
  '/api/metrics/summary',
  '/api/metrics/trend',
  '/api/metrics/executors',
  '/api/metrics/failures',
  '/api/tasks/executions/all',
]);

function stubData(pathname: string): unknown {
  if (pathname === '/api/auth/profile') return STUB_PROFILE;
  if (pathname === '/api/auth/oidc/status') return { enabled: false };
  if (pathname === '/api/metrics/summary') {
    return { totalTasks: 2, todayRuns: 6, totalExecutors: 1, onlineExecutors: 1,
      executions: { total: 12, success: 9, failed: 2, running: 1 }, successRate: 75, avgDurationMs: 42000 };
  }
  if (pathname === '/api/metrics/trend') return [];
  if (['/api/metrics/executors', '/api/metrics/failures'].includes(pathname)) return [];
  if (pathname === '/api/metrics/scheduler') {
    return { counters: {}, derived: {}, queue: {}, scheduler: { healthy: true, isLeader: true }, instance: { pid: 0, hostname: 'stub' } };
  }
  if (pathname === '/api/tasks/scheduler/stats') return { healthy: true, isLeader: true };
  if (pathname === '/api/agent/inbox/counts') {
    return { pendingApprovals: 0, waitingSessions: 0, stalled: 0, backlogged: 0,
      backlogTruncated: false, deployments: 0, queueStall: 0, failedSessions: 0,
      failedWindowHours: 24, degraded: false };
  }
  if (pathname === '/api/agent/approvals/pending') return { items: [], total: 0, sessionTotal: 0, returned: 0, truncated: false, degraded: false };
  if (pathname === '/api/agent/telemetry/status') return { consent: false };
  if (pathname === '/api/executors/picker') return { items: [], total: 0 };
  if (pathname === '/api/executors/runtime-config') return {};
  if (pathname === '/api/ai/config') return {};
  if (pathname === '/api/ai/providers') return { providers: [] };
  if (pathname === '/api/tasks/executions/all') return { items: [], total: 0, page: 1, pageSize: 20 };
  // 裸数组契约（同 b3 范式）：这些端点消费方直接 .map/.filter，不能给分页信封。
  if (['/api/projects', '/api/applications', '/api/api-keys', '/api/executor-packages',
    '/api/notification/channels', '/api/notification/silences', '/api/config',
    '/api/mutex-groups', '/api/executors', '/api/executors/groups', '/api/executors/tags',
    '/api/auth/sessions', '/api/sop/assignable-executors', '/api/registry/npm/packages',
  ].includes(pathname)) return [];
  return { items: [], total: 0, data: [] };
}

interface B4State {
  hang: Set<string>;
  errors: string[];
}

const test = base.extend<{ b4: B4State }>({
  b4: [async ({ context }, use) => {
    const state: B4State = { hang: new Set(), errors: [] };
    context.on('pageerror', (err) => state.errors.push(err.message));
    await context.route((url) => url.pathname.startsWith('/api/'), async (route: Route) => {
      const req = route.request();
      const { pathname } = new URL(req.url());
      if (req.method() === 'OPTIONS') {
        return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
      }
      if (state.hang.has(pathname)) {
        // 在途态：延迟兑现，给首帧留出骨架呈现窗口
        await new Promise((resolve) => setTimeout(resolve, 2500));
      }
      return route.fulfill({
        status: 200,
        headers: { 'access-control-allow-origin': '*' },
        json: { code: 200, message: 'success', data: stubData(pathname) },
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

async function recordShot(page: import('@playwright/test').Page, caseKey: string, stubs: B4State, extra: Record<string, unknown> = {}) {
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

test.describe('B4 质感横切收口取证', () => {
  test('① Dashboard 首屏：汇总/趋势/机队/失败在途时呈现骨架屏', async ({ page, b4 }) => {
    HANG_ENDPOINTS.forEach((ep) => b4.hang.add(ep));
    await page.context().addInitScript(seedInitScript());
    await page.goto('/dashboard');

    // 首帧即有骨架节点（红点：修前是裸 Spin / 空白）
    await expect(page.locator('[data-testid="page-skeleton"]').first()).toBeVisible();
    await recordShot(page, '01-dashboard-skeleton', b4);
  });

  test('② 执行列表首屏：执行记录在途时呈现行骨架', async ({ page, b4 }) => {
    b4.hang.add('/api/tasks/executions/all');
    await page.context().addInitScript(seedInitScript());
    await page.goto('/executions');

    await expect(page.locator('[data-testid="page-skeleton"]').first()).toBeVisible();
    await recordShot(page, '02-executions-skeleton', b4);
  });

  test('③ reduced-motion：降级模式下过渡时长被压到 ≤1ms', async ({ page, b4 }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.context().addInitScript(seedInitScript());
    await page.goto('/dashboard');
    await page.waitForTimeout(900);

    const transitionMs = await page.evaluate(() => {
      const v = getComputedStyle(document.body).transitionDuration;
      const n = parseFloat(v);
      return Number.isNaN(n) ? Number.POSITIVE_INFINITY : v.includes('ms') ? n : n * 1000;
    });
    expect(transitionMs).toBeLessThanOrEqual(1);

    await recordShot(page, '03-reduced-motion', b4, { transitionMs });
  });
});
