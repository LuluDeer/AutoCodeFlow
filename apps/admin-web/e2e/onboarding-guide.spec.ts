/**
 * B1 首体验引导真机取证（离线 stub + vite dev，真浏览器渲染）。
 *
 * 覆盖用户路径：
 *   ① dashboard welcome 空态 → 引导卡步骤 1，CTA 跳 /tasks/new；
 *   ② taskCreated（有任务无执行）→ 引导卡步骤 2，CTA 跳 /tasks；
 *   ③ firstRun（有执行无成功）→ 引导卡步骤 3，CTA 跳 /executions；
 *   ④ completed 老用户（已有成功执行 + 信封 completedAt）→ 不渲染引导卡与横幅；
 *   ⑤ 执行记录真空态 → 「前往任务列表」CTA 跳 /tasks；
 *   ⑥ 会话内由 welcome 迁入 completed → 一次性收口横幅出现。
 *
 * 离线口径（同 dark-parity.spec.ts 范式）：
 *   · storageState 种子 localStorage：autoflow-lang=zh、autoflow-auth（token 非空过
 *     PrivateRoute，role=admin 过 RequireAdmin）；
 *   · context.route 仅拦截同源 /api/ 前缀（pathname 前缀匹配，不误截 /src/api/ 源码）；
 *     非 API 静态资源直通。
 *
 * 取证边界（如实标注）：创建任务走 /tasks/new TaskFormPage，表单引用数据（执行器/应用/
 * 模板）stub 面过重，本套件不覆盖「填表提交 → 触发 → 成功执行」全链路写路径；该链路
 * 复用既有创建流，其契约由单元测试与既有 e2e 守护。本套件只取证引导卡显隐、步骤文案、
 * CTA 导航与横幅收口。
 *
 * 产物：test-results/onboarding-guide/<case>.png + 同名 .json 审计记录。
 */
import { test as base, expect, type Route } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const OUT =
  process.env.ONBOARDING_OUT || path.join(process.cwd(), 'test-results', 'onboarding-guide');

type SummaryStage = 'welcome' | 'taskCreated' | 'firstRun' | 'completed';

const STUB_PROFILE = { id: 1, username: 'admin', role: 'admin', totpEnabled: false };

function summaryFixture(stage: SummaryStage) {
  switch (stage) {
    case 'welcome':
      return { totalTasks: 0, todayRuns: 0, totalExecutors: 0, onlineExecutors: 0,
        executions: { total: 0, success: 0, failed: 0, running: 0 }, successRate: 0, avgDurationMs: 0 };
    case 'taskCreated':
      return { totalTasks: 1, todayRuns: 0, totalExecutors: 0, onlineExecutors: 0,
        executions: { total: 0, success: 0, failed: 0, running: 0 }, successRate: 0, avgDurationMs: 0 };
    case 'firstRun':
      return { totalTasks: 1, todayRuns: 1, totalExecutors: 0, onlineExecutors: 0,
        executions: { total: 1, success: 0, failed: 0, running: 1 }, successRate: 0, avgDurationMs: 0 };
    case 'completed':
      return { totalTasks: 1, todayRuns: 1, totalExecutors: 0, onlineExecutors: 0,
        executions: { total: 1, success: 1, failed: 0, running: 0 }, successRate: 100, avgDurationMs: 1200 };
  }
}

