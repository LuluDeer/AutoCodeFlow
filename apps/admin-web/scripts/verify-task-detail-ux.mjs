// verify-task-detail-ux.mjs — 任务详情两条用户路径的真 Chrome 验收脚本。
//
// 运行前提：admin-web dev server 已在 5176，且 `VITE_API_URL_INTERNAL=/api`。
//   npm run dev -- --host 127.0.0.1 --port 5176
// 运行：
//   npm run verify:task-detail-ux
//
// 夹具复用 apps/admin-web/scripts/ux-walkthrough.mjs 导出的 apiHandler / USER / TASKS。
// 不写任何截图或报告文件；需要调试图时用 TASKDETAIL_DEBUG_SHOT=1，图只落 /tmp。
// 输出为单个 JSON 摘要；任一断言失败或出现 pageerror 时退出码为 1。

import { chromium } from 'playwright-core';
import { apiHandler, USER } from './ux-walkthrough.mjs';

const BASE_URL = (process.env.TASKDETAIL_BASE_URL || 'http://127.0.0.1:5176').replace(/\/+$/, '');
const VIEWPORT = { width: 1280, height: 800 };
const GLUE_TASK_ID = 't-1004';
const WEBHOOK_TASK_ID = 't-1001';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cleanError(err) {
  const raw = err && (err.stack || err.message) ? (err.stack || err.message) : String(err);
  return raw.slice(0, 800);
}

function jsonResponse(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function waitUntil(predicate, label, timeout = 10_000, interval = 50) {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started >= timeout) throw new Error(`timeout waiting for ${label}`);
    await sleep(interval);
  }
}

function pathnameOf(page) {
  try {
    return new URL(page.url()).pathname;
  } catch {
    return page.url();
  }
}

function makeChecker(pathResult) {
  return async function check(name, fn) {
    try {
      const detail = await fn();
      pathResult.assertions.push({ name, ok: true, detail: detail ?? null });
      return true;
    } catch (err) {
      pathResult.assertions.push({ name, ok: false, error: cleanError(err) });
      return false;
    }
  };
}

function makeRequire(check) {
  return async function requireOk(name, fn) {
    const ok = await check(name, fn);
    if (!ok) throw new Error(`assertion not ok: ${name}`);
  };
}

function createRouteTracker() {
  const tracker = {
    counts: {},
    calls: [],
    routeErrors: [],
  };
  async function handler(route) {
    const req = route.request();
    const url = new URL(req.url());
    const key = `${req.method()} ${url.pathname}`;
    tracker.counts[key] = (tracker.counts[key] || 0) + 1;
    tracker.calls.push(key);
    if (!url.pathname.startsWith('/api/')) return route.continue();
    try {
      return await apiHandler(route);
    } catch (err) {
      tracker.routeErrors.push(cleanError(err));
      return jsonResponse(route, { message: 'fixture route error' }, 500);
    }
  }
  return { tracker, handler };
}

