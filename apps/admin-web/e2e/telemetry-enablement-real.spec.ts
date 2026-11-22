import { test, expect, type Page } from '@playwright/test';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * R437 — 「北极星生产启用完整用户操作路径」真浏览器 + 真后端验收。
 *
 * 补 R436/R329 缺口：consent 一律由真浏览器点 Switch → Popconfirm OK / 重授权
 * 按钮触发，抓包在点击后拿到响应；coverage 从真 PG/真后端 status 回读并与 UI
 * testid 逐字对齐；场景 3 用真 confirm 端点反证 opt-out 不拦业务、不写漏斗。
 *
 * 写域：仅本文件 + playwright.telemetry.config.ts。按 PREFIX / fingerprint /
 * installId 造数清理；口令只从 process.env 读，不进文件/日志/截图。
 */
const requireFromApi = createRequire(
  fileURLToPath(new URL('../../admin-api/package.json', import.meta.url)),
);
const { Client } = requireFromApi('pg') as {
  Client: new (cfg: Record<string, unknown>) => {
    connect(): Promise<void>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- e2e fixture: PG 行形状随查询而异
    query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number }>;
    end(): Promise<void>;
  };
};

const API = 'http://127.0.0.1:3105/api';
const PREFIX = 'r437-enable-';
const GATE_KEY = 'telemetry.ttfv.enabled';

/** 合法 64-hex 设备指纹（executor-fingerprint.util.ts FINGERPRINT_RE）。 */
const TEST_FP = createHash('sha256').update(`${PREFIX}fingerprint`).digest('hex');
/** 与 playwright.telemetry.config.ts / 后端 webServer env 同值（非生产 fixture key）。 */
const FIXTURE_SECRETS_KEY =
  '4a6b8c0d2e1f3a5b7c9d0e2f4a6b8c0d2e1f3a5b7c9d0e2f4a6b8c0d2e1f3a5b';
const KEY_BUF = Buffer.from(FIXTURE_SECRETS_KEY, 'hex');
/** 与后端 SecretsCryptoService.deriveAnonymousId 逐字同口径。 */
const deriveId = (input: string, purpose: string): string =>
  createHmac('sha256', KEY_BUF).update(`${purpose}:${input}`).digest('hex').slice(0, 32);
const INSTALL_ID = deriveId(TEST_FP, 'ttfv-install');

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- e2e fixture: API 信封在 data/裸体间动态
type ApiResult = { status: number; body: any };
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- e2e fixture: 动态解包
const unwrap = (body: any): any => body?.data ?? body;

