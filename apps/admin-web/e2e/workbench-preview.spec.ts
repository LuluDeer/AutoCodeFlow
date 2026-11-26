/**
 * 工作台方案卡 · 真浏览器 e2e —— GCO 证伪判据：
 *   「业务人员不填 cron / UUID / glue 就能拿到方案卡，并把它确认落成 SOP 草稿」
 *
 * ⚠️ 验收口径（诚实标注，绝不假装真后端）：
 *   - 真浏览器 DOM：真实 Chromium 渲染真实 SPA（/workbench，RequireAdmin 门控），
 *     所有断言走 DOM innerText / role / data-testid。
 *   - 传输层 mock：page.route 全量拦截但只处理 fetch/xhr，按 pathname **后缀**分派
 *     并返回契约形状 fixture（preview 对齐 workbench.ts 的 PreviewPlanResult，
 *     commit 对齐 CommitResultDto）。匹配与 VITE_API_URL_INTERNAL 形态无关
 *     （'/api' 或绝对 URL 都可命中）；**切勿覆盖 VITE_API_URL_\* 环境变量**——
 *     一旦把 baseURL 改到别处，后缀匹配会假绿。
 *   - 本 e2e 环境不提供真后端（PG/JWT），故传输层造假；验收级别 =
 *     浏览器（传输层 mock）。本 spec 不证明后端真跑。
 *
 * 登录策略：沿用 e2e/ 既有 seedAuth 约定——localStorage('autoflow-auth') 注入
 *   admin role 会话（RequireAdmin 只认 user.role==='admin'，已有 role 不再拉 profile）。
 * config：playwright.config.ts（testDir './e2e'）。
 */
import { test, expect, type Page } from '@playwright/test';

const GOAL = '每月 5 号导出销售报表';
const CARD_HASH = 'a1b2c3d4e5f60718';
/** preview 返回的策略代际（16 hex），commit 须原样回填为 expectedPolicyGeneration。 */
const POLICY_GENERATION = '0f1e2d3c4b5a6978';
/** 核心证伪词表：这些运行时术语不应出现在业务人员看到的工作台文本里。 */
const RUNTIME_TERMS = ['cron', 'executor', 'uuid', 'glue', 'front-matter'];

/** commit 契约 fixture（逐字段对齐 admin-api CommitResultDto：只 draft，不自动发布）。 */
const COMMIT_FIXTURE = {
  sopId: 'sop-e2e-0001',
  slug: 'workbench-a1b2c3d4',
  status: 'draft' as const,
  next: '请在 SOP 页面审阅并发布',
};

interface Check {
  field: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
}

/** 契约形状 fixture：monthly 的 triggerText 固定为「每月 N 日」（preview-validator.ts 查表）。 */
function previewFixture(overrides: { eligible?: boolean; checks?: Check[] } = {}) {
  const okChecks: Check[] = [
    { field: 'goal', status: 'ok', message: '目标已登记' },
    { field: 'cadence', status: 'ok', message: '触发语句确定性回读：每月 N 日' },
    { field: 'capabilityId', status: 'ok', message: '能力 browser 命中内置白名单' },
    { field: 'budget.maxTurns', status: 'ok', message: '预算 10 步在上限 20 内' },
  ];
  return {
    eligible: overrides.eligible ?? true,
    card: {
      title: `方案卡：${GOAL}`,
      triggerText: '每月 N 日',
      capabilityHints: ['browser'],
      acceptanceText: `完成「${GOAL}」并留存可复核结果。`,
      budget: { maxTurns: 10 },
    },
    checks: overrides.checks ?? okChecks,
    cardHash: CARD_HASH,
    policyGeneration: POLICY_GENERATION,
  };
}

/**
 * 传输层 mock：与 baseURL 形态完全无关。
 * 全部用「resourceType ∈ {fetch,xhr} + pathname 后缀」判定，绝不用 startsWith('/api/')。
 * 静态资源 / document 导航一律 continue，避免把 SPA 自身 mock 掉。
 * reply 统一走前端 client 的 { code, data } 信封（interceptor 自动解包 data）。
 */
