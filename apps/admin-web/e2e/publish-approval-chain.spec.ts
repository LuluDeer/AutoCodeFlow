/**
 * 第 72 轮 · 方案卡 → 四眼审批 → 主管批准 → 待办消失 · 真浏览器 e2e
 *
 * 业务故事（本轮验收路径）：
 *   业务人员（role=user）在工作台提交方案卡 → 看到「已提交四眼审批」
 *   → 主管（role=admin）在 /inbox「待我审批」看到发布审批卡（被批对象 + 四眼红线）
 *   → 主管批准 → 该待办从列表消失。
 *
 * ⚠️ 验收口径（诚实标注，绝不假装真后端）：
 *   - 真浏览器 DOM：真实 Chromium 渲染真实 SPA（/workbench 与 /inbox 均为
 *     PrivateRoute 内路由，非 RequireAdmin），所有断言走 DOM innerText / role /
 *     data-testid，不用快照。
 *   - 传输层 mock：page.route 全量拦截但只处理 fetch/xhr，按 pathname **后缀**分派
 *     并返回契约形状 fixture（preview/commit 对齐 admin-web api/workbench.ts，
 *     pending 行对齐 admin-api AgentPendingApprovalItemDto，grant 对齐
 *     AgentApprovalDecision）。匹配与 VITE_API_URL_* 形态无关（'/api' 或绝对 URL
 *     都能命中）；**切勿覆盖 VITE_API_URL_\* 环境变量**——改了 baseURL，后缀匹配会假绿。
 *   - 本 e2e 环境不提供真后端（PG/JWT/真发布副作用），故传输层造假：
 *     **验收级别 = 浏览器（传输层 mock）。本 spec 不证明后端真跑**，
 *     也不证明系统代理真的发布了 SOP。
 *
 * 登录策略：沿用 e2e/ 既有 seedAuth 约定——localStorage('autoflow-auth') 注入会话
 *   （PrivateRoute 按 refreshToken 判定会话，故 token 与 refreshToken 一并注入）。
 * 语言：localStorage('autoflow-lang')='zh'（既有 config 已钉 zh-CN，本 spec 不改 config）。
 * config：playwright.config.ts（testDir './e2e'，baseURL 默认 http://localhost:5176）。
 */
import { test, expect, type Page, type Route } from '@playwright/test';

const GOAL = '每月 5 号导出销售报表';
const SOP_ID = 'sop-e2e-0072';
const CARD_HASH = 'a1b2c3d4e5f60718';
/** preview 返回的策略代际（16 hex），commit 须原样回填为 expectedPolicyGeneration。 */
const POLICY_GENERATION = '0f1e2d3c4b5a6978';
/** 发布审批单的幂等键（fixture 权威值；页面必须逐字回显）。 */
const APPROVAL_KEY = 'apr-ses-e2e-0072-0123456789abcdef';
const SESSION_ID = 'ses-e2e-0072';

/** commit 契约 fixture（对齐 CommitResultDto + 本轮新增的审批单锚点）。 */
const COMMIT_FIXTURE = {
  sopId: SOP_ID,
  slug: 'workbench-a1b2c3d4',
  status: 'draft' as const,
  next: '已提交四眼审批，请在「待我审批」中查看发布审批卡',
  policyGeneration: POLICY_GENERATION,
  approvalKey: APPROVAL_KEY,
  approval: {
    approvalKey: APPROVAL_KEY,
    status: 'pending',
    toolName: 'sop_publish',
    fourEyes: true,
  },
};

interface Check {
  field: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
}

/** 契约形状 fixture：monthly 的 triggerText 固定为「每月 N 日」（preview-validator.ts 查表）。 */
function previewFixture() {
  const okChecks: Check[] = [
    { field: 'goal', status: 'ok', message: '目标已登记' },
    { field: 'cadence', status: 'ok', message: '触发语句确定性回读：每月 N 日' },
    { field: 'capabilityId', status: 'ok', message: '能力 browser 命中内置白名单' },
    { field: 'budget.maxTurns', status: 'ok', message: '预算 10 步在上限 20 内' },
  ];
  return {
    eligible: true,
    card: {
      title: `方案卡：${GOAL}`,
      triggerText: '每月 N 日',
      capabilityHints: ['browser'],
      acceptanceText: `完成「${GOAL}」并留存可复核结果。`,
      budget: { maxTurns: 10 },
    },
    checks: okChecks,
    cardHash: CARD_HASH,
    policyGeneration: POLICY_GENERATION,
  };
}

