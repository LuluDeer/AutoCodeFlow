/**
 * R5（第 74–78 轮验收补洞）：发布审批链「真后端 + 真浏览器」合体 e2e。
 *
 * 与既有分级验收的边界：
 *  - apps/admin-web/e2e/publish-approval-chain.spec.ts 是**传输层 mock**（page.route 喂 fixture）；
 *  - apps/admin-api/test/release-approval.e2e-spec.ts 等是**真 PG 进程内**（假传输层）；
 *  - 本文件是**第 4 级真栈**：e2e-full.sh 起的真 PG(:15432) + 真 admin-api(:3105) +
 *    真 Vite(:5176) + 真 Chromium；浏览器侧**零 page.route / 零 response stub**，
 *    axios client 真发请求，断言真库副作用。
 *
 * 四个假设的真栈取证点：
 *  H1 baseURL/前缀：记录 page request/response 事件；浏览器请求必须命中 /api 且无 404。
 *  H2 信封差异：记录响应体是否 {code,message,data}、client 解包后 UI 是否拿到数据。
 *  H3 DTO/守卫：多余字段 → 400（forbidNonWhitelisted）；篡改 expectedCardHash → 400；
 *     发起人（business user）自批 → 403（四眼）。
 *  H4 审计异步：writeAudit 是 fire-and-forget，用 expect.poll 等待 audit_logs 落库。
 *
 * 真库副作用断言（不是「接口返回成功」）：
 *  · agent_approvals.status == 'consumed'
 *  · sop_versions 中 "publishedBy"='agent:tool-call' 恰好 1 行
 *  · audit_logs 有 action='sop_publish.release_succeeded' 且 resourceId=approvalKey
 */
const { test, expect } = require('@playwright/test');
const { createRequire } = require('module');
const path = require('path');

const BASE = process.env.E2E_BASE_URL || 'http://localhost:5176';
const API = process.env.E2E_API_BASE || 'http://localhost:3105';
const GOAL = '每月 5 号导出销售报表（R5 真栈验收）';

// 提交人（workbench 对 ADMIN/USER 都开放）/ 主管：全部由本 spec 经真 API 建在 e2e 空库上。
// 提交人刻意用 ADMIN 角色：grant 端点类级 @Roles(ADMIN) 会先把 USER 挡在 403，
// 只有 ADMIN 提交人才能打到 agent.controller.ts:666-674 的「发布自批硬拒」分支（H3③）。
const BIZ_USER = 'e2e_r5_submitter';
const BIZ_PASS = 'R5e2e#Business2026';
const SUP_USER = 'e2e_r5_supervisor';
const SUP_PASS = 'R5e2e#Supervisor2026';

// pg 客户端从 admin-api 的依赖树加载（admin-web 侧未装 pg）。
const requireFromApi = createRequire(
  path.join(__dirname, '..', '..', '..', 'admin-api', 'package.json'),
);
const { Client } = requireFromApi('pg');

const DB_CFG = {
  host: process.env.E2E_DB_HOST || '127.0.0.1',
  port: Number(process.env.E2E_DB_PORT || 15432),
  user: process.env.E2E_DB_USER || 'autoflow',
  password: process.env.E2E_DB_PASS || 'test',
};

// ── 网络证据（page request/response 事件，绝不 page.route）─────────────────
function attachNetworkLog(page, sink) {
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('/api/') || /:3105\//.test(u)) {
      sink.push({ dir: 'req', method: r.method(), url: u, at: Date.now() });
    }
  });
  page.on('response', (r) => {
    const u = r.url();
    if (u.includes('/api/') || /:3105\//.test(u)) {
      sink.push({ dir: 'res', status: r.status(), url: u, at: Date.now() });
    }
  });
  page.on('requestfailed', (r) => {
    const u = r.url();
    if (u.includes('/api/') || /:3105\//.test(u)) {
      sink.push({
        dir: 'failed',
        url: u,
        error: r.failure()?.errorText || '',
        at: Date.now(),
      });
    }
  });
}