async function seedApi(page: Page, fixture: ReturnType<typeof previewFixture>) {
  const previewCalls: Array<{ goal?: string; cadence?: string; params?: unknown }> = [];
  const commitCalls: Array<{
    goal?: string;
    cadence?: string;
    params?: unknown;
    expectedCardHash?: string;
    expectedPolicyGeneration?: string;
  }> = [];
  const reply = (route: import('@playwright/test').Route, data: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ code: 0, data }) });

  await page.route('**/*', async (route) => {
    const req = route.request();
    const rt = req.resourceType();
    // 仅拦 API 调用；script/stylesheet/image/document（含 SPA 导航、vite 模块）全部放行。
    if (rt !== 'fetch' && rt !== 'xhr') return route.continue();
    const path = new URL(req.url()).pathname;

    if (path.endsWith('/workbench/preview')) {
      if (req.method() !== 'POST') return route.continue();
      previewCalls.push(req.postDataJSON());
      return reply(route, fixture);
    }
    if (path.endsWith('/workbench/commit')) {
      if (req.method() !== 'POST') return route.continue();
      commitCalls.push(req.postDataJSON());
      return reply(route, COMMIT_FIXTURE);
    }
    // NotificationBell（MainLayout 顶栏）对 /metrics/failures 的 data 直接 .filter()：
    // 必须是数组，不能用兜底的 {items,total}——否则被 RouteErrorBoundary 拦截成
    // 「list.filter is not a function」，workbench 根本渲染不出来（与 agent-session-journey 同口径）。
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
    // 其余未知 API：安全空集合兜底（不 {items,total} 误伤数组消费者时用不到，上面已列全）。
    return reply(route, { items: [], total: 0 });
  });
  return { previewCalls, commitCalls };
}

async function seedAuth(page: Page) {
  await page.goto('/login');
  await page.evaluate(() => {
    localStorage.setItem('autoflow-lang', 'zh');
    localStorage.setItem('autoflow-auth', JSON.stringify({
      state: {
        token: 'e2e-workbench-access',
        refreshToken: 'e2e-workbench-refresh',
        user: { id: 1, username: 'admin', role: 'admin' },
      },
      version: 0,
    }));
  });
}

async function expectNoRuntimeTerms(page: Page, phase: string) {
  const text = (await page.getByTestId('workbench-page').innerText()).toLowerCase();
  for (const term of RUNTIME_TERMS) {
    expect(text, `${phase}：工作台 DOM 不应出现运行时术语 "${term}"`).not.toContain(term);
  }
}