async function api(
  endpoint: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<ApiResult> {
  const res = await fetch(API + endpoint, {
    method: opts.method || 'GET',
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- e2e fixture: 先留原文再按 JSON 解析
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep raw text */
  }
  return { status: res.status, body };
}

const witness = (label: string, payload: object) =>
  console.log(`[R437-WITNESS] ${label} ${JSON.stringify(payload)}`);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- e2e fixture: PG Client 由 requireFromApi 动态构造
let pg: any;
let token = '';
let refreshToken = '';
let user: unknown = null;
let executorId = '';
let taskId = '';
let execId = '';
let execHash = '';
let configHistoryBaseline = 0;

/** 只删本 spec 指纹/install/PREFIX 造的行；不 DROP 表/库，不碰其他 agent 数据。 */
async function cleanRows(): Promise<void> {
  await pg.query(`DELETE FROM funnel_events WHERE install_id = $1`, [INSTALL_ID]);
  await pg.query(`DELETE FROM telemetry_optin WHERE install_id = $1`, [INSTALL_ID]);
  await pg.query(`DELETE FROM task_executions WHERE "taskName" LIKE $1`, [
    `${PREFIX}%`,
  ]);
  await pg.query(`DELETE FROM tasks WHERE name LIKE $1`, [`${PREFIX}%`]);
  await pg.query(
    `DELETE FROM executors WHERE "deviceFingerprint" = $1`,
    [TEST_FP],
  );
}

/** fixture 直写系统总闸（非 consent 端点，不触碰授权行）。 */
async function setGate(value: 'true' | 'false'): Promise<void> {
  const r = await pg.query(
    `UPDATE system_configs SET value = $1, "updatedAt" = NOW() WHERE key = $2`,
    [value, GATE_KEY],
  );
  if (r.rowCount === 0) {
    await pg.query(
      `INSERT INTO system_configs
         (key, value, "valueType", description, "createdAt", "updatedAt")
       VALUES ($1, $2, 'boolean', $3, NOW(), NOW())`,
      [GATE_KEY, value, 'TTFV opt-in system gate (R437 fixture)'],
    );
  }
}

/** 直接 SQL 改闸绕不过 SystemConfigService 的 1s 缓存失效广播；轮询真 status 到目标值。 */
async function waitGate(value: boolean): Promise<void> {
  await expect
    .poll(async () => (await backendStatus()).systemEnabled, { timeout: 5_000 })
    .toBe(value);
}

async function insertExecutor(): Promise<void> {
  await pg.query(
    `INSERT INTO executors (id, "appName", address, "deviceFingerprint")
     VALUES ($1, $2, $3, $4)`,
    [
      executorId,
      `${PREFIX}app`,
      `${PREFIX}${randomUUID()}`,
      TEST_FP,
    ],
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- e2e fixture: status DTO 形状随后端版本
async function backendStatus(): Promise<any> {
  const r = await api('/agent/telemetry/status', { token });
  expect(r.status, 'telemetry status status').toBe(200);
  return unwrap(r.body);
}

async function funnelRows() {
  return (
    await pg.query(
      `SELECT event_name, install_id, execution_id_hash, dedupe_key, ts
         FROM funnel_events WHERE install_id = $1 ORDER BY ts`,
      [INSTALL_ID],
    )
  ).rows;
}

/** 注入真登录态 + 固定英文界面；返回本页 errors 收集器。 */
function injectSession(page: Page) {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  return { pageErrors, consoleErrors };
}

async function openTelemetryTab(page: Page): Promise<void> {
  await page.addInitScript(
    ({ accessToken, refresh, authUser }) => {
      localStorage.setItem(
        'autoflow-auth',
        JSON.stringify({
          state: { token: accessToken, refreshToken: refresh, user: authUser },
          version: 0,
        }),
      );
      // 固定英文文案，避免浏览器语言漂移导致 locator 不稳。
      localStorage.setItem('autoflow-lang', 'en');
    },
    { accessToken: token, refresh: refreshToken, authUser: user },
  );
  await page.goto('/settings', { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'TTFV Consent' }).click();
  await expect(page.getByTestId('telemetry-coverage-value')).toBeVisible();
}

const consentResponse = (page: Page) =>
  page.waitForResponse(
    (resp) =>
      resp.url().includes('/agent/telemetry/consent') &&
      resp.request().method() === 'POST',
    { timeout: 20_000 },
  );

/** 真 UI：点 Switch → 断言 Popconfirm 文案 → 点 OK → 抓点击后的响应。 */
async function clickSwitchConsent(page: Page, join: boolean) {
  const sw = page.getByRole('switch', { name: /Join the TTFV/ });
  const pending = consentResponse(page);
  const clickAt = Date.now();
  await sw.click();
  const pop = page.locator('.ant-popconfirm');
  await expect(pop).toBeVisible();
  expect(await pop.innerText()).toContain(
    join ? 'Join anonymous telemetry?' : 'Revoke anonymous telemetry consent?',
  );
  // R437 P2 回归锚点：join 的描述必须说「所有已注册安装」而非「当前安装」——
  // 后端无参 consent 授权全部 executor（agent.controller.ts:946-949），文案若退回
  // 「current install」会误导多执行器用户，此断言让文案修正不退化。
  if (join) {
    expect(await pop.innerText()).toContain('All registered installs');
  }
  const beforeOk = Date.now();
  await pop.getByRole('button', { name: 'Confirm' }).click();
  const resp = await pending;
  const responseAt = Date.now();
  expect([200, 201]).toContain(resp.status());
  const body = unwrap(await resp.json());
  expect(body?.systemEnabled).toBe(join);
  if (join) expect(body?.installIds).toContain(INSTALL_ID);
  witness('ui-consent', {
    action: join ? 'switch-on+popconfirm-ok' : 'switch-off+popconfirm-ok',
    clickAt,
    beforeOk,
    responseAt,
    afterClickMs: responseAt - clickAt,
    httpStatus: resp.status(),
    systemEnabled: body?.systemEnabled,
    installIds: body?.installIds,
    source: body?.source,
  });
  return resp;
}

/** 真 UI：点 R329 重授权按钮 → 抓点击后的 consent 响应。 */
async function clickReauthorize(page: Page) {
  const pending = consentResponse(page);
  const clickAt = Date.now();
  await page.getByTestId('telemetry-reauthorize-btn').click();
  const resp = await pending;
  const responseAt = Date.now();
  expect([200, 201]).toContain(resp.status());
  const body = unwrap(await resp.json());
  expect(body?.systemEnabled).toBe(true);
  expect(body?.installIds).toContain(INSTALL_ID);
  witness('ui-reauthorize', {
    clickAt,
    responseAt,
    afterClickMs: responseAt - clickAt,
    httpStatus: resp.status(),
    installIds: body?.installIds,
    source: body?.source,
  });
  return resp;
}

test.beforeAll(async () => {
  expect(
    /(^|_)(test|e2e)(_|$)/i.test(process.env.DB_DATABASE || ''),
    'R437 must run against an explicit test/e2e database',
  ).toBe(true);
  expect(process.env.INITIAL_ADMIN_PASSWORD, 'INITIAL_ADMIN_PASSWORD from .env').toBeTruthy();

  pg = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
  });
  await pg.connect();
  const h = await pg.query(
    `SELECT COALESCE(MAX(id), 0)::int AS n FROM config_history`,
  );
  configHistoryBaseline = Number(h.rows?.[0]?.n ?? 0);

  await cleanRows();

  const login = await api('/auth/login', {
    method: 'POST',
    body: {
      username: 'admin',
      password: process.env.INITIAL_ADMIN_PASSWORD,
    },
  });
  expect(login.status, 'login status').toBe(201);
  token = unwrap(login.body)?.accessToken;
  refreshToken = unwrap(login.body)?.refreshToken;
  user = unwrap(login.body)?.user ?? null;
  expect(token, 'accessToken').toBeTruthy();
  expect(refreshToken, 'refreshToken (PrivateRoute session key)').toBeTruthy();

  await setGate('false');
  await waitGate(false);

  executorId = randomUUID();
  await insertExecutor();
  taskId = randomUUID();
  await pg.query(
    `INSERT INTO tasks (id, name, "triggerType") VALUES ($1, $2, 'manual')`,
    [taskId, `${PREFIX}task-${randomUUID()}`],
  );
  execId = randomUUID();
  await pg.query(
    `INSERT INTO task_executions
       (id, "taskId", "taskName", "executorId", synthetic, status, artifacts, "endTime")
     VALUES ($1, $2, $3, $4, false, 'success', $5, $6)`,
    [
      execId,
      taskId,
      `${PREFIX}confirm-task`,
      executorId,
      JSON.stringify([{ name: 'r437-e2e-artifact' }]),
      new Date().toISOString(),
    ],
  );
  execHash = deriveId(execId, 'ttfv-execution');

  const s = await backendStatus();
  expect(s).toMatchObject({
    systemEnabled: false,
    count: 0,
    coverage: 'gate_off',
    knownExecutorCount: 1,
  });
  witness('beforeAll', {
    db: process.env.DB_DATABASE,
    api: API,
    installId: INSTALL_ID,
    executorId,
    execId,
    execHash,
    configHistoryBaseline,
    status: {
      systemEnabled: s.systemEnabled,
      count: s.count,
      coverage: s.coverage,
      knownExecutorCount: s.knownExecutorCount,
    },
    login: { status: login.status, tokenIssued: true, refreshTokenIssued: true },
  });
});

test.afterAll(async () => {
  try {
    if (!pg) return;
    await setGate('false');
    await waitGate(false);
    await cleanRows();
    const h = await pg.query(
      `DELETE FROM config_history
        WHERE "configKey" = $1 AND id > $2`,
      [GATE_KEY, configHistoryBaseline],
    );
    const s = await backendStatus();
    const f = await funnelRows();
    const o = await pg.query(
      `SELECT count(*)::int AS n FROM telemetry_optin WHERE install_id = $1`,
      [INSTALL_ID],
    );
    const e = await pg.query(
      `SELECT count(*)::int AS n FROM executors WHERE "deviceFingerprint" = $1`,
      [TEST_FP],
    );
    const te = await pg.query(
      `SELECT count(*)::int AS n FROM task_executions WHERE "taskName" LIKE $1`,
      [`${PREFIX}%`],
    );
    const t = await pg.query(
      `SELECT count(*)::int AS n FROM tasks WHERE name LIKE $1`,
      [`${PREFIX}%`],
    );
    const g = await pg.query(
      `SELECT value FROM system_configs WHERE key = $1`,
      [GATE_KEY],
    );
    witness('cleanup', {
      configHistoryDeleted: h.rowCount,
      funnel: f.length,
      optin: o.rows?.[0]?.n,
      executors: e.rows?.[0]?.n,
      taskExecutions: te.rows?.[0]?.n,
      tasks: t.rows?.[0]?.n,
      gate: g.rows?.[0]?.value,
      statusCoverage: s.coverage,
    });
    expect(f.length).toBe(0);
    expect(o.rows?.[0]?.n).toBe(0);
    expect(e.rows?.[0]?.n).toBe(0);
    expect(te.rows?.[0]?.n).toBe(0);
    expect(t.rows?.[0]?.n).toBe(0);
    expect(g.rows?.[0]?.value).toBe('false');
    expect(s.coverage, 'final status coverage after gate reset').toBe('gate_off');
  } finally {
    if (pg) await pg.end();
  }
});

test('场景1 完整启用路径：no_executors 告警 → UI 撤销 → 新执行器 → Switch+Popconfirm 授权 → coverage full', async ({
  page,
}) => {
  const { pageErrors, consoleErrors } = injectSession(page);

  // fixture：总闸开 + 无执行器 ⇒ 后端 coverage=no_executors（UI 告警应可见）
  await pg.query(`DELETE FROM executors WHERE "deviceFingerprint" = $1`, [TEST_FP]);
  await setGate('true');
  await waitGate(true);
  await openTelemetryTab(page);
  await expect(page.getByTestId('telemetry-coverage-alert')).toBeVisible();
  await expect(page.getByTestId('telemetry-coverage-value')).toHaveText('0 / 0');
  await expect(page.getByRole('switch', { name: /Join the TTFV/ })).toBeChecked();
  await page.getByRole('tabpanel').screenshot({
    path: '/tmp/r437-01-no-executors.png',
  });
  witness('s1-no-executors', {
    coverage: await page.getByTestId('telemetry-coverage-value').textContent(),
    alertVisible: await page.getByTestId('telemetry-coverage-alert').isVisible(),
    backendCoverage: (await backendStatus()).coverage,
  });

  // 真 UI 撤销（Switch + Popconfirm OK）→ 总闸 off，回到「未授权」初始态
  await clickSwitchConsent(page, false);
  await expect(page.getByTestId('telemetry-coverage-value')).toHaveText('0 / 0');
  await expect(page.getByTestId('telemetry-coverage-alert')).toHaveCount(0);
  expect((await backendStatus()).systemEnabled).toBe(false);

  // fixture：重新注册 1 个合法指纹执行器；UI 点 Refresh 拉回真 status
  await insertExecutor();
  await page
    .getByRole('tabpanel')
    .getByRole('button', { name: 'Refresh' })
    .click();
  await expect(page.getByTestId('telemetry-coverage-value')).toHaveText('0 / 1');

  // 关键路径：真浏览器点 Switch → Popconfirm OK → 真 consent 201 → full
  await clickSwitchConsent(page, true);
  await expect(page.getByTestId('telemetry-coverage-value')).toHaveText('1 / 1');
  await expect(page.getByTestId('telemetry-coverage-alert')).toHaveCount(0);
  await expect(page.getByRole('switch', { name: /Join the TTFV/ })).toBeChecked();
  const s = await backendStatus();
  expect(s).toMatchObject({
    systemEnabled: true,
    count: 1,
    coverage: 'full',
    knownExecutorCount: 1,
  });
  expect(s.installs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        installId: INSTALL_ID,
        optIn: true,
        source: 'admin-ui',
      }),
    ]),
  );
  await page.getByRole('tabpanel').screenshot({
    path: '/tmp/r437-02-full-enabled.png',
  });
  witness('s1-full', {
    coverageText: await page.getByTestId('telemetry-coverage-value').textContent(),
    alertCount: await page.getByTestId('telemetry-coverage-alert').count(),
    backend: {
      systemEnabled: s.systemEnabled,
      count: s.count,
      coverage: s.coverage,
      known: s.knownExecutorCount,
      installs: s.installs,
    },
    pageErrors,
    consoleErrors,
  });
  expect(pageErrors, `pageerror: ${pageErrors.join(' | ')}`).toEqual([]);
  expect(consoleErrors, `console.error: ${consoleErrors.join(' | ')}`).toEqual([]);
});