function stubData(pathname: string, stage: SummaryStage): unknown {
  if (pathname === '/api/auth/profile') return STUB_PROFILE;
  if (pathname === '/api/auth/oidc/status') return { enabled: false };
  if (pathname === '/api/metrics/summary') return summaryFixture(stage);
  if (pathname === '/api/metrics/trend' || pathname === '/api/metrics/executors' || pathname === '/api/metrics/failures') return [];
  if (pathname === '/api/metrics/scheduler') {
    return { counters: { ticks: 0, tickDurationMsTotal: 0, lastTickDurationMs: 0, lastTickAt: null,
      triggersClaimed: 0, triggersSkippedLockHeld: 0, triggersSkippedInactive: 0,
      triggersSkippedBlockStrategy: 0, triggersSkippedMaintenance: 0, triggersSkippedInactive: 0,
      triggersFailed: 0, dependencyTriggersClaimed: 0, dependencyTriggersSkipped: 0,
      triggerLatencyCount: 0, triggerLatencySumMs: 0, triggerLatencyBuckets: [], lastTriggerLatencyMs: 0,
      startedAt: new Date().toISOString() },
      derived: { avgTickDurationMs: 0, tickRatePerSec: 0, triggerClaimRatePerSec: 0,
        avgTriggerLatencyMs: 0, p99TriggerLatencyMs: 0 },
      queue: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
      scheduler: { healthy: true, isLeader: true, activeTimers: 0, activeCronTasks: 0,
        runningTaskCount: 0, totalScheduledTasks: 0, uptime: 0 },
      instance: { pid: 0, hostname: 'stub' } };
  }
  if (pathname === '/api/tasks/scheduler/stats') {
    return { healthy: true, isLeader: true, activeTimers: 0, activeCronTasks: 0,
      runningTaskCount: 0, totalScheduledTasks: 0, uptime: 0 };
  }
  if (pathname === '/api/tasks') return { items: [], total: 0 };
  if (pathname === '/api/tasks/executions/all') return { items: [], total: 0 };
  if (pathname === '/api/agent/inbox/counts') {
    return { pendingApprovals: 0, waitingSessions: 0, stalled: 0, backlogged: 0,
      backlogTruncated: false, deployments: 0, queueStall: 0, failedSessions: 0,
      failedWindowHours: 24, degraded: false };
  }
  if (pathname === '/api/agent/approvals/pending') {
    return { items: [], total: 0, sessionTotal: 0, returned: 0, truncated: false, degraded: false };
  }
  if (pathname === '/api/agent/telemetry/status') return { consent: false };
  // 直返数组的端点（MainLayout 项目切换器/执行器筛选等消费方会直接 .filter/.map）。
  if (['/api/projects', '/api/applications', '/api/api-keys', '/api/executor-packages',
    '/api/notification/channels', '/api/notification/silences', '/api/config',
    '/api/mutex-groups', '/api/executors', '/api/executors/groups', '/api/executors/tags',
    '/api/auth/sessions', '/api/sop/assignable-executors', '/api/registry/npm/packages',
  ].includes(pathname)) return [];
  if (pathname === '/api/executors/picker') return { items: [], total: 0 };
  if (pathname === '/api/executors/runtime-config') return {};
  if (pathname === '/api/ai/config') return {};
  if (pathname === '/api/ai/providers') return { providers: [] };
  // 兜底：宽松列表封套（items/data/total 三键齐备，消费方取任一不致崩溃）。
  return { items: [], total: 0, data: [] };
}

interface OnboardingStubs {
  stage: SummaryStage;
  errors: string[];
}

const test = base.extend<{ onboarding: OnboardingStubs }>({
  onboarding: [async ({ context }, use) => {
    const state: OnboardingStubs = { stage: 'welcome', errors: [] };
    context.on('pageerror', (err) => state.errors.push(err.message));
    // 仅拦截同源 /api/ 前缀；不能用 '**/api/**' 通配——它会命中源码路径
    // /src/api/**（如 queryClient.ts），把源码模块回成 JSON 封套，MIME 校验失败致 root 空渲染。
    await context.route((url) => url.pathname.startsWith('/api/'), async (route: Route) => {
      const req = route.request();
      const { pathname } = new URL(req.url());
      if (req.method() === 'OPTIONS') {
        return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
      }
      return route.fulfill({
        status: 200,
        headers: { 'access-control-allow-origin': '*' },
        json: { code: 200, message: 'success', data: stubData(pathname, state.stage) },
      });
    });
    await use(state);
  }, { auto: true }],
});

function seedInitScript(extra?: Record<string, string>) {
  const extras = extra
    ? Object.entries(extra).map(([k, v]) => `localStorage.setItem('${k}', ${JSON.stringify(v)});`).join('\n')
    : '';
  return `(() => {
    try {
      localStorage.setItem('autoflow-lang', 'zh');
      localStorage.setItem('autoflow-auth', JSON.stringify({ state: {
        token: 'stub-access', refreshToken: 'stub-refresh',
        user: { id: 1, username: 'admin', role: 'admin', totpEnabled: false },
      }, version: 0 }));
      ${extras}
    } catch (e) {}
  })();`;
}