/**
 * `GET /agent/approvals/pending` 的单行契约（逐字对齐 admin-api
 * `AgentPendingApprovalItemDto`：preview 是**人类可读字符串**或 null）。
 *
 * 发布卡的 preview 用「既是合法 JSON、又肉眼可读」的串：实现若 JSON.parse 能取到
 * sopId/cardHash；若直接渲染原文，文本里同样含 sopId/cardHash 与「发布」字样。
 */
interface PendingRow {
  approvalKey: string;
  sessionId: string;
  sessionTitle: string | null;
  toolName: string;
  reason: string | null;
  createdAt: string;
  preview: string | null;
  argsDigest: string | null;
}

function publishRow(overrides: Partial<PendingRow> = {}): PendingRow {
  return {
    approvalKey: APPROVAL_KEY,
    sessionId: SESSION_ID,
    sessionTitle: '方案卡发布审批',
    toolName: 'sop_publish',
    reason: '方案卡确认落草稿后申请发布（四眼）',
    createdAt: '2026-11-27T01:00:00.000Z',
    preview: JSON.stringify({
      sopId: SOP_ID,
      cardHash: CARD_HASH,
      summary: `发布方案卡「${GOAL}」`,
    }),
    argsDigest: CARD_HASH.repeat(4).slice(0, 64),
    ...overrides,
  };
}

/** 非发布审批行：必须仍是通用行，不得渲染发布卡。 */
function updateTaskRow(): PendingRow {
  return {
    approvalKey: 'apr-ses-e2e-0072-ffffffffffffffff',
    sessionId: 'ses-e2e-0072-other',
    sessionTitle: '任务更新审批',
    toolName: 'update_task',
    reason: '更新任务触发时间',
    createdAt: '2026-11-27T00:30:00.000Z',
    preview: 'taskId=task-e2e-0072; cron=0 5 * * *',
    argsDigest: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  };
}

interface SeedOptions {
  /** 会话身份（业务人员 / 主管）。 */
  role: 'user' | 'admin';
  /** 初始待审批行。 */
  rows: PendingRow[];
}

/**
 * 传输层 mock：与 baseURL 形态完全无关。
 * 全部用「resourceType ∈ {fetch,xhr} + pathname 后缀」判定，绝不用 startsWith('/api/')。
 * 静态资源 / document 导航一律 continue，避免把 SPA 自身 mock 掉。
 * reply 统一走前端 client 的 { code, data } 信封（interceptor 自动解包 data）。
 */
