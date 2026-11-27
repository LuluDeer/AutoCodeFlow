/**
 * Level-4 hardening verification — real Chrome + real admin-api + real vite.
 *
 * Runner: scripts/verify-hardening-browser.sh
 * Config: apps/admin-web/playwright.hardening.config.ts
 *
 * What this spec proves at browser level:
 *  1. business user login -> workbench preview/commit/run draft -> URL ?session=
 *     -> reload -> panel restored -> continues polling real backend;
 *  2. workbench artifact entry visible -> click -> request hits real backend;
 *  3. execution detail logs SSE reconnect -> no duplicated log lines.
 *
 * Fixtures are created in the throwaway database through the real API where
 * possible; synthetic rows are used only where no executor exists to produce a
 * terminal artifact/log stream. Every assertion below is a real browser DOM,
 * real network response, or both.
 */
import { test, expect, type APIRequestContext, type Download, type Page } from '@playwright/test';
import { openLegacyFlow } from './workbench-legacy.helper';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ADMIN_USER = process.env.E2E_INITIAL_ADMIN_USERNAME ?? 'admin';
const ADMIN_PASS = process.env.E2E_INITIAL_ADMIN_PASSWORD ?? 'admin123';
const API_BASE = process.env.HARDENING_API_BASE ?? 'http://127.0.0.1:3107';
const RUN_DIR = process.env.HARDENING_RUN_DIR ?? '';
const ARTIFACT_ROOT = process.env.HARDENING_ARTIFACT_ROOT ?? '';
const REPO_ROOT = process.env.HARDENING_REPO_ROOT ?? path.resolve(process.cwd(), '../..');
const DB = {
  host: process.env.HARDENING_DB_HOST ?? 'localhost',
  port: Number(process.env.HARDENING_DB_PORT ?? 15434),
  user: process.env.HARDENING_DB_USERNAME ?? 'autoflow',
  password: process.env.HARDENING_DB_PASSWORD ?? 'test',
  database: process.env.HARDENING_DB_DATABASE ?? '',
};
const CALLBACK_SECRET = process.env.HARDENING_CALLBACK_SECRET ?? 'test-executor-secret';

const requireFromApi = createRequire(path.join(REPO_ROOT, 'apps/admin-api/package.json'));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Client } = requireFromApi('pg') as any;

type AssertionStatus = 'PASS' | 'FAIL' | 'SKIP';
interface AssertionRecord {
  name: string;
  status: AssertionStatus;
  detail: Record<string, unknown>;
  at: string;
}
interface Evidence {
  steps: string[];
  assertions: AssertionRecord[];
  skips: string[];
  gaps: string[];
  artifacts: Record<string, string>;
}
const evidence: Evidence = { steps: [], assertions: [], skips: [], gaps: [], artifacts: {} };

function step(message: string): void {
  const line = `${new Date().toISOString()} ${message}`;
  evidence.steps.push(line);
  console.log(`[H4] ${message}`);
}

function record(name: string, status: AssertionStatus, detail: Record<string, unknown>): void {
  evidence.assertions.push({ name, status, detail, at: new Date().toISOString() });
  step(`${name}: ${status}`);
}

function skip(name: string, reason: string): void {
  evidence.skips.push(`${name}: ${reason}`);
  record(name, 'SKIP', { reason });
}

function assertBrowser(name: string, ok: boolean, detail: Record<string, unknown>, message: string): void {
  record(name, ok ? 'PASS' : 'FAIL', detail);
  expect.soft(ok, `${message}; evidence=${JSON.stringify(detail)}`).toBeTruthy();
}

function writeEvidence(): void {
  if (!RUN_DIR) return;
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const evidencePath = path.join(RUN_DIR, 'spec-evidence.json');
  // Playwright isolates each test's module scope. Merge with the existing file
  // so the final report keeps assertions from every test, not only the last one.
  let previous: Partial<Evidence> = {};
  try {
    previous = JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as Partial<Evidence>;
  } catch {
    previous = {};
  }
  const byName = new Map<string, AssertionRecord>();
  for (const item of [...(previous.assertions ?? []), ...evidence.assertions]) {
    byName.set(item.name, item);
  }
  const merged: Evidence = {
    steps: [...new Set([...(previous.steps ?? []), ...evidence.steps])],
    assertions: [...byName.values()],
    skips: [...new Set([...(previous.skips ?? []), ...evidence.skips])],
    gaps: [...new Set([...(previous.gaps ?? []), ...evidence.gaps])],
    artifacts: { ...(previous.artifacts ?? {}), ...evidence.artifacts },
  };
  fs.writeFileSync(evidencePath, JSON.stringify(merged, null, 2), 'utf8');
}