async function settle(page: import('@playwright/test').Page) {
  // 等懒加载 chunk 与首屏查询落地（SSE/长轮询已被 stub 截断，不会挂住 networkidle）。
  await page.waitForTimeout(900);
}

async function recordShot(page: import('@playwright/test').Page, caseKey: string, stubs: OnboardingStubs, extra: Record<string, unknown> = {}) {
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

test.describe('B1 首体验引导取证', () => {
  test('welcome：dashboard 引导卡步骤 1，CTA 跳 /tasks/new', async ({ page, onboarding }) => {
    onboarding.stage = 'welcome';
    await page.context().addInitScript(seedInitScript());
    await page.goto('/dashboard');
    await settle(page);
    await expect(page.getByTestId('dashboard-empty-guide')).toBeVisible();
    await expect(page.getByTestId('onboarding-step-1')).toBeVisible();
    await page.getByTestId('dashboard-empty-guide-create').click();
    await expect(page).toHaveURL(/\/tasks\/new$/);
    await recordShot(page, '01-welcome-create', onboarding);
  });

  test('taskCreated：引导卡步骤 2，CTA 跳 /tasks', async ({ page, onboarding }) => {
    onboarding.stage = 'taskCreated';
    await page.context().addInitScript(seedInitScript());
    await page.goto('/dashboard');
    await settle(page);
    await expect(page.getByTestId('dashboard-empty-guide')).toBeVisible();
    await expect(page.getByTestId('onboarding-step-2')).toBeVisible();
    await page.getByTestId('onboarding-guide-cta').click();
    await expect(page).toHaveURL(/\/tasks$/);
    await recordShot(page, '02-taskCreated-tasks', onboarding);
  });

  test('firstRun：引导卡步骤 3，CTA 跳 /executions', async ({ page, onboarding }) => {
    onboarding.stage = 'firstRun';
    await page.context().addInitScript(seedInitScript());
    await page.goto('/dashboard');
    await settle(page);
    await expect(page.getByTestId('dashboard-empty-guide')).toBeVisible();
    await expect(page.getByTestId('onboarding-step-3')).toBeVisible();
    await page.getByTestId('onboarding-guide-cta').click();
    await expect(page).toHaveURL(/\/executions$/);
    await recordShot(page, '03-firstRun-executions', onboarding);
  });

  test('completed 老用户：不渲染引导卡与收口横幅', async ({ page, onboarding }) => {
    onboarding.stage = 'completed';
    const envelope = JSON.stringify({ version: 1, dismissedStep: null, completedAt: Date.now() });
    await page.context().addInitScript(seedInitScript({ 'autoflow-onboarding:v1': envelope }));
    await page.goto('/dashboard');
    await settle(page);
    expect(await page.getByTestId('dashboard-empty-guide').count()).toBe(0);
    expect(await page.getByTestId('onboarding-complete-banner').count()).toBe(0);
    await recordShot(page, '04-completed-legacy', onboarding);
  });

  test('执行记录真空态：「前往任务列表」CTA 跳 /tasks', async ({ page, onboarding }) => {
    onboarding.stage = 'welcome';
    await page.context().addInitScript(seedInitScript());
    await page.goto('/executions');
    await settle(page);
    await page.getByRole('button', { name: '前往任务列表' }).click();
    await expect(page).toHaveURL(/\/tasks$/);
    // 等任务列表懒加载 chunk 落地，避免截图停留在上一跳转帧。
    await page.waitForTimeout(600);
    await recordShot(page, '05-executions-vacuum-tasks', onboarding);
  });

  test('会话内迁入 completed：一次性收口横幅出现', async ({ page, onboarding }) => {
    onboarding.stage = 'welcome';
    await page.context().addInitScript(seedInitScript());
    await page.goto('/dashboard');
    await settle(page);
    await expect(page.getByTestId('dashboard-empty-guide')).toBeVisible();

    // 摘要第二次拉取回到 completed：点页头刷新触发 refetchSummary，迁入 completed 后弹一次横幅。
    onboarding.stage = 'completed';
    await page.getByRole('button', { name: '刷新' }).click();
    await expect(page.getByTestId('onboarding-complete-banner')).toBeVisible({ timeout: 10_000 });
    await recordShot(page, '06-complete-banner', onboarding);
  });
});