test('场景2 重授权入口：revoke 掉唯一 install → partial 告警+按钮 → 真点按钮回 full', async ({
  page,
}) => {
  const { pageErrors, consoleErrors } = injectSession(page);

  // fixture：只撤授权行、不动总闸 ⇒ coverage=partial（保留「重授权」入口）
  await pg.query(
    `UPDATE telemetry_optin SET opt_in = false, opted_at = NOW(), source = 'revoke'
      WHERE install_id = $1`,
    [INSTALL_ID],
  );
  const before = await backendStatus();
  expect(before).toMatchObject({
    systemEnabled: true,
    count: 0,
    coverage: 'partial',
    knownExecutorCount: 1,
  });

  await openTelemetryTab(page);
  await expect(page.getByTestId('telemetry-coverage-value')).toHaveText('0 / 1');
  await expect(page.getByTestId('telemetry-coverage-alert')).toBeVisible();
  await expect(page.getByTestId('telemetry-reauthorize-btn')).toBeVisible();
  await page.getByRole('tabpanel').screenshot({
    path: '/tmp/r437-03-partial-alert.png',
  });
  witness('s2-partial', {
    coverageText: await page.getByTestId('telemetry-coverage-value').textContent(),
    alertText: await page.getByTestId('telemetry-coverage-alert').innerText(),
    reauthorizeVisible: await page
      .getByTestId('telemetry-reauthorize-btn')
      .isVisible(),
    backendCoverage: before.coverage,
  });

  await clickReauthorize(page);
  await expect(page.getByTestId('telemetry-coverage-value')).toHaveText('1 / 1');
  await expect(page.getByTestId('telemetry-coverage-alert')).toHaveCount(0);
  const after = await backendStatus();
  expect(after).toMatchObject({
    systemEnabled: true,
    count: 1,
    coverage: 'full',
    knownExecutorCount: 1,
  });
  expect(after.installs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ installId: INSTALL_ID, optIn: true }),
    ]),
  );
  await page.getByRole('tabpanel').screenshot({
    path: '/tmp/r437-04-reauthorized.png',
  });
  witness('s2-restored', {
    coverageText: await page.getByTestId('telemetry-coverage-value').textContent(),
    alertCount: await page.getByTestId('telemetry-coverage-alert').count(),
    backend: {
      count: after.count,
      coverage: after.coverage,
      known: after.knownExecutorCount,
    },
    pageErrors,
    consoleErrors,
  });
  expect(pageErrors, `pageerror: ${pageErrors.join(' | ')}`).toEqual([]);
  expect(consoleErrors, `console.error: ${consoleErrors.join(' | ')}`).toEqual([]);
});