async function seedApi(page: Page, opts: SeedOptions) {
  const previewCalls: Array<{ goal?: string; cadence?: string }> = [];
  const commitCalls: Array<{
    goal?: string;
    cadence?: string;
    expectedCardHash?: string;
    expectedPolicyGeneration?: string;
  }> = [];
  const grantCalls: Array<{ sessionId: string; approvalKey: string }> = [];
  /** 已被批准的 approvalKey：批准后的 pending 列表不再返回该行（服务端条件写语义）。 */
  const decided = new Set<string>();

  const reply = (route: Route, data: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ code: 0, data }) });

  const pendingPayload = () => {
    const items = opts.rows.filter((r) => !decided.has(r.approvalKey));
    return {
      items,
      total: items.length,
      sessionTotal: new Set(items.map((r) => r.sessionId)).size,
      returned: items.length,
      truncated: false,
      degraded: false,
    };
  };

  await page.route('**/*', async (route) => {
    const req = route.request();
    const rt = req.resourceType();
    // 仅拦 API 调用；script/stylesheet/image/document（含 SPA 导航、vite 模块）全部放行。
    if (rt !== 'fetch' && rt !== 'xhr') return route.continue();
    const path = new URL(req.url()).pathname;

    if (path.endsWith('/workbench/preview')) {
      if (req.method() !== 'POST') return route.continue();
      previewCalls.push(req.postDataJSON());
      return reply(route, previewFixture());
    }
    if (path.endsWith('/workbench/commit')) {
      if (req.method() !== 'POST') return route.continue();
      commitCalls.push(req.postDataJSON());
      return reply(route, COMMIT_FIXTURE);
    }
    // 处置端点（grant / deny）必须先于 /agent/sessions 判定：它们的 pathname 更长。
    if (path.includes('/approvals/') && path.endsWith('/grant')) {
      if (req.method() !== 'POST') return route.continue();
      const m = /\/sessions\/([^/]+)\/approvals\/([^/]+)\/grant$/.exec(path);
      const sessionId = m?.[1] ?? '';
      const approvalKey = m?.[2] ?? '';
      grantCalls.push({ sessionId, approvalKey });
      decided.add(approvalKey);
      return reply(route, {
        ok: true,
        approval: {
          approvalKey,
          status: 'granted',
          decidedBy: 'admin',
          decidedAt: new Date().toISOString(),
          consumedAt: null,
        },
        resumed: false,
      });
    }
    if (path.endsWith('/agent/approvals/pending')) return reply(route, pendingPayload());
    // NotificationBell（MainLayout 顶栏）对 /metrics/failures 的 data 直接 .filter()：
    // 必须是数组，不能用兜底的 {items,total}——否则被 RouteErrorBoundary 拦截成
    // 「list.filter is not a function」，页面根本渲染不出来（与 workbench-preview 同口径）。
    if (path.endsWith('/metrics/failures')) return reply(route, []);
    if (path.endsWith('/projects')) return reply(route, []);
    if (path.endsWith('/auth/profile')) {
      return reply(route, {
        id: opts.role === 'admin' ? 1 : 2,
        username: opts.role === 'admin' ? 'admin' : 'alice',
        role: opts.role,
      });
    }
    if (path.endsWith('/agent/inbox/counts')) {
      const pending = opts.rows.filter((r) => !decided.has(r.approvalKey)).length;
      return reply(route, {
        pendingApprovals: pending,
        waitingSessions: 0,
        stalled: 0,
        backlogged: 0,
        backlogTruncated: false,
        deployments: 0,
        queueStall: 0,
        failedSessions: 0,
        failedWindowHours: 24,
        degraded: false,
      });
    }
    if (path.endsWith('/app-deployments/approvals/pending')) return reply(route, { data: [], total: 0 });
    if (path.endsWith('/sop/clarifications/pending') || path.endsWith('/sop/assignments/lagging')) {
      return reply(route, { items: [], data: [], total: 0, returned: 0, truncated: false, degraded: false });
    }
    if (path.endsWith('/agent/budget')) {
      return reply(route, { maxSteps: 12, maxTokens: 4000, maxToolCalls: 6, wallClockMs: 60_000 });
    }
    if (path.endsWith('/agent/sessions/queue-stall') || path.endsWith('/agent/sessions/backlogged')) {
      return reply(route, { items: [], total: 0, returned: 0, truncated: false, degraded: false });
    }
    // 其余未知 API：安全空集合兜底（数组消费者上面已逐一点名）。
    return reply(route, { items: [], total: 0 });
  });

  return { previewCalls, commitCalls, grantCalls, decided };
}

async function seedAuth(page: Page, role: 'user' | 'admin') {
  await page.goto('/login');
  await page.evaluate(
    ({ role: r }) => {
      localStorage.setItem('autoflow-lang', 'zh');
      localStorage.setItem(
        'autoflow-auth',
        JSON.stringify({
          state: {
            token: `e2e-${r}-access`,
            refreshToken: `e2e-${r}-refresh`,
            user: {
              id: r === 'admin' ? 1 : 2,
              username: r === 'admin' ? 'admin' : 'alice',
              role: r,
            },
          },
          version: 0,
        }),
      );
    },
    { role },
  );
}

/** 业务人员路径：填一句业务语言 + 选「每月」→ 预览 → 确认落草稿。 */
async function submitCard(page: Page) {
  await page.getByPlaceholder('例如：每周汇总项目状态并生成报告').fill(GOAL);
  await page.locator('[data-testid="workbench-page"] .ant-select').first().click();
  await page.locator('.ant-select-item-option-content').getByText('每月', { exact: true }).click();
  await page.getByRole('button', { name: '预览方案' }).click();
  await expect(page.getByRole('button', { name: '确认方案' })).toBeEnabled();
  await page.getByRole('button', { name: '确认方案' }).click();
  await expect(page.getByTestId('workbench-commit-success')).toBeVisible();
}

