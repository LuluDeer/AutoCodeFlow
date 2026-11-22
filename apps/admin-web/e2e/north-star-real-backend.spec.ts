import { test, expect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * R436 — 北极星看板「真后端 + 真浏览器」端到端验收。
 *
 * 覆盖 R328/R329/R435 遗留的最后一层缺口：此前所有「浏览器级」都是真 build
 * + 系统 Chrome + mock API；本 spec 用真 PostgreSQL 造数、真 Nest 后端  驱动
 * confirm 事件、真 listener 落 funnel_events、真浏览器读真 API。
 *
 * 写域：仅本文件（新文件）+ playwright.northstar.config.ts（新文件）。
 * 数据按 PREFIX 前缀造、按前缀清；口令只从 process.env 读，不进文件/日志/截图。
 */
const requireFromApi = createRequire(
  fileURLToPath(new URL('../../admin-api/package.json', import.meta.url)),
);
const { Client } = requireFromApi('pg') as {
  Client: new (cfg: Record<string, unknown>) => {
    connect(): Promise<void>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- e2e fixture: PG 返回行形状随查询而异，动态类型是有意的
    query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
    end(): Promise<void>;
  };
};

const API = 'http://127.0.0.1:3105/api';
const PREFIX = 'r436-realbe-';

// 合法 64-hex 测试指纹（executor-fingerprint.util.ts FINGERPRINT_RE: /^[0-9a-f]{64}$/）
const TEST_FP = createHash('sha256').update('r436-realbe-fixture').digest('hex');

// 授权走 deviceFingerprint 参数：由后端用自身 SEC_SECRETS_KEY 派生匿名 installId，
// listener 回查 executor 指纹时派生口径必然一致（不依赖 spec/后端两侧 key 相同）。
// spec 从 consent 响应读回真实 installId 用于断言与清理。
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- e2e fixture: API 响应信封在 data/裸体间动态，测试按形状读
const unwrap = (body: any): any => body?.data ?? body;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- e2e fixture: body 为 JSON 解析结果，形状随端点而异
type ApiResult = { status: number; body: any };
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- e2e fixture: 先放原始 text，再按 JSON 解析，动态类型是有意的
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep raw text */
  }
  return { status: res.status, body };
}

const witness = (label: string, payload: object) =>
  console.log(`[R436-WITNESS] ${label} ${JSON.stringify(payload)}`);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- e2e fixture: PG Client 实例按 requireFromApi 动态构造
let pg: any;
let token = '';
let refreshToken = '';
let user: unknown = null;
let executorId = '';
let taskId = '';
let execId = '';
let installId = '';
let dedupeKey = '';

/** 只删本 spec 前缀造的行 + consent 回读的真实 install；不 DROP 表/库。 */
async function cleanRows(): Promise<void> {
  if (installId) {
    await pg.query(`DELETE FROM funnel_events WHERE install_id = $1`, [installId]);
    await pg.query(`DELETE FROM telemetry_optin WHERE install_id = $1`, [installId]);
  }
  await pg.query(`DELETE FROM task_executions WHERE "taskName" LIKE $1`, [
    `${PREFIX}%`,
  ]);
  await pg.query(`DELETE FROM tasks WHERE name LIKE $1`, [`${PREFIX}%`]);
  await pg.query(
    `DELETE FROM executors WHERE "deviceFingerprint" = $1`,
    [TEST_FP],
  );
}

/** funnel_events 是 async listener 落库，poll 等真实副作用（100ms/5s）。 */
async function funnelCount(): Promise<number> {
  const r = await pg.query(
    `SELECT count(*)::int AS n FROM funnel_events
      WHERE install_id = $1 AND event_name = 'business_confirmed'`,
    [installId],
  );
  return Number(r.rows?.[0]?.n ?? 0);
}