test('场景3 隐私解耦真栈反证：opt-out confirm 仍 200 且不落漏斗；opt-in confirm 真落库', async ({
  page,
}) => {
  const { pageErrors, consoleErrors } = injectSession(page);
  await openTelemetryTab(page);
  await expect(page.getByTestId('telemetry-coverage-value')).toHaveText('1 / 1');

  // opt-out 也走真 UI（Switch + Popconfirm OK），后端关总闸并撤销全部 install
  await clickSwitchConsent(page, false);
  const sOff = await backendStatus();
  expect(sOff).toMatchObject({ systemEnabled: false, count: 0 });
  expect(await funnelRows()).toHaveLength(0);

  // 真 POST confirm：业务可用性不受遥测影响（200/201 + ok:true）
  const confirmOff = await api(`/agent/executions/${execId}/confirm`, {
    method: 'POST',
    token,
    body: {},
  });
  expect([200, 201]).toContain(confirmOff.status);
  expect(unwrap(confirmOff.body)?.ok).toBe(true);
  // 漏斗是 async listener：固定等 2s 让事件窗口走完，再断言「确实没有行」
  await page.waitForTimeout(2000);
  const rowsOff = await funnelRows();
  expect(rowsOff).toHaveLength(0);
  expect(
    rowsOff.filter((r) => r.dedupe_key === `confirmed:${execHash}`),
  ).toHaveLength(0);
  witness('s3-optout-confirm', {
    confirmStatus: confirmOff.status,
    ok: unwrap(confirmOff.body)?.ok,
    waitedMs: 2000,
    funnelRows: rowsOff.length,
    execHash,
  });

  // opt-in 仍走真 UI；coverage 回 full，再确认同一 execution ⇒ 真落库
  await clickSwitchConsent(page, true);
  await expect(page.getByTestId('telemetry-coverage-value')).toHaveText('1 / 1');
  const sOn = await backendStatus();
  expect(sOn).toMatchObject({
    systemEnabled: true,
    count: 1,
    coverage: 'full',
  });

  const confirmOn = await api(`/agent/executions/${execId}/confirm`, {
    method: 'POST',
    token,
    body: {},
  });
  expect([200, 201]).toContain(confirmOn.status);
  expect(unwrap(confirmOn.body)?.ok).toBe(true);
  await expect
    .poll(
      async () =>
        (await funnelRows()).filter(
          (r) => r.dedupe_key === `confirmed:${execHash}`,
        ).length,
      { timeout: 10_000 },
    )
    .toBe(1);
  const rowsOn = await funnelRows();
  expect(rowsOn).toHaveLength(1);
  expect(rowsOn[0]).toMatchObject({
    event_name: 'business_confirmed',
    install_id: INSTALL_ID,
    execution_id_hash: execHash,
    dedupe_key: `confirmed:${execHash}`,
  });
  await page.getByRole('tabpanel').screenshot({
    path: '/tmp/r437-05-privacy-restored.png',
  });
  witness('s3-optin-confirm', {
    confirmStatus: confirmOn.status,
    ok: unwrap(confirmOn.body)?.ok,
    funnelRows: rowsOn,
    coverageText: await page.getByTestId('telemetry-coverage-value').textContent(),
    pageErrors,
    consoleErrors,
  });
  expect(pageErrors, `pageerror: ${pageErrors.join(' | ')}`).toEqual([]);
  expect(consoleErrors, `console.error: ${consoleErrors.join(' | ')}`).toEqual([]);
});