/**
 * 在发布卡内点「批准」：卡内按钮文案由实现切片决定，故按「批准/同意/approve/grant」
 * 找，找不到再退回卡内最后一个按钮；若实现走二次确认弹窗，补点弹窗主按钮。
 */
async function approveFromCard(page: Page) {
  const card = page.getByTestId('inbox-publish-card');
  const named = card.getByRole('button', { name: /批准|同意|授权|approve|grant/i });
  if ((await named.count()) > 0) {
    await named.first().click();
  } else {
    await card.locator('button').last().click();
  }
  const confirmPrimary = page
    .locator('.ant-modal-confirm .ant-btn-primary, .ant-modal-wrap .ant-btn-primary')
    .first();
  if (await confirmPrimary.isVisible().catch(() => false)) {
    await confirmPrimary.click();
  }
}

test('业务人员提交方案卡成功 → 出现「已提交四眼审批」且 approvalKey 与 fixture 逐字一致（证伪：没有审批单锚点即红）', async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (e) => pageErrors.push(e));
  const { commitCalls } = await seedApi(page, { role: 'user', rows: [] });
  await seedAuth(page, 'user');

  await page.goto('/workbench');
  await expect(page.getByTestId('workbench-page')).toBeVisible();
  await submitCard(page);

  // commit 真的走了端点，并把 preview 的 cardHash / policyGeneration 原样回填。
  await expect.poll(() => commitCalls.length).toBe(1);
  expect(commitCalls[0]).toMatchObject({
    goal: GOAL,
    cadence: 'monthly',
    expectedCardHash: CARD_HASH,
    expectedPolicyGeneration: POLICY_GENERATION,
  });

  const approval = page.getByTestId('workbench-commit-approval');
  await expect(approval).toBeVisible();
  // 状态文案必须说清「四眼」——业务人员要能看懂这不是自己批的。
  await expect(page.getByTestId('workbench-approval-status')).toContainText('四眼');
  // 审批单锚点逐字等于后端返回值（运营拿它去「待我审批」对账）。
  await expect(page.getByTestId('workbench-approval-key')).toHaveText(APPROVAL_KEY);
  // 出口只有「去审批」：链接指向 /inbox。
  await expect(page.getByTestId('workbench-approval-link')).toHaveAttribute('href', /\/inbox/);

  expect(pageErrors.map((e) => e.message)).toEqual([]);
});

test('业务人员视图里没有任何批准/授权按钮（证伪：出现 grant 类按钮即红）', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (e) => pageErrors.push(e));
  const { grantCalls } = await seedApi(page, { role: 'user', rows: [] });
  await seedAuth(page, 'user');

  await page.goto('/workbench');
  await expect(page.getByTestId('workbench-page')).toBeVisible();
  await submitCard(page);

  // 发布权不在业务人员手上：整页（含审批状态块）不得出现任何批准/授权按钮。
  await expect(page.getByRole('button', { name: /批准|同意|授权|approve|grant/i })).toHaveCount(0);
  await expect(page.getByTestId('workbench-commit-approval').getByRole('button')).toHaveCount(0);
  // 也没有偷偷发出 grant 请求。
  expect(grantCalls).toHaveLength(0);

  expect(pageErrors.map((e) => e.message)).toEqual([]);
});

test('主管 /inbox 看到发布审批卡：被批对象摘要 + 四眼红线 + 复核链接，且卡内无「直接发布」（证伪：卡缺失或出现直接发布即红）', async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (e) => pageErrors.push(e));
  await seedApi(page, { role: 'admin', rows: [publishRow()] });
  await seedAuth(page, 'admin');

  await page.goto('/inbox');
  await expect(page.getByTestId('inbox-page')).toBeVisible();

  const card = page.getByTestId('inbox-publish-card');
  await expect(card).toBeVisible();

  // 被批对象：sopId 与 cardHash 摘要必须可见（主管要知道自己在批哪张卡）。
  const preview = card.getByTestId('inbox-publish-preview');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText(SOP_ID);
  await expect(preview).toContainText(CARD_HASH);

  // 四眼红线：批准之后由系统代理发布，不是主管自己发布。
  await expect(card.getByTestId('inbox-publish-four-eyes')).toContainText('系统代理');

  // 复核入口深链回该审批单（href 带 approvalKey）。
  await expect(card.getByTestId('inbox-publish-review')).toHaveAttribute('href', new RegExp(APPROVAL_KEY));

  // 卡内绝不出现「直接发布」——发布权=指令注入权。
  await expect(card.getByRole('button', { name: /直接发布/ })).toHaveCount(0);
  await expect(card.getByText(/直接发布/)).toHaveCount(0);

  expect(pageErrors.map((e) => e.message)).toEqual([]);
});

