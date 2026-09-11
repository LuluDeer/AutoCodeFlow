// UI-09 真机走查：375×812 视口下 Dashboard / 执行详情 无横向溢出、关键内容可达。
//
// 背景：UI-09 表格三页半场（3351eb9）+ Dashboard/ExecutionDetail 补齐半场（007）此前
// 仅有 jsdom 断言，缺「真实浏览器 375px」走查；本 spec 挂在 e2e-full.sh 的同一栈上跑：
//   bash scripts/e2e-full.sh e2e-full.spec.js e2e-ui09-mobile.spec.js
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:5176';
const API = process.env.E2E_API_BASE || 'http://localhost:3105';
const USER = 'admin';
const PASS = 'admin123';

test.use({ viewport: { width: 375, height: 812 } });

async function login(page) {
  await page.goto(`${BASE}/login`);
  await page
    .locator('input[id*="username"], input[placeholder*="用户名"], input[name="username"]')
    .first()
    .fill(USER);
  await page.locator('input[type="password"]').first().fill(PASS);
  await page.getByRole('button', { name: /登\s*录/ }).first().click();
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30000 });
}

/** 375px 下不得出现横向溢出（文档/body 宽度不得超过视口；+1px 容差抗亚像素） */
async function assertNoHorizontalOverflow(page, label) {
  const box = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    win: window.innerWidth,
  }));
  expect(box.win).toBeLessThanOrEqual(376);
  expect(box.doc, `${label}：documentElement 横向溢出（${box.doc} > ${box.win}）`).toBeLessThanOrEqual(box.win + 1);
  expect(box.body, `${label}：body 横向溢出（${box.body} > ${box.win}）`).toBeLessThanOrEqual(box.win + 1);
}

/** 取一条真实执行 id：优先 API（两个候选路径，任一可用即可） */
async function firstExecutionId(request) {
  const loginResp = await request.post(`${API}/api/auth/login`, { data: { username: USER, password: PASS } });
  const token = (await loginResp.json()).data?.accessToken;
  if (!token) return null;
  for (const path of ['/api/task-executions?page=1&pageSize=1', '/api/executions?page=1&pageSize=1']) {
    try {
      const r = await request.get(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok()) continue;
      const item = (await r.json()).data?.items?.[0];
      if (item?.id) return item.id;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** 库中无执行时，API 造一条最小 glue 任务并触发，轮询到终态后返回执行 id */
async function seedExecution(request) {
  const loginResp = await request.post(`${API}/api/auth/login`, { data: { username: USER, password: PASS } });
  const token = (await loginResp.json()).data?.accessToken;
  if (!token) return null;
  const createResp = await request.post(`${API}/api/tasks`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      name: `ui09-mobile-exec-seed-${Date.now()}`,
      triggerType: 'manual',
      runtime: 'node',
      entrypoint: 'index.js',
      glueLanguage: 'javascript',
      glueSource: "console.log('ui09 mobile walkthrough');",
    },
  });
  const task = (await createResp.json()).data;
  if (!task?.id) return null;
  const triggerResp = await request.post(`${API}/api/tasks/${task.id}/trigger`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {},
  });
  if (!triggerResp.ok()) return null;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const r = await request.get(`${API}/api/tasks/${task.id}/executions?page=1&pageSize=5`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const item = (await r.json()).data?.items?.[0];
    if (item?.id && ['success', 'failed', 'timeout', 'killed', 'cancelled'].includes(item.status)) return item.id;
    await new Promise((res) => setTimeout(res, 1000));
  }
  return null;
}

test.describe('UI-09 移动端真机走查（375×812）', () => {
  test('45. Dashboard 在 375px 无横向溢出且 KPI 区可见', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/dashboard`);
    await expect(page.getByText('任务总数').first()).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(1200);
    await assertNoHorizontalOverflow(page, 'Dashboard 375px');
    console.log('  ✓ Dashboard 375px 无横向溢出');
  });

  test('46. 执行详情在 375px 无横向溢出', async ({ page, request }) => {
    let id = await firstExecutionId(request);
    if (!id) {
      id = await seedExecution(request);
      console.log(id ? `  · 库无执行，API seed 得 execution ${id}` : '  · seed 失败');
    }
    test.skip(!id, '通过 API seed 执行失败（任务创建/触发/终态任一步未就绪），跳过执行详情走查');
    await login(page);
    await page.goto(`${BASE}/executions/${id}`);
    await page.waitForTimeout(1500);
    await assertNoHorizontalOverflow(page, '执行详情 375px');
    console.log(`  ✓ 执行详情 ${id} 375px 无横向溢出`);
  });
});