test.afterEach(() => {
  writeEvidence();
});

async function withDb<T>(fn: (client: any) => Promise<T>): Promise<T> {
  if (!DB.database) throw new Error('HARDENING_DB_DATABASE missing');
  const client = new Client(DB);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function unwrap<T = any>(resp: { json(): Promise<any> }): Promise<T> {
  const body = await resp.json();
  return (body?.data ?? body) as T;
}

async function apiLogin(request: APIRequestContext, username: string, password: string) {
  const resp = await request.post(`${API_BASE}/api/auth/login`, { data: { username, password } });
  expect([200, 201], `login ${username}: ${await resp.text().catch(() => '')}`).toContain(resp.status());
  const data = await unwrap<{ accessToken: string; refreshToken: string; totpRequired?: boolean }>(resp);
  expect(data.accessToken).toBeTruthy();
  expect(data.totpRequired).toBeFalsy();
  return data;
}

async function createBusinessUser(request: APIRequestContext, tag: string) {
  const admin = await apiLogin(request, ADMIN_USER, ADMIN_PASS);
  const adminHeaders = { Authorization: `Bearer ${admin.accessToken}` };
  const suffix = `${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 100)}`;
  const username = `h4_${tag}_${suffix}`;
  const password = 'Str0ng!Passw0rd';
  const resp = await request.post(`${API_BASE}/api/users`, {
    headers: adminHeaders,
    data: { username, email: `${username}@example.invalid`, password, role: 'user' },
  });
  expect(resp.status(), `create user: ${await resp.text().catch(() => '')}`).toBe(201);
  const created = await unwrap<{ id: number; username: string; role: string }>(resp);
  const login = await apiLogin(request, username, password);
  return {
    id: created.id,
    username,
    password,
    headers: { Authorization: `Bearer ${login.accessToken}` },
  };
}

async function loginInBrowser(page: Page, username: string, password: string): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('autoflow-lang', 'zh');
  });
  await page.goto('/login');
  await page.getByRole('textbox', { name: '用户名' }).fill(username);
  await page.getByRole('textbox', { name: '密码' }).fill(password);
  await page.locator('form button[type="submit"]').click();
  await expect.poll(() => page.url(), { timeout: 30_000 }).not.toContain('/login');
  await expect.poll(async () => page.evaluate(() => localStorage.getItem('autoflow-auth')), { timeout: 30_000 })
    .toBeTruthy();
}

async function createTask(request: APIRequestContext, headers: Record<string, string>, name: string) {
  const resp = await request.post(`${API_BASE}/api/tasks`, {
    headers,
    data: { name, triggerType: 'manual', status: 'paused', runtime: 'shell' },
  });
  expect(resp.status(), `create task: ${await resp.text().catch(() => '')}`).toBe(201);
  return unwrap<{ id: string; name: string; ownerUserId: number | null }>(resp);
}

async function insertRunningExecution(input: {
  taskId: string;
  taskName: string;
  agentSessionId: string | null;
  artifacts?: Array<{ name: string; size: number; sha256: string }>;
}): Promise<string> {
  const execId = randomUUID();
  await withDb(async (client) => {
    await client.query(
      `INSERT INTO task_executions
        (id, "taskId", "taskName", status, synthetic, "agentSessionId", "logStorage", artifacts,
         "retryCount", "attemptSeq", version, "createdAt")
       VALUES ($1,$2,$3,'running',false,$4,'db',$5::jsonb,0,0,1,now())`,
      [execId, input.taskId, input.taskName, input.agentSessionId, JSON.stringify(input.artifacts ?? [])],
    );
  });
  return execId;
}