test.beforeAll(async () => {
  expect(
    /(^|_)(test|e2e)(_|$)/i.test(process.env.DB_DATABASE || ''),
    'R436 must run against an explicit test/e2e database',
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
  witness('stack', { db: process.env.DB_DATABASE, api: API });

  // 真登录（口令只从 env 读；响应体不打印凭据）
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
  expect(token, 'login accessToken').toBeTruthy();
  expect(refreshToken, 'login refreshToken (PrivateRoute session key)').toBeTruthy();
  witness('login', {
    status: login.status,
    tokenIssued: true,
    refreshTokenIssued: true,
  });

  // 真 consent：用 deviceFingerprint 让后端自行派生 installId（与 listener 同口径），
  // 再从响应回读真实 installId 作为本轮断言/清理的唯一依据。
  const consentBody = { optIn: true, deviceFingerprint: TEST_FP, source: 'api' };
  const consent = await api('/agent/telemetry/consent', {
    method: 'POST',
    token,
    body: consentBody,
  });
  expect([200, 201]).toContain(consent.status);
  expect(unwrap(consent.body)).toMatchObject({
    systemEnabled: true,
    optedIn: true,
  });
  installId = unwrap(consent.body)?.installIds?.[0];
  expect(installId, 'consent derived installId').toMatch(/^[0-9a-f]{32}$/);

  // 拿到真实 installId 后先清干净历史残留（含刚写入的 optin 行），再重新授权。
  await cleanRows();
  const consent2 = await api('/agent/telemetry/consent', {
    method: 'POST',
    token,
    body: consentBody,
  });
  expect([200, 201]).toContain(consent2.status);
  expect(unwrap(consent2.body).installIds).toContain(installId);
  witness('consent', unwrap(consent2.body));

  // 真 PG 造数：executor（带 64hex 指纹）→ task → execution（含产物，proxy=1）
  executorId = randomUUID();
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
  taskId = randomUUID();
  const taskName = `${PREFIX}task-${randomUUID()}`;
  await pg.query(
    `INSERT INTO tasks (id, name, "triggerType") VALUES ($1, $2, 'manual')`,
    [taskId, taskName],
  );
  execId = randomUUID();
  await pg.query(
    `INSERT INTO task_executions
       (id, "taskId", "taskName", "executorId", synthetic, status, artifacts, "endTime")
     VALUES ($1, $2, $3, $4, false, 'success', $5, $6)`,
    [
      execId,
      taskId,
      taskName,
      executorId,
      JSON.stringify([{ name: 'r436-e2e-artifact' }]),
      new Date().toISOString(),
    ],
  );
  witness('rows-inserted', { executorId, taskId, execId, installId });

  // 真 confirm 端点 → 真领域事件 → 真 listener → funnel_events 落库
  const confirm = await api(`/agent/executions/${execId}/confirm`, {
    method: 'POST',
    token,
    body: {},
  });
  expect([200, 201]).toContain(confirm.status);
  expect(unwrap(confirm.body)?.ok).toBe(true);
  await expect.poll(funnelCount, { timeout: 10_000 }).toBe(1);
  const row = (
    await pg.query(
      `SELECT event_name, install_id, dedupe_key, execution_id_hash, task_id_hash, ts
         FROM funnel_events WHERE install_id = $1 AND event_name = 'business_confirmed'`,
      [installId],
    )
  ).rows[0];
  expect(row).toMatchObject({
    event_name: 'business_confirmed',
    install_id: installId,
  });
  expect(row.dedupe_key).toMatch(/^confirmed:[0-9a-f]{32}$/);
  dedupeKey = row.dedupe_key;
  witness('funnel-row', row);
});

test.afterAll(async () => {
  try {
    // 复位系统级副作用（关总闸 + 撤销 install），再清行
    if (token) {
      await api('/agent/telemetry/consent', {
        method: 'POST',
        token,
        body: { optIn: false, installId, source: 'api' },
      }).catch(() => undefined);
    }
    if (pg) await cleanRows();
  } finally {
    if (pg) await pg.end();
  }
});

test('真浏览器渲染真后端数据：严格值 1 / 近似值 / 警告 / 全局口径 / 无报错，且反证有效', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  // 注入真 API 登录态（token/refreshToken/user 来自 beforeAll 的真 POST /auth/login）
  // PrivateRoute 靠 refreshToken 判定会话（不是 accessToken），必须一并注入。
  await page.addInitScript(
    ({ accessToken, refresh, authUser }) => {
      localStorage.setItem(
        'autoflow-auth',
        JSON.stringify({
          state: { token: accessToken, refreshToken: refresh, user: authUser },
          version: 0,
        }),
      );
    },
    { accessToken: token, refresh: refreshToken, authUser: user },
  );

  // 后端真值先行见证（浏览器断言要与之逐字对齐）
  const ns = unwrap(
    (await api('/agent/north-star/metrics', { token })).body,
  );
  expect(ns?.business_confirmed?.totals?.confirmed_events).toBe(1);
  expect(ns?.business_results_proxy?.totals?.executions).toBe(1);
  // R449 升主判据（真 API 见证）：本场景仅 1 周 1 install ⇒ 数值阈值不满足。
  const pe = ns?.promotionEligibility;
  expect(pe, 'API 必须输出 promotionEligibility').toBeTruthy();
  expect(pe.eligible).toBe(false);
  expect(pe.thresholds).toMatchObject({ minWeeks: 4, minActiveInstallWeeks: 20 });
  expect(pe.reasons.some((r: string) => r.includes('coverage'))).toBe(true);
  witness('api-north-star', {
    confirmed: ns.business_confirmed.totals,
    proxy: ns.business_results_proxy.totals,
    promotion: pe,
    warnings: ns.warnings,
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('north-star-card')).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId('north-star-loading')).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(page.getByTestId('north-star-read-failed')).toHaveCount(0);

  // 任务书点名的四个 testid + 数值 + 近似值区 + 全局口径
  await expect(page.getByTestId('north-star-strict')).toBeVisible();
  await expect(page.getByTestId('north-star-proxy')).toBeVisible();
  await expect(page.getByTestId('north-star-confirmed')).toHaveText('1');
  await expect(page.getByTestId('north-star-proxy-executions')).toHaveText('1');
  await expect(page.getByTestId('north-star-global-tag')).toBeVisible();
  await expect(page.getByTestId('north-star-warnings')).toBeVisible();
  await expect(
    page
      .getByTestId('north-star-warning')
      .filter({ hasText: '有产物/有证据 ≠ 被业务确认' }),
  ).toBeVisible();

  // R449 升主判据展示（真浏览器）：与后端真值 pe.eligible=false 对齐。
  await expect(page.getByTestId('north-star-promotion')).toBeVisible();
  // 该 e2e 注入英文 locale（autoflow-lang=en），Tag 渲染为英文。
  await expect(page.getByTestId('north-star-promotion-tag')).toContainText('Promotion criteria not met');
  // detail 显示实得（本场景 1 周 / 1 install），与 API witness 的 promotion.weeks/activeInstallWeeks 对齐
  await expect(page.getByTestId('north-star-promotion-detail')).toContainText('1 weeks / 1 active installs');
  await expect(page.getByTestId('north-star-promotion-reasons')).toContainText('coverage');

  // 截图只截 Dashboard 卡片区（不含凭据区），存 /tmp 不进仓库
  await page.getByTestId('north-star-card').scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/r436-north-star-dashboard.png' });
  await page
    .getByTestId('north-star-card')
    .screenshot({ path: '/tmp/r436-north-star-card.png' });
  witness('browser-assert', {
    confirmed: await page.getByTestId('north-star-confirmed').textContent(),
    proxy: await page.getByTestId('north-star-proxy-executions').textContent(),
    warningVisible: await page
      .getByTestId('north-star-warning')
      .filter({ hasText: '有产物/有证据 ≠ 被业务确认' })
      .isVisible(),
    globalTagVisible: await page.getByTestId('north-star-global-tag').isVisible(),
    pageErrors,
    consoleErrors,
  });

  expect(pageErrors, `pageerror: ${pageErrors.join(' | ')}`).toEqual([]);
  expect(consoleErrors, `console.error: ${consoleErrors.join(' | ')}`).toEqual([]);

  // 反证：删掉真 backend 的 business_confirmed 行 → 刷新 → 严格值必须变 0
  await pg.query(`DELETE FROM funnel_events WHERE dedupe_key = $1`, [dedupeKey]);
  await expect.poll(funnelCount, { timeout: 10_000 }).toBe(0);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('north-star-confirmed')).toHaveText('0', {
    timeout: 30_000,
  });
  await page.screenshot({ path: '/tmp/r436-north-star-counterproof.png' });
  witness('counterproof', {
    funnelRows: 0,
    confirmedText: await page.getByTestId('north-star-confirmed').textContent(),
  });

  // 恢复：重打幂等 confirm，真 listener 再写一行，刷新后严格值回到 1
  const reconfirm = await api(`/agent/executions/${execId}/confirm`, {
    method: 'POST',
    token,
    body: {},
  });
  expect([200, 201]).toContain(reconfirm.status);
  await expect.poll(funnelCount, { timeout: 10_000 }).toBe(1);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('north-star-confirmed')).toHaveText('1', {
    timeout: 30_000,
  });
  witness('restored', {
    funnelRows: 1,
    confirmedText: await page.getByTestId('north-star-confirmed').textContent(),
  });
});