/** 业务语言填一句 + 频率选 monthly → 拿到方案卡 → 确认落草稿；全程无运行时术语。 */
test('业务语言 + monthly 得方案卡，确认落草稿并显示 slug（传输层 mock）', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (e) => pageErrors.push(e));
  const { previewCalls, commitCalls } = await seedApi(page, previewFixture());
  await seedAuth(page);

  await page.goto('/workbench');
  await expect(page.getByTestId('workbench-page')).toBeVisible();
  // 证伪核心①：预览前，业务字段里没有要求填任何运行时术语。
  await expectNoRuntimeTerms(page, '预览前');
  await expect(page.getByText('业务目标', { exact: true })).toBeVisible();
  await expect(page.getByText('执行频率', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '预览方案' })).toBeVisible();

  await page.getByPlaceholder('例如：每周汇总项目状态并生成报告').fill(GOAL);
  await page.locator('[data-testid="workbench-page"] .ant-select').first().click();
  await page.locator('.ant-select-item-option-content').getByText('每月', { exact: true }).click();
  await page.getByRole('button', { name: '预览方案' }).click();

  await expect.poll(() => previewCalls.length).toBe(1);
  expect(previewCalls[0]).toMatchObject({ goal: GOAL, cadence: 'monthly' });

  const card = page.locator('.ant-card').filter({ has: page.getByRole('heading', { name: /^方案卡：/ }) });
  await expect(card).toBeVisible();
  await expect(card).toContainText(GOAL);                       // 业务语句回显（标题）
  await expect(card).toContainText('每月 N 日');                  // triggerText：业务化频率
  await expect(card).toContainText(`完成「${GOAL}」并留存可复核结果。`); // 验收标准
  await expect(card).toContainText('最多 10 轮');                 // 预算
  await expect(card).toContainText('能力提示：');
  await expect(card.getByText('browser', { exact: true })).toBeVisible(); // 能力提示 tag
  await expect(card).toContainText('核查结果：');
  await expect(card.locator('.ant-tag')).not.toHaveCount(0);      // checks 徽标
  await expect(card).toContainText('目标已登记');

  // 证伪核心②：拿到方案卡后，DOM 文本仍不含任何运行时术语。
  await expectNoRuntimeTerms(page, '预览后');

  const confirm = page.getByRole('button', { name: '确认方案' });
  await expect(confirm).toBeEnabled();                           // eligible=true 且无 fail
  await confirm.click();

  // 确认真的走了 commit 端点，且把 preview 的 cardHash / policyGeneration 原样回填。
  await expect.poll(() => commitCalls.length).toBe(1);
  expect(commitCalls[0]).toMatchObject({
    goal: GOAL,
    cadence: 'monthly',
    expectedCardHash: CARD_HASH,
    expectedPolicyGeneration: POLICY_GENERATION,
  });

  // 成功反馈：草稿态、slug、审阅链接——绝不出现「已执行/已完成」。
  const success = page.getByTestId('workbench-commit-success');
  await expect(success).toBeVisible();
  await expect(success).toContainText(COMMIT_FIXTURE.slug);
  await expect(success).toContainText(COMMIT_FIXTURE.sopId);
  await expect(success).toContainText('草稿');
  await expect(success).toContainText('已存为草稿');
  await expect(success).not.toContainText('已执行');
  await expect(success.getByRole('link', { name: '去 SOP 页审阅' })).toHaveAttribute(
    'href', `/sops?sop=${COMMIT_FIXTURE.sopId}`,
  );

  // 本地留痕 cardHash 与策略代际短 hash 仍在。
  const record = page.getByTestId('workbench-confirm-record');
  await expect(record).toBeVisible();
  await expect(record).toContainText(CARD_HASH);
  await expect(record).toContainText(POLICY_GENERATION.slice(0, 8));

  expect(pageErrors.map((e) => e.message)).toEqual([]);
});

/** 同一路径把 fixture 改成 eligible=false + 一条 fail：确认按钮禁用，且不产生留痕、不发 commit。 */
test('eligible=false 且存在 fail 核查项时确认按钮禁用（传输层 mock）', async ({ page }) => {
  const failedChecks: Check[] = [
    { field: 'goal', status: 'ok', message: '目标已登记' },
    { field: 'cadence', status: 'ok', message: '触发语句确定性回读：每月 N 日' },
    { field: 'capabilityId', status: 'fail', message: '能力不在内置白名单' },
  ];
  const pageErrors: Error[] = [];
  page.on('pageerror', (e) => pageErrors.push(e));
  const { previewCalls, commitCalls } = await seedApi(page, previewFixture({ eligible: false, checks: failedChecks }));
  await seedAuth(page);

  await page.goto('/workbench');
  await expect(page.getByTestId('workbench-page')).toBeVisible();
  await page.getByPlaceholder('例如：每周汇总项目状态并生成报告').fill(GOAL);
  await page.locator('[data-testid="workbench-page"] .ant-select').first().click();
  await page.locator('.ant-select-item-option-content').getByText('每月', { exact: true }).click();
  await page.getByRole('button', { name: '预览方案' }).click();
  await expect.poll(() => previewCalls.length).toBe(1);

  const card = page.locator('.ant-card').filter({ has: page.getByRole('heading', { name: /^方案卡：/ }) });
  await expect(card).toBeVisible();
  await expect(card).toContainText('当前方案尚不满足执行条件');
  await expect(page.getByRole('button', { name: '确认方案' })).toBeDisabled();
  await expect(page.getByTestId('workbench-confirm-record')).toHaveCount(0);
  expect(commitCalls).toHaveLength(0);

  expect(pageErrors.map((e) => e.message)).toEqual([]);
});