function createWebhookFixture() {
  const state = {
    enabled: false,
    url: '',
    enableSeen: false,
    initialGetRequests: 0,
    initialDisabledSettled: 0,
    pendingInitialGets: [],
    releasedInitialGets: 0,
    staleGetsSettled: 0,
    postEnableGetCount: 0,
    freshGetsSettled: 0,
    responseSeq: 0,
    responseEvents: [],
  };
  const tracker = { counts: {}, calls: [], routeErrors: [] };

  function recordResponse(kind) {
    state.responseSeq += 1;
    state.responseEvents.push({ kind, seq: state.responseSeq });
  }

  async function releaseInitialGets() {
    const pending = state.pendingInitialGets.splice(0);
    const results = await Promise.allSettled(pending.map((done) => done()));
    state.releasedInitialGets += results.filter((r) => r.status === 'fulfilled').length;
  }

  async function handler(route) {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const pathname = url.pathname;
    const key = `${method} ${pathname}`;
    tracker.counts[key] = (tracker.counts[key] || 0) + 1;
    tracker.calls.push(key);

    if (!pathname.startsWith('/api/')) return route.continue();

    if (method === 'GET' && pathname === `/api/tasks/${WEBHOOK_TASK_ID}/webhook`) {
      if (!state.enableSeen) {
        state.initialGetRequests += 1;
        if (state.initialGetRequests === 1) {
          // 第一发初始 GET 先真正结算为 disabled，供 P2-1 断言真实「未启用」态。
          await jsonResponse(route, { enabled: false, url: '' });
          state.initialDisabledSettled += 1;
          recordResponse('initial-disabled');
          return;
        }
        // 后续初始 GET（StrictMode effect 重放）挂起，在 fresh enabled GET 结算后再回 disabled。
        return new Promise((resolve) => {
          state.pendingInitialGets.push(async () => {
            await jsonResponse(route, { enabled: false, url: '' });
            state.staleGetsSettled += 1;
            recordResponse('stale-disabled');
            resolve();
          });
        });
      }
      state.postEnableGetCount += 1;
      await jsonResponse(route, { enabled: true, url: 'http://fixture/hook' });
      state.freshGetsSettled += 1;
      recordResponse('fresh-enabled');
      return;
    }

    if (method === 'POST' && pathname === `/api/tasks/${WEBHOOK_TASK_ID}/webhook/enable`) {
      state.enableSeen = true;
      state.enabled = true;
      state.url = 'http://fixture/hook';
      return jsonResponse(route, {
        url: 'http://fixture/hook',
        secret: 'acf_test_secret',
      });
    }

    if (method === 'POST' && pathname === `/api/tasks/${WEBHOOK_TASK_ID}/webhook/rotate`) {
      return jsonResponse(route, {
        url: 'http://fixture/hook',
        secret: 'acf_test_rotated_secret',
      });
    }

    if (method === 'POST' && pathname === `/api/tasks/${WEBHOOK_TASK_ID}/webhook/disable`) {
      state.enabled = false;
      return jsonResponse(route, { enabled: false });
    }

    try {
      return await apiHandler(route);
    } catch (err) {
      tracker.routeErrors.push(cleanError(err));
      return jsonResponse(route, { message: 'fixture route error' }, 500);
    }
  }

  return { state, tracker, handler, releaseInitialGets };
}

async function launchBrowser() {
  const candidates = [
    process.env.TASKDETAIL_CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  const errors = [];
  for (const executablePath of candidates) {
    try {
      const browser = await chromium.launch({ executablePath, headless: true });
      return { browser, executablePath };
    } catch (err) {
      errors.push(`${executablePath}: ${cleanError(err)}`);
    }
  }
  try {
    const browser = await chromium.launch({ headless: true });
    return { browser, executablePath: 'playwright bundled chromium' };
  } catch (err) {
    errors.push(`bundled: ${cleanError(err)}`);
    throw new Error(`browser launch failed; ${errors.join(' | ')}`);
  }
}

async function newFixtureContext(browser, routeHandler) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  await context.route('**/*', routeHandler);
  await context.addInitScript(([auth]) => {
    try {
      localStorage.setItem('autoflow-auth', auth);
      localStorage.setItem('autoflow-lang', 'zh');
      localStorage.setItem('autoflow_use_external_api', 'false');
    } catch {
      // ignore storage errors on non-http init contexts
    }
  }, [JSON.stringify({
    state: {
      token: 'mock-access-token',
      refreshToken: 'mock-refresh-token',
      user: USER,
    },
    version: 0,
  })]);
  return context;
}

async function debugShot(page, name) {
  if (process.env.TASKDETAIL_DEBUG_SHOT !== '1') return;
  try {
    await page.screenshot({ path: `/tmp/verify-task-detail-ux-${name}.png` });
  } catch {
    // debug screenshot is best-effort
  }
}