test('主管批准后该待办从列表消失且页面不崩（证伪：grant 未发出或卡仍在即红）', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (e) => pageErrors.push(e));
  const { grantCalls } = await seedApi(page, { role: 'admin', rows: [publishRow()] });
  await seedAuth(page, 'admin');

  await page.goto('/inbox');
  await expect(page.getByTestId('inbox-page')).toBeVisible();
  await expect(page.getByTestId('inbox-publish-card')).toBeVisible();

  await approveFromCard(page);

  // 批准真的打到了 grant 端点，且定位到这张单。
  await expect.poll(() => grantCalls.length).toBe(1);
  expect(grantCalls[0]).toMatchObject({ sessionId: SESSION_ID, approvalKey: APPROVAL_KEY });

  // 刷新后的 pending 列表已不含该 approvalKey ⇒ 卡与行一起消失。
  await expect(page.getByTestId('inbox-publish-card')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator('[data-testid="inbox-row-agentApprovals"]')).toHaveCount(0);
  // 页面不崩：外壳仍在，且没有未捕获异常。
  await expect(page.getByTestId('inbox-page')).toBeVisible();
  expect(pageErrors.map((e) => e.message)).toEqual([]);
});

test('非 sop_publish 的审批行（toolName=update_task）仍是通用行、不渲染发布卡（证伪：该行出现发布卡即红）', async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (e) => pageErrors.push(e));
  await seedApi(page, { role: 'admin', rows: [publishRow(), updateTaskRow()] });
  await seedAuth(page, 'admin');

  await page.goto('/inbox');
  await expect(page.getByTestId('inbox-page')).toBeVisible();

  // 两行都在，且只有一行是发布卡。
  await expect(page.locator('[data-testid="inbox-row-agentApprovals"]')).toHaveCount(2);
  await expect(page.getByTestId('inbox-publish-card')).toHaveCount(1);

  const genericRow = page.locator('[data-testid="inbox-row-agentApprovals"]').filter({ hasText: 'update_task' });
  await expect(genericRow).toHaveCount(1);
  await expect(genericRow.getByTestId('inbox-publish-card')).toHaveCount(0);
  await expect(genericRow.getByTestId('inbox-publish-preview')).toHaveCount(0);

  expect(pageErrors.map((e) => e.message)).toEqual([]);
});

test('approval.preview 为 null 时发布卡显示降级文案而不是空白/原始 null（证伪：空白或渲染 null 即红）', async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (e) => pageErrors.push(e));
  await seedApi(page, { role: 'admin', rows: [publishRow({ preview: null })] });
  await seedAuth(page, 'admin');

  await page.goto('/inbox');
  await expect(page.getByTestId('inbox-page')).toBeVisible();

  const card = page.getByTestId('inbox-publish-card');
  await expect(card).toBeVisible();
  const preview = card.getByTestId('inbox-publish-preview');
  await expect(preview).toBeVisible();

  const text = (await preview.innerText()).trim();
  expect(text.length, '降级文案不得为空').toBeGreaterThan(0);
  expect(text).not.toContain('null');
  expect(text).not.toContain('undefined');
  // 仍然是一张可用的审批卡：四眼红线与复核入口不因缺预览而消失。
  await expect(card.getByTestId('inbox-publish-four-eyes')).toContainText('系统代理');
  await expect(card.getByTestId('inbox-publish-review')).toHaveAttribute('href', new RegExp(APPROVAL_KEY));

  expect(pageErrors.map((e) => e.message)).toEqual([]);
});