function netSummary(net) {
  const responses = net.filter((e) => e.dir === 'res');
  const failures = net.filter((e) => e.dir === 'failed' || e.status >= 400);
  return {
    apiResponses: responses.length,
    bad: failures.slice(-12).map((e) => ({
      status: e.status,
      error: e.error,
      url: e.url.replace(BASE, '').replace(API, ''),
    })),
  };
}

// ── API（Node 侧 request fixture，仅用于 fixture 准备与负例探针）────────────
async function apiLogin(request, username, password) {
  const r = await request.post(`${API}/api/auth/login`, {
    data: { username, password },
  });
  const d = await r.json();
  const tok = d?.data?.accessToken ?? d?.accessToken;
  if (!tok) throw new Error(`API 登录失败 ${r.status()}: ${JSON.stringify(d).slice(0, 200)}`);
  return tok;
}

async function ensureUser(request, adminTok, username, password, role) {
  const r = await request.post(`${API}/api/users`, {
    headers: { Authorization: `Bearer ${adminTok}` },
    data: { username, email: `${username}@example.invalid`, password, role },
  });
  if (r.status() !== 201 && r.status() !== 409) {
    throw new Error(`建用户失败 ${username}: ${r.status()} ${(await r.text()).slice(0, 200)}`);
  }
}

// ── 真库连接：e2e-full.sh 每次新建时间戳库，自动发现最新一个 ────────────────
async function connectE2eDb() {
  const admin = new Client({ ...DB_CFG, database: 'postgres' });
  await admin.connect();
  let dbName;
  try {
    const { rows } = await admin.query(
      `SELECT datname FROM pg_database
        WHERE datname LIKE 'autoflow_e2e_ci\\_%'
        ORDER BY datname DESC LIMIT 1`,
    );
    dbName = rows?.[0]?.datname;
  } finally {
    await admin.end();
  }
  if (!dbName) throw new Error('未发现 e2e-full.sh 创建的时间戳库 autoflow_e2e_ci_*');
  const client = new Client({ ...DB_CFG, database: dbName });
  await client.connect();
  return { client, dbName };
}

async function pollRow(pg, sql, params, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const { rows } = await pg.query(sql, params);
    last = rows[0];
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`等待 DB 条件超时（${timeoutMs}ms）：${sql} 最后值=${JSON.stringify(last)}`);
}

// ── UI 辅助（复用 legacy e2e-full.spec.js 的选择器风格）─────────────────────
async function injectApi(page) {
  await page.addInitScript(([api]) => {
    window.__E2E_API__ = api;
  }, [API]);
}

async function loginAs(page, username, password, net) {
  await injectApi(page);
  await page.goto(`${BASE}/login`);
  const userInput = page
    .locator('input[id*="username"], input[placeholder*="用户名"], input[placeholder*="username"], input[name="username"]')
    .first();
  await userInput.fill(username);
  await page.locator('input[type="password"]').first().fill(password);
  await page.locator('button[type="submit"]').click();
  try {
    await page.waitForFunction(() => !location.pathname.includes('/login'), {
      timeout: 15000,
    });
  } catch (err) {
    const bad = net.filter(
      (e) => /auth\/login/.test(e.url) && (e.status >= 400 || e.dir === 'failed'),
    );
    if (bad.length) {
      throw new Error(
        `登录未跳转——真栈浏览器 API 请求失败（H1/H2 证据）：${JSON.stringify(bad.slice(-4))}`,
      );
    }
    throw err;
  }
  console.log(`  ✓ 真栈 UI 登录：${username}`);
}

async function approveFromCard(page) {
  const card = page.getByTestId('inbox-publish-card');
  const named = card.getByRole('button', { name: /批准|同意|授权|approve|grant/i });
  if ((await named.count()) > 0) {
    await named.first().click();
  } else {
    await card.locator('button').last().click();
  }
  const confirm = page
    .locator('.ant-modal-confirm .ant-btn-primary, .ant-modal-wrap .ant-btn-primary')
    .first();
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
}