async function runGlueGuardPath(browser, pathResult) {
  const check = makeChecker(pathResult);
  const requireOk = makeRequire(check);
  const pageErrors = [];
  let context;
  let page;
  const { tracker, handler } = createRouteTracker();

  try {
    context = await newFixtureContext(browser, handler);
    page = await context.newPage();
    page.on('pageerror', (err) => pageErrors.push(cleanError(err)));

    await page.goto(`${BASE_URL}/tasks/${GLUE_TASK_ID}`, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });

    await requireOk('初始 URL 为任务详情', async () => {
      await waitUntil(() => pathnameOf(page) === `/tasks/${GLUE_TASK_ID}`, 'detail url');
      return pathnameOf(page);
    });

    const glueTab = page.getByRole('tab', { name: /Glue 脚本/ }).first();
    await requireOk('Glue 脚本 Tab 可见', async () => {
      await glueTab.waitFor({ state: 'visible', timeout: 15_000 });
      return 'visible';
    });
    await glueTab.click();

    // antd 6 的 active content 容器是 .ant-tabs-content-active（旧版 .ant-tabs-tabpane-active 已不存在）。
    const activePane = page.locator('.ant-tabs-content-active').last();
    const languageSelect = activePane.locator('.ant-select').filter({ hasText: /Python/ }).first();
    await requireOk('Glue 编辑器与语言 Select 挂载', async () => {
      await activePane.getByText('Glue 脚本编辑器', { exact: true }).waitFor({
        state: 'visible',
        timeout: 20_000,
      });
      await languageSelect.waitFor({ state: 'visible', timeout: 20_000 });
      await activePane.locator('.monaco-editor').first().waitFor({
        state: 'visible',
        timeout: 20_000,
      });
      return 'editor mounted';
    });

    await requireOk('语言初值为 Python', async () => {
      // antd 6 用 .ant-select-content 承载显示值；保留旧版选择器兜底。
      const text = await languageSelect
        .locator('.ant-select-content, .ant-select-selection-item')
        .first()
        .textContent();
      if (!/Python/.test(text || '')) throw new Error(`selection is ${text}`);
      return text.trim();
    });

    await languageSelect.click();
    const shellOption = page
      .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
      .filter({ hasText: /^Shell$/ })
      .first();
    await requireOk('Shell 选项可见', async () => {
      await shellOption.waitFor({ state: 'visible', timeout: 8_000 });
      return 'visible';
    });
    await shellOption.click();

    const dirtyText = activePane.getByText('有未保存的更改', { exact: true });
    await requireOk('切换语言触发 dirty', async () => {
      await dirtyText.waitFor({ state: 'visible', timeout: 8_000 });
      return 'dirty visible';
    });

    // 页头返回带 ArrowLeftOutlined，accessible name 会带图标前缀，按可见文本定位。
    const backButton = page.locator('button').filter({ hasText: /^返\s*回$/ }).first();
    await requireOk('页头返回按钮可见', async () => {
      await backButton.waitFor({ state: 'visible', timeout: 8_000 });
      return 'visible';
    });
    await backButton.click();

    await requireOk('首次返回被守卫拦截，URL 不变', async () => {
      await sleep(150);
      const current = pathnameOf(page);
      if (current !== `/tasks/${GLUE_TASK_ID}`) throw new Error(`url changed to ${current}`);
      return current;
    });

    const guardDialog = page
      .getByRole('dialog')
      .filter({ hasText: 'Glue 脚本有未保存的修改' })
      .first();
    await requireOk('未保存守卫 Modal 出现', async () => {
      await guardDialog.waitFor({ state: 'visible', timeout: 8_000 });
      return 'visible';
    });

    await guardDialog.locator('button').filter({ hasText: /留\s*下/ }).first().click();
    await requireOk('点击留下后 URL 不变且 Modal 关闭', async () => {
      const current = pathnameOf(page);
      if (current !== `/tasks/${GLUE_TASK_ID}`) throw new Error(`url changed to ${current}`);
      await guardDialog.waitFor({ state: 'hidden', timeout: 8_000 });
      return current;
    });

    await backButton.click();
    await requireOk('再次返回可重新打开守卫 Modal', async () => {
      await guardDialog.waitFor({ state: 'visible', timeout: 8_000 });
      return 'visible';
    });

    await guardDialog.locator('button').filter({ hasText: /离\s*开/ }).first().click();
    await requireOk('点击离开后跳到任务列表', async () => {
      await page.waitForURL(
        (url) => new URL(url).pathname === '/tasks',
        { timeout: 10_000 },
      );
      return pathnameOf(page);
    });

    await debugShot(page, 'glue-guard-done');
  } catch (err) {
    pathResult.error = cleanError(err);
  } finally {
    pathResult.requestCounts = tracker.counts;
    pathResult.requests = tracker.calls;
    pathResult.routeErrors = tracker.routeErrors;
    pathResult.pageerror = pageErrors;
    await check('无 pageerror', () => {
      if (pageErrors.length) throw new Error(pageErrors.join(' | '));
      return 0;
    });
    if (context) await context.close().catch(() => {});
  }
}