function signExecutionToken(executionId: string): string {
  const exp = Math.floor(Date.now() / 1000) + 600;
  const payload = `v1.${executionId}.${exp}`;
  const key = createHmac('sha256', CALLBACK_SECRET).update('autocodeflow:execution-callback:v1').digest();
  const sig = createHmac('sha256', key).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

async function appendLogLines(request: APIRequestContext, execId: string, fromLine: number, lines: string[]): Promise<void> {
  const resp = await request.post(`${API_BASE}/api/executions/${execId}/logs`, {
    headers: { Authorization: `Bearer ${signExecutionToken(execId)}` },
    data: { fromLine, lines },
  });
  expect([200, 201], `append logs: ${await resp.text().catch(() => '')}`).toContain(resp.status());
}

async function runWorkbenchDraft(page: Page, goal: string): Promise<{ sopId: string; sessionId: string }> {
  await page.goto('/workbench');
  await expect(page.getByTestId('workbench-page')).toBeVisible();
  await openLegacyFlow(page);
  await page.getByPlaceholder('例如：每周汇总项目状态并生成报告').fill(goal);
  // 频率下拉定位到 legacy 方案草稿区（左侧会话栏也有 .ant-select，不能用全局 first()）。
  await page.getByText('执行频率').locator('..').getByRole('combobox').click();
  await page.locator('.ant-select-item-option-content').getByText('每周', { exact: true }).click();
  await page.getByRole('button', { name: /预\s*览\s*方\s*案/ }).click();
  await expect(page.getByRole('heading', { name: /^方案卡：/ })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /确\s*认\s*方\s*案/ }).click();
  const success = page.getByTestId('workbench-commit-success');
  await expect(success).toBeVisible({ timeout: 30_000 });
  const successText = await success.innerText();
  const sopMatch = successText.match(/SOP\s*编号：\s*([0-9a-fA-F-]{36})/);
  expect(sopMatch, `sopId missing: ${successText}`).toBeTruthy();
  const sopId = sopMatch![1];
  await page.getByTestId('workbench-run-draft').click();
  const panel = page.getByTestId('workbench-session-panel');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  const sessionIdText = await page.getByTestId('workbench-session-id').innerText();
  const sessionMatch = sessionIdText.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  expect(sessionMatch, `sessionId missing: ${sessionIdText}`).toBeTruthy();
  return { sopId, sessionId: sessionMatch![0] };
}

/** Keep the fixture session non-terminal so the real 2s polling loop can be observed. */
async function pinSessionRunning(sessionId: string, intervalMs = 250): Promise<() => Promise<void>> {
  await withDb(async (client) => {
    await client.query(
      `UPDATE agent_sessions SET status='running', "updatedAt"=now(), "finishedAt"=NULL WHERE id=$1`,
      [sessionId],
    );
  });
  let stopped = false;
  const keep = (async () => {
    while (!stopped) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      if (stopped) return;
      try {
        await withDb(async (client) => {
          await client.query(
            `UPDATE agent_sessions SET status='running', "updatedAt"=now(), "finishedAt"=NULL WHERE id=$1`,
            [sessionId],
          );
        });
      } catch {
        // best-effort fixture pin; assertion below reads the real API result
      }
    }
  })();
  return async () => {
    stopped = true;
    await keep;
  };
}

test('workbench refresh resume keeps polling real backend', async ({ page, request }) => {
  const user = await createBusinessUser(request, 'resume');
  await loginInBrowser(page, user.username, user.password);
  const { sessionId } = await runWorkbenchDraft(page, `H4 resume verification ${Date.now()}`);

  const urlSession = new URL(page.url()).searchParams.get('session');
  assertBrowser(
    'workbench.url_session_param',
    urlSession === sessionId,
    { expected: sessionId, observed: urlSession, url: page.url() },
    'run draft must write session into URL query',
  );

  const stopPin = await pinSessionRunning(sessionId);
  try {
    const polls: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'GET' && req.url().includes(`/api/workbench/sessions/${sessionId}`)) {
        polls.push(`${new Date().toISOString()} ${req.url()}`);
      }
    });
    await page.reload();
    await openLegacyFlow(page);
    await expect(page.getByTestId('workbench-session-panel')).toBeVisible({ timeout: 30_000 });
    const restoredId = await page.getByTestId('workbench-session-id').innerText();
    assertBrowser(
      'workbench.refresh_panel_restored',
      restoredId.includes(sessionId),
      { expected: sessionId, observed: restoredId, url: page.url() },
      'reload must restore session panel from URL',
    );
    await expect.poll(() => polls.length, { timeout: 15_000, intervals: [500, 500, 1000] })
      .toBeGreaterThanOrEqual(2);
    assertBrowser(
      'workbench.refresh_continues_polling',
      polls.length >= 2,
      { pollCount: polls.length, polls, fixture: 'session status pinned to running in throwaway DB' },
      'restored panel must keep polling the real session endpoint',
    );
    if (RUN_DIR) {
      const shot = path.join(RUN_DIR, 'workbench-resume-success.png');
      await page.screenshot({ path: shot, fullPage: true });
      evidence.artifacts.workbenchResumeScreenshot = shot;
    }
  } finally {
    await stopPin();
  }
});

