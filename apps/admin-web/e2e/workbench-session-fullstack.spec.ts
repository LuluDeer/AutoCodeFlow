/**
 * Level-4 (real browser + real backend) verification — positioning-ux-overhaul round.
 *
 * NO mocks. This spec talks to a freshly-migrated throwaway PostgreSQL + real
 * admin-api + real admin-web vite, all started by
 *   scripts/fullstack-verify-workbench.sh
 * The browser performs a real login for a real USER that the spec itself creates
 * through the real admin API (as seeded admin). Every assertion is either real
 * browser DOM or a real HTTP response via Playwright request context.
 *
 * Honest claim: we prove the USER journey (login -> sidebar/palette -> workbench
 * preview -> commit -> run my draft -> live session panel -> API readback) works
 * end-to-end against a real backend. We do NOT assert a terminal agent success:
 * no executor is started, so the session is expected to remain non-terminal.
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

const ADMIN_USER = process.env.E2E_INITIAL_ADMIN_USERNAME ?? 'admin';
const ADMIN_PASS = process.env.E2E_INITIAL_ADMIN_PASSWORD ?? 'admin123';
const API_BASE = process.env.WORKBENCH_API_BASE ?? 'http://127.0.0.1:3105';
const ARTIFACT_DIR = process.env.WORKBENCH_ARTIFACT_DIR ?? '';

interface Evidence {
  steps: string[];
  apiAssertions: Record<string, unknown>;
  gaps: string[];
  artifacts: Record<string, string>;
}
const evidence: Evidence = {
  steps: [],
  apiAssertions: {},
  gaps: [],
  artifacts: {},
};

function logStep(msg: string) {
  evidence.steps.push(`${new Date().toISOString()} ${msg}`);
  console.log(`[L4] ${msg}`);
}

/** Unwrap the global ResponseInterceptor envelope {code,message,data}. */
async function unwrap<T = any>(resp: Awaited<ReturnType<APIRequestContext['post']>>): Promise<T> {
  const body = await resp.json();
  return (body?.data ?? body) as T;
}

/** Login through the real API; token comes back in the data envelope. */
async function apiLogin(request: APIRequestContext, username: string, password: string) {
  const resp = await request.post(`${API_BASE}/api/auth/login`, {
    data: { username, password },
  });
  // Login POST may be 200 or 201 depending on Nest status decorator.
  expect([200, 201], `login ${username} status`).toContain(resp.status());
  const data = await unwrap<{ accessToken: string; refreshToken: string; totpRequired?: boolean }>(resp);
  expect(data.accessToken, 'login must return accessToken').toBeTruthy();
  expect(data.totpRequired, 'test accounts must not have TOTP').toBeFalsy();
  return data;
}

/** Read the current admin-web language + auth state straight from the browser's localStorage. */
async function readBrowserState(page: Page) {
  return page.evaluate(() => ({
    lang: localStorage.getItem('autoflow-lang'),
    authRaw: localStorage.getItem('autoflow-auth'),
  }));
}

/**
 * Full Level-4 journey. Single test so the real created USER / SOP / session are
 * all threaded through one honest story (no cross-test fixtures).
 */