async function runWebhookRacePath(browser, pathResult) {
  const check = makeChecker(pathResult);
  const requireOk = makeRequire(check);
  const pageErrors = [];
  let context;
  let page;
  const fixture = createWebhookFixture();

  try {
    context = await newFixtureContext(browser, fixture.handler);
    page = await context.newPage();
    page.on('pageerror', (err) => pageErrors.push(cleanError(err)));

    await page.goto(`${BASE_URL}/tasks/${WEBHOOK_TASK_ID}`, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });

    const webhookCard = page
      .locator('.ant-card')
      .filter({ hasText: 'Webhook 触发' })
      .first();
    await requireOk('Webhook 管理卡片可见', async () => {
      await webhookCard.waitFor({ state: 'visible', timeout: 15_000 });
      return 'visible';
    });

    await requireOk('初始 webhook GET 返回 disabled 并结算', async () => {
      await waitUntil(() => fixture.state.initialDisabledSettled >= 1, 'initial disabled GET settled');
      // route.fulfill 到 React commit 有一拍延迟，先让 disabled 状态真正落到 UI。
      await sleep(150);
      await webhookCard.getByText('未启用', { exact: true }).waitFor({
        state: 'visible',
        timeout: 8_000,
      });
      return {
        initialGetRequests: fixture.state.initialGetRequests,
        initialDisabledSettled: fixture.state.initialDisabledSettled,
      };
    });

    const enableButton = webhookCard.getByRole('button', { name: /^启\s*用$/ }).first();
    await requireOk('disabled 结算后仍显示启用按钮', async () => {
      await enableButton.waitFor({ state: 'visible', timeout: 10_000 });
      return 'visible';
    });

    await requireOk('存在待释放的陈旧初始 GET', async () => {
      await waitUntil(() => fixture.state.pendingInitialGets.length >= 1, 'stale initial GET pending');
      return fixture.state.pendingInitialGets.length;
    });

    await enableButton.click();

    await requireOk('POST enable 只发一次', async () => {
      const key = `POST /api/tasks/${WEBHOOK_TASK_ID}/webhook/enable`;
      await waitUntil(() => (fixture.tracker.counts[key] || 0) === 1, 'enable request');
      return fixture.tracker.counts[key];
    });

    const secretDialog = page
      .getByRole('dialog')
      .filter({ hasText: 'Webhook 密钥（仅显示一次）' })
      .first();
    await requireOk('一次性密钥弹窗出现并含 secret', async () => {
      await secretDialog.waitFor({ state: 'visible', timeout: 10_000 });
      await secretDialog.getByText('acf_test_secret', { exact: true }).waitFor({
        state: 'visible',
        timeout: 8_000,
      });
      return 'visible';
    });

    await requireOk('fresh enabled GET 响应已结算且页面显示已启用', async () => {
      await waitUntil(() => fixture.state.postEnableGetCount >= 1, 'post-enable status GET');
      await waitUntil(() => fixture.state.freshGetsSettled >= 1, 'fresh enabled GET settled');
      await webhookCard.getByText('已启用', { exact: true }).waitFor({
        state: 'visible',
        timeout: 8_000,
      });
      return {
        postEnableGetCount: fixture.state.postEnableGetCount,
        freshGetsSettled: fixture.state.freshGetsSettled,
      };
    });

    // 弹窗先关，再断言底层卡片按钮态，避免 aria-hidden 干扰按钮计数。
    await secretDialog.locator('.ant-modal-close').click();
    await requireOk('密钥弹窗可关闭', async () => {
      await secretDialog.waitFor({ state: 'hidden', timeout: 8_000 });
      return 'hidden';
    });

    await requireOk('fresh GET 后不再显示启用按钮', async () => {
      const count = await webhookCard.getByRole('button', { name: /^启\s*用$/ }).count();
      if (count !== 0) throw new Error(`enable buttons: ${count}`);
      return count;
    });

    await requireOk('fresh GET 后显示轮换密钥与停用按钮', async () => {
      // 图标会给 Button 的 accessible name 加前缀，直接用可见文本更稳。
      await webhookCard.locator('button').filter({ hasText: /轮\s*换\s*密\s*钥/ }).first().waitFor({
        state: 'visible',
        timeout: 8_000,
      });
      await webhookCard.locator('button').filter({ hasText: /停\s*用/ }).first().waitFor({
        state: 'visible',
        timeout: 8_000,
      });
      return 'visible';
    });

    // fresh enabled GET 已结算、UI 已显示「已启用」，此时才释放更早发出的 disabled GET。
    await fixture.releaseInitialGets();

    await requireOk('陈旧 disabled GET 晚于 fresh enabled GET 结算', async () => {
      await waitUntil(() => fixture.state.staleGetsSettled >= 1, 'stale disabled GET settled');
      const events = fixture.state.responseEvents;
      const freshSeq = events.find((event) => event.kind === 'fresh-enabled')?.seq;
      const staleSeq = events.find((event) => event.kind === 'stale-disabled')?.seq;
      if (!freshSeq || !staleSeq || staleSeq <= freshSeq) {
        throw new Error(`unexpected response order: ${JSON.stringify(events)}`);
      }
      // route.fulfill 结算后 React commit 仍可能晚一拍；留出 handleResponse 的执行窗口。
      await sleep(200);
      return { freshSeq, staleSeq, events };
    });

    await requireOk('陈旧 GET 后页面仍显示已启用', async () => {
      await webhookCard.getByText('已启用', { exact: true }).waitFor({
        state: 'visible',
        timeout: 8_000,
      });
      return 'visible';
    });

    await requireOk('陈旧 GET 后仍不显示启用按钮', async () => {
      const count = await webhookCard.getByRole('button', { name: /^启\s*用$/ }).count();
      if (count !== 0) throw new Error(`enable buttons: ${count}`);
      return count;
    });

    await requireOk('陈旧 GET 后仍显示轮换密钥与停用按钮', async () => {
      await webhookCard.locator('button').filter({ hasText: /轮\s*换\s*密\s*钥/ }).first().waitFor({
        state: 'visible',
        timeout: 8_000,
      });
      await webhookCard.locator('button').filter({ hasText: /停\s*用/ }).first().waitFor({
        state: 'visible',
        timeout: 8_000,
      });
      return 'visible';
    });

    const rotateButton = webhookCard
      .locator('button')
      .filter({ hasText: /轮\s*换\s*密\s*钥/ })
      .first();
    await rotateButton.click();

    const rotateConfirm = page.locator('.ant-popconfirm:visible').filter({
      hasText: '轮换后旧密钥立即失效，确定轮换？',
    }).first();
    await requireOk('轮换 Popconfirm 出现', async () => {
      await rotateConfirm.waitFor({ state: 'visible', timeout: 8_000 });
      return 'visible';
    });
    await rotateConfirm.locator('.ant-btn-primary').click();

    await requireOk('轮换只发一次 rotate', async () => {
      const key = `POST /api/tasks/${WEBHOOK_TASK_ID}/webhook/rotate`;
      await waitUntil(() => (fixture.tracker.counts[key] || 0) === 1, 'rotate request');
      return fixture.tracker.counts[key];
    });

    await requireOk('轮换未触发第二次 enable', async () => {
      const key = `POST /api/tasks/${WEBHOOK_TASK_ID}/webhook/enable`;
      const count = fixture.tracker.counts[key] || 0;
      if (count !== 1) throw new Error(`enable requests: ${count}`);
      return count;
    });

    await debugShot(page, 'webhook-race-done');
  } catch (err) {
    pathResult.error = cleanError(err);
  } finally {
    await fixture.releaseInitialGets().catch(() => {});
    pathResult.requestCounts = fixture.tracker.counts;
    pathResult.requests = fixture.tracker.calls;
    pathResult.routeErrors = fixture.tracker.routeErrors;
    pathResult.pageerror = pageErrors;
    pathResult.fixture = {
      initialGetRequests: fixture.state.initialGetRequests,
      initialDisabledSettled: fixture.state.initialDisabledSettled,
      initialGetsReleased: fixture.state.releasedInitialGets,
      staleGetsSettled: fixture.state.staleGetsSettled,
      postEnableGetCount: fixture.state.postEnableGetCount,
      freshGetsSettled: fixture.state.freshGetsSettled,
      responseEvents: fixture.state.responseEvents,
    };
    await check('无 pageerror', () => {
      if (pageErrors.length) throw new Error(pageErrors.join(' | '));
      return 0;
    });
    if (context) await context.close().catch(() => {});
  }
}

async function main() {
  const startedAt = new Date().toISOString();
  const summary = {
    ok: false,
    startedAt,
    baseUrl: BASE_URL,
    viewport: VIEWPORT,
    browser: null,
    paths: {
      A: { name: 'Glue 未保存守卫', ok: false, assertions: [] },
      B: { name: 'Webhook 竞态', ok: false, assertions: [] },
    },
  };

  let browser;
  let executablePath = '';
  try {
    const launched = await launchBrowser();
    browser = launched.browser;
    executablePath = launched.executablePath;
    summary.browser = { executablePath, version: browser.version() };

    await runGlueGuardPath(browser, summary.paths.A);
    await runWebhookRacePath(browser, summary.paths.B);
  } catch (err) {
    summary.error = cleanError(err);
    for (const result of Object.values(summary.paths)) {
      if (!result.error) result.error = cleanError(err);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    for (const result of Object.values(summary.paths)) {
      result.ok = !result.error && result.assertions.every((item) => item.ok);
    }
    summary.ok = Object.values(summary.paths).every((result) => result.ok);
    summary.finishedAt = new Date().toISOString();
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (!summary.ok) process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: cleanError(err),
    finishedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  process.exitCode = 1;
});