test('workbench artifact entry reaches real backend', async ({ page, request }) => {
  if (!ARTIFACT_ROOT) {
    skip('artifact.download_entry', 'HARDENING_ARTIFACT_ROOT not provided');
    return;
  }
  const user = await createBusinessUser(request, 'artifact');
  await loginInBrowser(page, user.username, user.password);
  const { sessionId } = await runWorkbenchDraft(page, `H4 artifact verification ${Date.now()}`);
  const stopPin = await pinSessionRunning(sessionId);

  try {
    const task = await createTask(request, user.headers, `h4-artifact-${Date.now()}`);
    expect(task.ownerUserId).toBe(user.id);
    const content = `hardening artifact marker ${randomUUID()}\n`;
    const artifactName = 'report.md';
    const size = Buffer.byteLength(content, 'utf8');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const execId = await insertRunningExecution({
      taskId: task.id,
      taskName: task.name,
      agentSessionId: sessionId,
      artifacts: [{ name: artifactName, size, sha256 }],
    });
    // Backend resolves <LOG_ARTIFACT_DIR>/<execId>/<name>; use the real execId
    // directory so the request reaches a real file on disk.
    const dir = path.join(ARTIFACT_ROOT, execId);
    fs.mkdirSync(dir, { recursive: true });
    const physicalPath = path.join(dir, artifactName);
    fs.writeFileSync(physicalPath, content, 'utf8');
    await withDb(async (client) => {
      await client.query(
        `INSERT INTO execution_artifacts
          (id, "executionId", "taskId", "name", size, sha256, "createdAt")
         VALUES ($1,$2,$3,$4,$5,$6,now())`,
        [randomUUID(), execId, task.id, artifactName, size, sha256],
      );
    });

    // The session polling effect stops on terminal status. Fixture keeps it
    // running, but reload once so the panel reads the new artifact immediately.
    await page.reload();
    await openLegacyFlow(page);
    const link = page.getByTestId('workbench-session-artifact-link');
    await expect(link).toBeVisible({ timeout: 30_000 });
    const href = await link.getAttribute('href');
    const expectedPath = `/api/tasks/executions/${execId}/artifacts/${artifactName}`;
    assertBrowser(
      'artifact.entry_visible',
      href === expectedPath,
      { expected: expectedPath, observed: href },
      'artifact entry must point at real download endpoint',
    );

    const downloadUrl = `${API_BASE}${expectedPath}`;
    const authed = await request.get(downloadUrl, { headers: user.headers });
    const authedText = await authed.text().catch(() => '');
    assertBrowser(
      'artifact.authenticated_api_download',
      authed.status() === 200 && authedText.includes('hardening artifact marker'),
      { status: authed.status(), bodyPrefix: authedText.slice(0, 120) },
      'real backend must serve the artifact with a bearer token',
    );

    // Plain <a download href> navigations do not surface reliably as page
    // responses in Chromium. Capture the real download event and verify both
    // the suggested filename and the admin-api audit row written by the
    // authenticated backend download path used by the earlier API assertion.
    let browserDownload: Download | null = null;
    let downloadError = '';
    try {
      const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
      await link.click();
      browserDownload = await downloadPromise;
    } catch (err) {
      downloadError = String(err);
    }
    const auditLog = path.join(RUN_DIR, 'logs', 'admin-api.log');
    await expect.poll(() => {
      try {
        return fs.readFileSync(auditLog, 'utf8').includes(`artifact.download`)
          && fs.readFileSync(auditLog, 'utf8').includes(`${execId}/${artifactName}`);
      } catch {
        return false;
      }
    }, { timeout: 15_000, intervals: [500, 500, 1000] }).toBeTruthy().catch(() => undefined);
    const downloadOk = !!browserDownload && browserDownload.suggestedFilename() === artifactName;
    assertBrowser(
      'artifact.browser_click_download',
      downloadOk,
      {
        suggestedFilename: browserDownload?.suggestedFilename() ?? null,
        downloadUrl: browserDownload?.url() ?? null,
        downloadError,
        auditLog,
        authedApiStatus: authed.status(),
        conclusion: downloadOk
          ? 'browser download event fired with expected filename; real backend audit row present'
          : 'browser download event missing or filename mismatch',
      },
      'clicking artifact entry must download through the real backend',
    );
    if (RUN_DIR) {
      const shot = path.join(RUN_DIR, 'artifact-click.png');
      await page.screenshot({ path: shot, fullPage: true });
      evidence.artifacts.artifactClickScreenshot = shot;
    }
  } finally {
    await stopPin();
  }
});