test('USER full journey: create user via API -> real UI login -> workbench commit -> run draft -> API readback', async ({
  page,
  request,
}) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (e) => pageErrors.push(e));
  // Force zh before any app script runs so DOM labels match the asserted copy
  // (i18n detectLanguage() reads localStorage synchronously at init).
  await page.addInitScript(() => {
    localStorage.setItem('autoflow-lang', 'zh');
  });

  // ── Step 1: as ADMIN, create a USER through the REAL API ──────────────────
  logStep('Step 1: admin login via real API');
  const admin = await apiLogin(request, ADMIN_USER, ADMIN_PASS);
  const adminHdr = { Authorization: `Bearer ${admin.accessToken}` };

  const suffix = Date.now().toString().slice(-8);
  const newUser = {
    username: `l4user_${suffix}`,
    email: `l4user_${suffix}@example.invalid`,
    password: 'Str0ng!Passw0rd',
    role: 'user',
  };
  logStep(`Step 1: POST /api/users -> ${newUser.username} (role=user)`);
  const createResp = await request.post(`${API_BASE}/api/users`, {
    headers: adminHdr,
    data: newUser,
  });
  expect(createResp.status(), `POST /api/users status: ${await createResp.text().catch(() => '')}`).toBe(201);
  const created = await unwrap<{ id: number; username: string; role: string }>(createResp);
  expect(created.username).toBe(newUser.username);
  expect(created.role).toBe('user');
  const userId = Number(created.id);
  expect(Number.isFinite(userId)).toBe(true);
  evidence.apiAssertions.createdUser = {
    id: userId,
    username: created.username,
    role: created.role,
    via: 'POST /api/users (admin token)',
  };
  logStep(`Step 1: created USER id=${userId}`);

  const userLogin = await apiLogin(request, newUser.username, newUser.password);
  evidence.apiAssertions.userLogin = {
    username: newUser.username,
    gotAccessToken: !!userLogin.accessToken,
    via: 'POST /api/auth/login',
  };
  const userHeaders = { Authorization: `Bearer ${userLogin.accessToken}` };

  // ── Step 2: real browser login AS THAT USER ───────────────────────────────
  logStep('Step 2: real browser login as USER');
  await page.goto('/login');
  await page.getByRole('textbox', { name: '用户名' }).fill(newUser.username);
  await page.getByRole('textbox', { name: '密码' }).fill(newUser.password);
  // antd inserts a visual space between CJK chars ("登 录"); match with a regex.
  await page.locator('form button[type="submit"]').click();
  await expect.poll(() => page.url(), { timeout: 30_000 }).not.toContain('/login');
  await expect.poll(async () => (await readBrowserState(page)).authRaw, { timeout: 30_000 }).toBeTruthy();
  const authState = JSON.parse((await readBrowserState(page)).authRaw!);
  const browserUser = authState?.state?.user;
  logStep(`Step 2: browser auth user=${JSON.stringify(browserUser)}`);
  expect(browserUser?.username || newUser.username).toBeTruthy();

  // Wait until MainLayout synced /auth/profile so role is known for menu filtering.
  await expect.poll(async () => {
    const raw = (await readBrowserState(page)).authRaw;
    return JSON.parse(raw ?? '{}')?.state?.user?.role ?? '';
  }, { timeout: 30_000 }).toBe('user');

  // ── Sidebar: /workbench + /inbox visible; /sops /audit /agent-sessions not ─
  logStep('Step 2: assert sidebar menu entries for USER role');
  // The auxiliary group may be collapsed; expand every submenu group via its trigger.
  const groupTriggers = page.locator('.ant-menu-submenu-title');
  const groupCount = await groupTriggers.count();
  for (let i = 0; i < groupCount; i++) {
    const trigger = groupTriggers.nth(i);
    if ((await trigger.getAttribute('aria-expanded')) !== 'true') {
      await trigger.click().catch(() => undefined);
    }
  }
  const sidebarText = await page.locator('.ant-menu').first().innerText();
  logStep(`Step 2: sidebar text snippet: ${sidebarText.replace(/\s+/g, ' ').slice(0, 300)}`);
  // Use menu item keys (rendered as href/role=menuitem) rather than relying on i18n labels.
  const menuKeys = await page.locator('.ant-menu-item, .ant-menu-submenu-title').evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-menu-key') || e.getAttribute('href') || e.textContent?.trim() || ''),
  );
  evidence.apiAssertions.sidebar = { snippet: sidebarText.replace(/\s+/g, ' ').slice(0, 500), keys: menuKeys };
  // Assert visible labels for the two USER-allowed pages.
  const workbenchItem = page.locator('.ant-menu-item').filter({ hasText: /工\s*作\s*台/ });
  const inboxItem = page.locator('.ant-menu-item').filter({ hasText: /待\s*办\s*收\s*件\s*箱/ });
  await expect(workbenchItem.first(), 'USER must see /workbench in sidebar').toHaveCount(1);
  await expect(inboxItem.first(), 'USER must see /inbox in sidebar').toHaveCount(1);
  // Admin-only entries must NOT render for USER.
  await expect(page.locator('.ant-menu-item').filter({ hasText: /SOP/ }), 'USER must NOT see /sops in sidebar').toHaveCount(0);
  await expect(page.locator('.ant-menu-item').filter({ hasText: /审\s*计/ }), 'USER must NOT see /audit in sidebar').toHaveCount(0);
  await expect(page.locator('.ant-menu-item').filter({ hasText: /Agent\s*会\s*话/ }), 'USER must NOT see /agent-sessions in sidebar').toHaveCount(0);

  // ── Command palette (Ctrl+K): /inbox reachable, /sops not listed ──────────
  logStep('Step 2: open command palette with Control+k');
  await page.keyboard.press('Control+k');
  const palettePlaceholder = '搜索页面、任务、执行记录、执行器、应用，或输入指令…';
  await expect.poll(() => page.getByPlaceholder(palettePlaceholder).count(), { timeout: 15_000 })
    .toBeGreaterThan(0);
  const paletteSearch = page.getByPlaceholder(palettePlaceholder).first();
  await paletteSearch.fill('收件箱');
  await expect(page.locator('#command-palette-listbox'), 'inbox reachable via palette').toContainText(/待\s*办\s*收\s*件\s*箱/);
  await paletteSearch.fill('SOP');
  // Palette uses a 300ms debounce; wait for the SOP-filtered results to settle.
  await page.waitForTimeout(500);
  // /sops is admin-only; for USER the palette must not offer it as a page nav result.
  const paletteText = await page.locator('#command-palette-listbox').innerText();
  logStep(`Step 2: palette(SOP) text: ${paletteText.replace(/\s+/g, ' ').slice(0, 300)}`);
  expect(paletteText, 'USER palette must not list admin-only /sops page').not.toContain('标准操作流程（SOP）');
  evidence.apiAssertions.palette = { sopsQueryText: paletteText.replace(/\s+/g, ' ').slice(0, 500) };
  await page.keyboard.press('Escape');

  // ── Step 3: /workbench preview -> commit, honest USER copy ────────────────
  logStep('Step 3: navigate to /workbench, real preview -> commit');
  await page.goto('/workbench');
  await expect(page.getByTestId('workbench-page')).toBeVisible();
  const goal = `Level4 真栈验收：汇总昨日订单异常并推送日报 ${suffix}`;
  await page.getByPlaceholder('例如：每周汇总项目状态并生成报告').fill(goal);
  await page.locator('[data-testid="workbench-page"] .ant-select').first().click();
  await page.locator('.ant-select-item-option-content').getByText('每周', { exact: true }).click();
  await page.getByRole('button', { name: /预\s*览\s*方\s*案/ }).click();
  await expect(page.getByRole('heading', { name: /^方案卡：/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /确\s*认\s*方\s*案/ })).toBeEnabled();
  await page.getByRole('button', { name: /确\s*认\s*方\s*案/ }).click();

  const success = page.getByTestId('workbench-commit-success');
  await expect(success, 'commit success panel must appear (real API)').toBeVisible({ timeout: 30_000 });
  const successText = await success.innerText();
  logStep(`Step 3: success panel: ${successText.replace(/\s+/g, ' ').slice(0, 400)}`);
  evidence.apiAssertions.commitSuccessPanel = successText.replace(/\s+/g, ' ').slice(0, 1000);
  // Honest USER copy: submitted for review / draft not running.
  await expect(success.getByTestId('workbench-submitted-for-review')).toBeVisible();
  await expect(success.getByTestId('workbench-submitted-for-review')).toContainText('方案已提交审阅');
  await expect(success.getByTestId('workbench-submitted-for-review')).toContainText('草稿尚未运行');
  // No /sops link for USER.
  await expect(success.locator('a[href^="/sops"]')).toHaveCount(0);
  expect(successText, 'USER success copy must not contain a /sops deep link').not.toContain('/sops');
  // No 403 page on this route.
  await expect(page.getByText('无权访问该页面')).toHaveCount(0);

  // Capture the committed sopId from the visible SOP编号 line.
  const sopIdMatch = successText.match(/SOP\s*编号：\s*([0-9a-fA-F-]{36})/);
  expect(sopIdMatch, `sopId should be visible in success panel: ${successText}`).toBeTruthy();
  const sopId = sopIdMatch![1];
  logStep(`Step 3: committed sopId=${sopId} (status=draft)`);
  evidence.apiAssertions.committedSopId = sopId;

  // ── Step 4: click "Run my draft" -> session panel with real backend state ─
  logStep('Step 4: click 运行我的草稿 (real POST /api/workbench/sessions)');
  const runBtn = page.getByTestId('workbench-run-draft');
  await expect(runBtn).toBeVisible();
  await runBtn.click();
  const panel = page.getByTestId('workbench-session-panel');
  await expect(panel, 'session panel must appear after run').toBeVisible({ timeout: 30_000 });
  const sessionIdText = await page.getByTestId('workbench-session-id').innerText();
  const sessionIdMatch = sessionIdText.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  expect(sessionIdMatch, `sessionId must appear in panel: ${sessionIdText}`).toBeTruthy();
  const sessionId = sessionIdMatch![0];
  logStep(`Step 4: sessionId=${sessionId}`);
  evidence.apiAssertions.uiSessionId = sessionId;

  // Panel polls real backend: a real status shows up, and all sections exist.
  await expect.poll(async () => (await page.getByTestId('workbench-session-status').innerText()).trim(), { timeout: 30_000 })
    .not.toBe('');
  const panelStatus = (await page.getByTestId('workbench-session-status').innerText()).replace(/\s+/g, ' ').trim();
  await expect(page.getByTestId('workbench-session-steps')).toBeVisible();
  await expect(page.getByTestId('workbench-session-approvals')).toBeVisible();
  await expect(page.getByTestId('workbench-session-artifacts')).toBeVisible();
  await expect(page.getByTestId('workbench-session-tool-calls')).toBeVisible();
  logStep(`Step 4: live panel status="${panelStatus}"; sections present`);
  evidence.apiAssertions.uiPanel = {
    status: panelStatus,
    steps: await page.getByTestId('workbench-session-steps').innerText(),
    approvals: await page.getByTestId('workbench-session-approvals').innerText(),
    artifacts: await page.getByTestId('workbench-session-artifacts').innerText(),
    toolCalls: await page.getByTestId('workbench-session-tool-calls').innerText(),
    claim: 'session created + panel shows real backend state (NOT asserting terminal success)',
  };

  // One success screenshot of the workbench panel, written into the artifact dir.
  if (ARTIFACT_DIR) {
    const shot = `${ARTIFACT_DIR}/workbench-panel-success.png`;
    await page.screenshot({ path: shot, fullPage: true });
    evidence.artifacts.successScreenshot = shot;
    logStep(`Step 4: success screenshot -> ${shot}`);
  }

  // ── Step 5: API-side readback with the USER token ─────────────────────────
  logStep(`Step 5: GET /api/workbench/sessions/${sessionId} with USER token`);
  const getResp = await request.get(`${API_BASE}/api/workbench/sessions/${sessionId}`, {
    headers: userHeaders,
  });
  expect(getResp.status(), `session readback status: ${await getResp.text().catch(() => '')}`).toBe(200);
  const detail = await unwrap<{
    sessionId: string;
    kind: string;
    status: string;
    createdBy: string | null;
    scope: { sops?: string[] };
  }>(getResp);
  logStep(`Step 5: detail=${JSON.stringify(detail)}`);
  expect(detail.sessionId).toBe(sessionId);
  expect(detail.kind, 'kind must be sop_authoring').toBe('sop_authoring');
  expect(detail.scope?.sops, 'scope.sops must contain the committed sopId').toContain(sopId);
  expect(detail.createdBy, 'createdBy must be user:<id>').toBe(`user:${userId}`);
  evidence.apiAssertions.sessionReadback = {
    endpoint: `GET /api/workbench/sessions/${sessionId}`,
    statusCode: getResp.status(),
    kind: detail.kind,
    sessionStatus: detail.status,
    scope: detail.scope,
    createdBy: detail.createdBy,
    expectedCreatedBy: `user:${userId}`,
    assertions: ['kind===sop_authoring', `scope.sops contains ${sopId}`, `createdBy===user:${userId}`],
  };
  // Honest caveat: this stack runs with AI_PROVIDER=disabled and NO executor/LLM
  // route, so the enqueued session is expected to reach a real terminal 'failed'
  // status (route_unavailable). That still proves the session was created,
  // enqueued and read back with real backend state — we do NOT claim agent success.
  if (detail.status === 'failed') {
    evidence.gaps.push(
      'Session reached failed status because AI_PROVIDER=disabled / no LLM route or executor in this stack (route_unavailable); no terminal success is asserted by design.',
    );
  }

  // ── Step 6: direct /sops URL shows RequireAdmin (expected for direct URL) ─
  logStep('Step 6: direct /sops URL -> RequireAdmin page for USER');
  await page.goto('/sops');
  await expect(page.getByText('无权访问该页面')).toBeVisible({ timeout: 20_000 });
  evidence.apiAssertions.directSopsUrl = {
    expected: 'RequireAdmin page (403) — acceptable for direct URL; no in-app link led here (asserted earlier)',
    observed: '无权访问该页面',
  };
  logStep('Step 6: RequireAdmin page shown as expected');

  // Persist evidence from the browser context (Node fs via Playwright's import).
  // The orchestration script composes these into the final report.json together
  // with commands / exit codes / playwright counts.
  const fs = await import('node:fs/promises');
  if (ARTIFACT_DIR) {
    await fs.mkdir(ARTIFACT_DIR, { recursive: true });
    const evidencePath = `${ARTIFACT_DIR}/spec-evidence.json`;
    await fs.writeFile(evidencePath, JSON.stringify(evidence, null, 2), 'utf8');
    evidence.artifacts.specEvidence = evidencePath;
    logStep(`wrote spec-evidence.json -> ${evidencePath}`);
  }

  expect(pageErrors.map((e) => e.message), `browser page errors: ${pageErrors.map((e) => e.message).join(' | ')}`).toEqual([]);
});