test('R5 真栈发布审批链：业务提交 → 主管批准 → 真库副作用（含 H1/H2/H3/H4 取证）', async ({
  page,
  request,
}) => {
  test.setTimeout(180000);
  const net = [];
  attachNetworkLog(page, net);
  let pg;
  let released = false;
  try {
    // ── fixture：真 API 建业务人员 + 主管 ──────────────────────────────────
    const adminTok = await apiLogin(request, 'admin', 'admin123');
    await ensureUser(request, adminTok, BIZ_USER, BIZ_PASS, 'admin');
    await ensureUser(request, adminTok, SUP_USER, SUP_PASS, 'admin');
    const bizTok = await apiLogin(request, BIZ_USER, BIZ_PASS);

    const conn = await connectE2eDb();
    pg = conn.client;
    console.log(`  ✓ 真库连接：${conn.dbName}`);

    // ── H3①：全局 whitelist + forbidNonWhitelisted ──────────────────────
    const extra = await request.post(`${API}/api/workbench/preview`, {
      headers: { Authorization: `Bearer ${bizTok}` },
      data: { goal: GOAL, cadence: 'monthly', notInDto: 'x' },
    });
    expect(
      extra.status(),
      `H3 多余字段应被 forbidNonWhitelisted 拒绝，实际 ${extra.status()} ${(await extra.text()).slice(0, 200)}`,
    ).toBe(400);

    // ── 业务人员真登录 → /workbench 预览提交（真 axios client）────────────
    await loginAs(page, BIZ_USER, BIZ_PASS, net);
    await page.goto(`${BASE}/workbench`);
    await expect(page.getByTestId('workbench-page')).toBeVisible();

    await page.getByPlaceholder('例如：每周汇总项目状态并生成报告').fill(GOAL);
    await page.locator('[data-testid="workbench-page"] .ant-select').first().click();
    await page
      .locator('.ant-select-item-option-content')
      .getByText('每月', { exact: true })
      .click();
    await page.getByRole('button', { name: '预览方案' }).click();
    await expect(page.getByRole('button', { name: '确认方案' })).toBeEnabled();
    await page.getByRole('button', { name: '确认方案' }).click();
    await expect(page.getByTestId('workbench-commit-success')).toBeVisible();

    // H2：UI 必须真正拿到解包后的数据（approvalKey 不是空/占位）
    const approvalKey = (
      (await page.getByTestId('workbench-approval-key').textContent()) || ''
    ).trim();
    expect(approvalKey, 'H2 信封解包后 UI 应显示真 approvalKey').toMatch(/^apr-/);
    console.log(`  ✓ 真栈提交成功，approvalKey=${approvalKey}`);

    // ── H3②：commit 必带 expectedCardHash / expectedPolicyGeneration ────
    const tampered = await request.post(`${API}/api/workbench/commit`, {
      headers: { Authorization: `Bearer ${bizTok}` },
      data: {
        goal: GOAL,
        cadence: 'monthly',
        expectedCardHash: '0000000000000000',
        expectedPolicyGeneration: '0000000000000000',
      },
    });
    expect(tampered.status(), 'H3 篡改 hash/代际应被 400 拒绝').toBe(400);

    // 真库读到待批单（toolName=sop_publish）
    const approval = await pollRow(
      pg,
      `SELECT "approvalKey", "sessionId", "toolName", status, preview
         FROM agent_approvals WHERE "approvalKey" = $1`,
      [approvalKey],
      (r) => !!r && r.toolName === 'sop_publish',
    );
    expect(approval.status).toBe('pending');
    const sessionId = approval.sessionId;
    // 发布卡的「被批对象摘要」只展示 sopId/cardHash/contentHash（不展示 approvalKey），
    // 从真库 preview 里取回这两个锚点，下面按它们断言 UI 没读错信封。
    const releaseArgs = JSON.parse(JSON.parse(approval.preview).args);
    expect(releaseArgs.sopId).toBeTruthy();
    expect(releaseArgs.cardHash).toMatch(/^[0-9a-f]{16}$/);

    // ── H3③：发起人自批必须被硬拒（四眼）────────────────────────────────
    const selfApprove = await request.post(
      `${API}/api/agent/sessions/${sessionId}/approvals/${approvalKey}/grant`,
      { headers: { Authorization: `Bearer ${bizTok}` } },
    );
    expect(selfApprove.status(), 'H3 业务人员自批必须失败').toBe(403);
    expect(
      (await selfApprove.text()).includes('SELF'),
      'H3 拒绝原因应指向自批/角色（四眼），不是别的 403',
    ).toBe(true);
    const stillPending = await pg.query(
      `SELECT status FROM agent_approvals WHERE "approvalKey" = $1`,
      [approvalKey],
    );
    expect(stillPending.rows[0]?.status).toBe('pending');

    // ── 主管真登录 → /inbox 发布卡批准 ───────────────────────────────────
    await loginAs(page, SUP_USER, SUP_PASS, net);
    await page.goto(`${BASE}/inbox`);
    await expect(page.getByTestId('inbox-page')).toBeVisible();
    const card = page.getByTestId('inbox-publish-card');
    await expect(card).toBeVisible({ timeout: 20000 });
    await expect(card.getByTestId('inbox-publish-four-eyes')).toContainText('系统代理');
    await expect(card.getByTestId('inbox-publish-preview')).toContainText(releaseArgs.sopId);
    await expect(card.getByTestId('inbox-publish-preview')).toContainText(releaseArgs.cardHash);
    await approveFromCard(page);

    // ── 真库副作用①：审批单被消费 ───────────────────────────────────────
    const consumed = await pollRow(
      pg,
      `SELECT status, "consumedAt" FROM agent_approvals WHERE "approvalKey" = $1`,
      [approvalKey],
      (r) => r?.status === 'consumed',
      30000,
    );
    expect(consumed.status).toBe('consumed');
    expect(consumed.consumedAt).toBeTruthy();
    released = true;

    // ── 真库副作用②：恰 1 行系统代理发布的 SOP 版本 ──────────────────────
    const versions = await pg.query(
      `SELECT "sopId", version, "contentHash", "publishedBy"
         FROM sop_versions WHERE "publishedBy" = 'agent:tool-call'`,
    );
    expect(
      versions.rows.length,
      '真栈批准后应恰有 1 行系统代理发布版本',
    ).toBe(1);
    expect(versions.rows[0].sopId).toBeTruthy();

    // ── H4：审计是 fire-and-forget，轮询等待真落库 ───────────────────────
    const audit = await pollRow(
      pg,
      `SELECT id, action, "resourceId", result, detail
         FROM audit_logs
        WHERE action = 'sop_publish.release_succeeded' AND "resourceId" = $1`,
      [approvalKey],
      (r) => !!r,
      30000,
    );
    expect(audit.action).toBe('sop_publish.release_succeeded');
    expect(audit.detail?.publishedBy).toBe('agent:tool-call');

    // ── H1/H2：网络证据收口 ──────────────────────────────────────────────
    const responses = net.filter((e) => e.dir === 'res');
    expect(responses.length, '真链路浏览器必须实发 API 请求').toBeGreaterThan(5);
    const notFound = net.filter((e) => e.status === 404);
    expect(
      notFound.map((e) => e.url),
      `H1 真链路出现 404（baseURL/前缀不匹配）：${JSON.stringify(netSummary(net))}`,
    ).toEqual([]);
    const envelopeOk = net.some((e) => e.dir === 'res' && [200, 201].includes(e.status));
    expect(envelopeOk, 'H2 真链路应有 2xx 响应').toBe(true);
    console.log(`[R5-NET] ${JSON.stringify(netSummary(net))}`);
  } catch (err) {
    console.log(`[R5-NET-FAIL] ${JSON.stringify(netSummary(net))}`);
    throw err;
  } finally {
    if (pg) await pg.end();
    if (!released) console.log('  ⚠ 发布副作用未完成（见上方失败原因与网络日志）');
  }
});