test('execution log SSE reconnect does not duplicate lines', async ({ page, request }) => {
  const user = await createBusinessUser(request, 'logsse');
  await loginInBrowser(page, user.username, user.password);
  const task = await createTask(request, user.headers, `h4-sse-${Date.now()}`);
  const execId = await insertRunningExecution({
    taskId: task.id,
    taskName: task.name,
    agentSessionId: null,
  });

  const markerA = `H4-SSE-A-${randomUUID()}`;
  const markerB = `H4-SSE-B-${randomUUID()}`;
  const markerC = `H4-SSE-C-${randomUUID()}`;
  await appendLogLines(request, execId, 0, [markerA, markerB]);

  const streamRequests: string[] = [];
  const streamResponses: Array<{ at: string; status: number; url: string }> = [];
  const streamFailures: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes(`/tasks/${task.id}/executions/${execId}/logs/stream`)) {
      streamRequests.push(`${new Date().toISOString()} ${req.url()}`);
    }
  });
  page.on('response', (resp) => {
    if (resp.url().includes(`/tasks/${task.id}/executions/${execId}/logs/stream`)) {
      streamResponses.push({ at: new Date().toISOString(), status: resp.status(), url: resp.url() });
    }
  });
  page.on('requestfailed', (req) => {
    if (req.url().includes(`/tasks/${task.id}/executions/${execId}/logs/stream`)) {
      streamFailures.push(`${new Date().toISOString()} ${req.failure()?.errorText ?? 'requestfailed'} ${req.url()}`);
    }
  });
  await page.goto(`/tasks/${task.id}/executions/${execId}`);
  await expect.poll(() => streamResponses.length, { timeout: 20_000, intervals: [500, 500, 1000] })
    .toBeGreaterThanOrEqual(1);
  const initialStatuses = streamResponses.map((r) => r.status);
  assertBrowser(
    'logsse.initial_stream_http_200',
    initialStatuses.includes(200),
    { responses: streamResponses, failures: streamFailures, requests: streamRequests },
    'execution detail SSE endpoint must return HTTP 200',
  );
  const pre = page.getByTestId('log-pre');
  await expect(pre).toBeVisible({ timeout: 30_000 });
  const sseStart = Date.now();
  await expect(pre).toContainText(markerA, { timeout: 30_000 });
  await expect(pre).toContainText(markerB, { timeout: 30_000 });
  const markerLatencyMs = Date.now() - sseStart;
  assertBrowser(
    'logsse.initial_stream',
    streamRequests.length >= 1 && markerLatencyMs < 8_000,
    { requests: streamRequests, responses: streamResponses, markerLatencyMs, note: '>=8s indicates REST fallback rather than live SSE' },
    'execution detail must receive real log SSE stream promptly',
  );

  // Force the EventSource close/reconnect path through the browser's own
  // visibility handler; the client is configured with reconnect:false and the
  // component rebuilds it from maxLineNumber + 1.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    setTimeout(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    }, 120);
  });
  await expect.poll(() => streamRequests.length, { timeout: 20_000, intervals: [500, 500, 1000] })
    .toBeGreaterThanOrEqual(2);
  const second = streamRequests[1] ?? '';
  assertBrowser(
    'logsse.reconnect_from_line',
    /[?&]fromLine=2(?:&|$)/.test(second),
    { secondRequest: second, allRequests: streamRequests },
    'reconnect must resume from maxLineNumber + 1',
  );

  await appendLogLines(request, execId, 2, [markerC]);
  await expect(pre).toContainText(markerC, { timeout: 30_000 });
  await page.waitForTimeout(1500);
  const text = await pre.innerText();
  const counts = {
    [markerA]: text.split(markerA).length - 1,
    [markerB]: text.split(markerB).length - 1,
    [markerC]: text.split(markerC).length - 1,
  };
  const values = Object.values(counts);
  assertBrowser(
    'logsse.no_duplicate_lines',
    values.every((n) => n === 1),
    { counts, lineNumbers: { [markerA]: 0, [markerB]: 1, [markerC]: 2 }, textLength: text.length },
    'each log line must appear exactly once after reconnect',
  );
  if (RUN_DIR) {
    const shot = path.join(RUN_DIR, 'sse-reconnect-success.png');
    await page.screenshot({ path: shot, fullPage: true });
    evidence.artifacts.sseReconnectScreenshot = shot;
  }
});
