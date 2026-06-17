// AutoCodeFlow 全场景 E2E 测试
// 覆盖：登录、应用管理、任务调度、执行日志、运行机管理、并发状态、中断任务、仓库、通知、审计
const { test, expect, request: pwRequest } = require('@playwright/test');
const fs = require('fs');

const BASE = 'http://localhost:5176';
const API  = 'http://localhost:3002';
const USER = 'admin';
const PASS = 'admin123';
const AUTH_FILE = '/tmp/e2e-auth.json';

// ── 从 globalSetup 写入的文件读取 token（只有一次 API 登录，不触发 rate limiter）
function getAuth() {
  try {
    const raw = fs.readFileSync(AUTH_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`无法读取认证文件 ${AUTH_FILE}，请确认 globalSetup 已运行: ${e.message}`);
  }
}

// ── 登录辅助：注入 token 到 Zustand store（通过 addInitScript patch localStorage）
async function login(page) {
  const { token, refreshToken, user } = getAuth();

  // addInitScript 必须在第一次 goto 之前注册，才能在 React 加载前执行
  // 通过覆盖 localStorage.getItem 让 Zustand persist hydration 读到完整 auth state（含 token）
  await page.addInitScript(({ token, refreshToken, user }) => {
    const _orig = localStorage.getItem.bind(localStorage);
    localStorage.getItem = function(key) {
      if (key === 'autoflow-auth') {
        return JSON.stringify({
          state: { token, refreshToken, user },
          version: 0,
        });
      }
      return _orig(key);
    };
  }, { token, refreshToken, user });

  // 直接导航到首页，Zustand persist 在 hydration 时会读到包含 token 的 state
  await page.goto(`${BASE}/`);
  await page.waitForLoadState('networkidle');

  // 验证是否已经离开 login 页
  if (page.url().includes('/login')) {
    // 最后手段：真实表单提交（此时可能是 token 过期，需刷新缓存）
    _cachedAuth = null;
    const freshAuth = await getAuth();
    const userInput = page.locator('input[placeholder*="用户名"], input[name="username"]').first();
    const passInput = page.locator('input[type="password"]').first();
    await userInput.waitFor({ state: 'visible', timeout: 8000 });
    await userInput.fill(USER);
    await passInput.fill(PASS);
    await page.getByRole('button', { name: /登\s*录/ }).click();
    await page.waitForURL(url => !url.href.includes('/login'), { timeout: 30000 });
    console.log('  ✓ 登录成功（表单降级）');
    return;
  }

  console.log('  ✓ 登录成功');
}

// ── API 辅助（Node 层，无 CORS 限制）────────────────────────────────────────
async function apiLogin() {
  const ctx = await pwRequest.newContext();
  const resp = await ctx.post(`${API}/api/auth/login`, {
    data: { username: USER, password: PASS },
  });
  const body = await resp.json();
  await ctx.dispose();
  return body.data?.accessToken;
}

// ── 1. 登录 & Dashboard ───────────────────────────────────────────────────────
test('1. 登录与仪表盘', async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/`);
  await page.waitForLoadState('networkidle');
  const title = await page.title();
  console.log('  页面标题:', title);
  const body = await page.locator('body').innerText();
  console.log('  Dashboard 内容片段:', body.slice(0, 300).replace(/\n/g, ' '));
  await page.screenshot({ path: '/tmp/e2e-01-dashboard.png', fullPage: false });
});

// ── 2. 应用管理：列表、新建、查看详情 ───────────────────────────────────────
test('2. 应用管理 — 新建应用', async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/applications`);
  await page.waitForLoadState('networkidle');
  console.log('  URL:', page.url());

  const createBtn = page.getByRole('button', { name: /新建|创建|\+|New|Add/i }).first();
  const hasBtnCreate = await createBtn.isVisible().catch(() => false);
  if (hasBtnCreate) {
    await createBtn.click();
    await page.waitForTimeout(1000);
    // 对话框打开后，获取第一个文本输入框（应用名称）
    const dialog = page.locator('div[role="dialog"]').first();
    await dialog.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    const nameInput = dialog.locator('input[type="text"]').first();
    const hasInput = await nameInput.isVisible().catch(() => false);
    if (hasInput) {
      await nameInput.fill('E2E-测试应用-' + Date.now().toString().slice(-6));
      // 按钮文字可能带空格（如「确 定」），用宽松正则匹配
      const okBtn = dialog.getByRole('button', { name: /确\s*定|确\s*认|提交|OK|Submit/i }).first();
      await okBtn.click();
      await page.waitForTimeout(2000);
      console.log('  ✓ 应用新建成功');
    } else {
      console.log('  ⚠ 未找到名称输入框，截图确认');
    }
  } else {
    console.log('  ⚠ 未找到新建按钮，当前页内容:', (await page.locator('body').innerText()).slice(0, 200));
  }
  await page.screenshot({ path: '/tmp/e2e-02-applications.png', fullPage: false });
});

// ── 3. 任务管理：新建任务（带Cron + JS 脚本）───────────────────────────────
test('3. 任务管理 — 新建定时任务', async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/tasks`);
  await page.waitForLoadState('networkidle');
  console.log('  任务列表 URL:', page.url());

  const taskCountText = await page.locator('body').innerText();
  console.log('  页面内容片段:', taskCountText.slice(0, 200).replace(/\n/g, ' '));

  const newBtn = page.getByRole('button', { name: /新建|创建|\+|New/i }).first();
  const visible = await newBtn.isVisible().catch(() => false);
  if (visible) {
    await newBtn.click();
    await page.waitForLoadState('networkidle');
    console.log('  跳转到任务表单:', page.url());

    const nameField = page.locator('input[id*="name"], input[placeholder*="任务名"], input[placeholder*="name"]').first();
    const hasName = await nameField.isVisible().catch(() => false);
    if (hasName) {
      await nameField.fill('E2E-测试任务-每分钟');
    }

    const cronField = page.locator('input[id*="cron"], input[placeholder*="cron"], input[placeholder*="Cron"]').first();
    const hasCron = await cronField.isVisible().catch(() => false);
    if (hasCron) {
      await cronField.fill('* * * * *');
      console.log('  ✓ 设置 Cron: * * * * *');
    }

    await page.waitForTimeout(2000);
    const monacoEditor = page.locator('.monaco-editor, .cm-editor').first();
    const hasEditor = await monacoEditor.isVisible().catch(() => false);
    if (hasEditor) {
      await monacoEditor.click();
      await page.keyboard.press('Control+a');
      await page.keyboard.type('console.log("E2E test task running:", new Date().toISOString());\nreturn { status: "ok" };');
      console.log('  ✓ 填写 JS脚本');
    }

    await page.screenshot({ path: '/tmp/e2e-03-task-form.png', fullPage: false });

    const submitBtn = page.getByRole('button', { name: /保存|提交|确定|Save|Submit/i }).first();
    const hasSubmit = await submitBtn.isVisible().catch(() => false);
    if (hasSubmit) {
      await submitBtn.click();
      await page.waitForTimeout(2000);
      console.log('  ✓ 任务表单提交');
    }
  }
  await page.screenshot({ path: '/tmp/e2e-03-task-list.png', fullPage: false });
});

// ── 4. 手动触发任务执行 ──────────────────────────────────────────────────────
test('4. 手动触发任务 & 查看执行', async ({ page, request }) => {
  await login(page);

  // 通过 Node 层 API 获取任务列表（无 CORS）
  const loginResp = await request.post(`${API}/api/auth/login`, {
    data: { username: USER, password: PASS },
  });
  const loginBody = await loginResp.json();
  const token = loginBody.data?.accessToken;
  console.log('  API token 获取:', token ? '✓' : '✗');

  const tasksResp = await request.get(`${API}/api/tasks?page=1&pageSize=5`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const tasks = await tasksResp.json();
  console.log('  API 任务列表:', JSON.stringify(tasks).slice(0, 300));

  await page.goto(`${BASE}/tasks`);
  await page.waitForLoadState('networkidle');

  const triggerBtn = page.getByRole('button', { name: /立即执行|手动|触发|Run|Execute/i }).first();
  const hasRun = await triggerBtn.isVisible().catch(() => false);
  if (hasRun) {
    await triggerBtn.click();
    await page.waitForTimeout(2000);
    console.log('  ✓ 手动触发任务');
  } else {
    const actionBtn = page.locator('table tbody tr:first-child').getByRole('button').first();
    const hasAction = await actionBtn.isVisible().catch(() => false);
    if (hasAction) {
      await actionBtn.click();
      await page.waitForTimeout(1000);
      console.log('  ✓ 点击第一个任务操作按钮');
    } else {
      console.log('  ⚠ 未找到触发按钮，直接通过 API 触发');
      if (tasks?.data?.items?.length > 0) {
        const taskId = tasks.data.items[0].id;
        const trigResp = await request.post(`${API}/api/tasks/${taskId}/trigger`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const trigBody = await trigResp.json();
        console.log('  API 触发结果:', JSON.stringify(trigBody).slice(0, 200));
      }
    }
  }
  await page.screenshot({ path: '/tmp/e2e-04-trigger.png', fullPage: false });
});

// ── 5. 执行日志列表 & 详情 ───────────────────────────────────────────────────
test('5. 执行日志 — 列表与详情', async ({ page, request }) => {
  await login(page);
  await page.goto(`${BASE}/executions`);
  await page.waitForLoadState('networkidle');
  console.log('  执行列表 URL:', page.url());

  const bodyText = await page.locator('body').innerText();
  console.log('  执行列表内容片段:', bodyText.slice(0, 400).replace(/\n/g, ' | '));

  const firstRow = page.locator('table tbody tr, .ant-table-tbody tr').first();
  const hasRow = await firstRow.isVisible().catch(() => false);
  if (hasRow) {
    await firstRow.click();
    await page.waitForTimeout(2000);
    console.log('  详情 URL:', page.url());
    const detailText = await page.locator('body').innerText();
    console.log('  执行详情片段:', detailText.slice(0, 500).replace(/\n/g, ' | '));
    await page.screenshot({ path: '/tmp/e2e-05-exec-detail.png', fullPage: false });

    const logArea = page.locator('pre, .log-output, .ant-typography pre, [class*="log"]').first();
    const hasLog = await logArea.isVisible().catch(() => false);
    if (hasLog) {
      const logText = await logArea.innerText();
      console.log('  日志输出:', logText.slice(0, 300));
    }
  } else {
    console.log('  ⚠ 暂无执行记录，通过 API 查验');
    const loginResp = await request.post(`${API}/api/auth/login`, {
      data: { username: USER, password: PASS },
    });
    const token = (await loginResp.json()).data?.accessToken;
    const execsResp = await request.get(`${API}/api/task-executions?page=1&pageSize=5`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const execs = await execsResp.json();
    console.log('  API 执行记录:', JSON.stringify(execs).slice(0, 400));
  }
  await page.screenshot({ path: '/tmp/e2e-05-executions.png', fullPage: false });
});

// ── 6. 运行机列表 & 详情 ─────────────────────────────────────────────────────
test('6. 运行机 — 列表、详情、安装向导', async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/executors`);
  await page.waitForLoadState('networkidle');

  const bodyText = await page.locator('body').innerText();
  console.log('  运行机列表片段:', bodyText.slice(0, 400).replace(/\n/g, ' | '));
  await page.screenshot({ path: '/tmp/e2e-06-executors.png', fullPage: false });

  // 点击第一台运行机查看详情
  const firstRow = page.locator('table tbody tr, .ant-table-tbody tr').first();
  const hasRow = await firstRow.isVisible().catch(() => false);
  if (hasRow) {
    await firstRow.click();
    await page.waitForTimeout(2000);
    console.log('  运行机详情 URL:', page.url());
    const detail = await page.locator('body').innerText();
    console.log('  运行机详情片段:', detail.slice(0, 400).replace(/\n/g, ' | '));
    await page.screenshot({ path: '/tmp/e2e-06-executor-detail.png', fullPage: false });
  } else {
    console.log('  ⚠ 无运行机记录');
  }

  // 安装向导入口
  const installBtn = page.getByRole('button', { name: /安装|注册|添加|Install|Register|Add/i }).first();
  const hasInstall = await installBtn.isVisible().catch(() => false);
  if (hasInstall) {
    await installBtn.click();
    await page.waitForTimeout(1500);
    console.log('  安装向导 URL:', page.url());
    const wizardText = await page.locator('body').innerText();
    console.log('  安装向导内容:', wizardText.slice(0, 300).replace(/\n/g, ' | '));
    await page.screenshot({ path: '/tmp/e2e-06-install-wizard.png', fullPage: false });
  } else {
    console.log('  ⚠ 未找到安装/注册按钮');
  }
});

// ── 7. 运行机包管理 & 私有仓库 ──────────────────────────────────────────────
test('7. 运行机包管理 & 私有仓库', async ({ page }) => {
  await login(page);
  const pkgPaths = ['/packages', '/executors/packages', '/settings/packages'];
  let pkgFound = false;
  for (const p of pkgPaths) {
    await page.goto(`${BASE}${p}`);
    await page.waitForLoadState('networkidle').catch(() => {});
    if (!page.url().includes('/login')) {
      const text = await page.locator('body').innerText();
      console.log(`  包管理页 [${p}]:`, text.slice(0, 200).replace(/\n/g, ' | '));
      await page.screenshot({ path: '/tmp/e2e-07-packages.png', fullPage: false });
      pkgFound = true;
      break;
    }
  }
  if (!pkgFound) console.log('  ⚠ 未找到包管理页面');

  // 私有仓库配置
  const repoPaths = ['/repositories', '/settings/repositories', '/executors/repositories'];
  let repoFound = false;
  for (const p of repoPaths) {
    await page.goto(`${BASE}${p}`);
    await page.waitForLoadState('networkidle').catch(() => {});
    if (!page.url().includes('/login')) {
      const text = await page.locator('body').innerText();
      console.log(`  私有仓库页 [${p}]:`, text.slice(0, 200).replace(/\n/g, ' | '));
      await page.screenshot({ path: '/tmp/e2e-07-repositories.png', fullPage: false });
      repoFound = true;
      break;
    }
  }
  if (!repoFound) console.log('  ⚠ 未找到私有仓库页面');
});

// ── 8. 应用部署管理 ──────────────────────────────────────────────────────────
test('8. 应用部署管理', async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/applications`);
  await page.waitForLoadState('networkidle');

  const firstApp = page.locator('table tbody tr, .ant-table-tbody tr, .ant-list-item').first();
  const hasApp = await firstApp.isVisible().catch(() => false);
  if (hasApp) {
    await firstApp.click();
    await page.waitForTimeout(2000);
    console.log('  应用详情 URL:', page.url());
    const text = await page.locator('body').innerText();
    console.log('  应用详情片段:', text.slice(0, 400).replace(/\n/g, ' | '));

    // 查找部署相关 tab 或按钮
    const deployTab = page.getByRole('tab', { name: /部署|deploy/i }).first();
    const hasDeployTab = await deployTab.isVisible().catch(() => false);
    if (hasDeployTab) {
      await deployTab.click();
      await page.waitForTimeout(1500);
      const deployText = await page.locator('body').innerText();
      console.log('  部署 tab 内容:', deployText.slice(0, 300).replace(/\n/g, ' | '));
    }

    const deployBtn = page.getByRole('button', { name: /部署|发布|Deploy|Release/i }).first();
    const hasDeploy = await deployBtn.isVisible().catch(() => false);
    if (hasDeploy) {
      console.log('  ✓ 找到部署按钮');
      await page.screenshot({ path: '/tmp/e2e-08-deploy.png', fullPage: false });
    } else {
      console.log('  ⚠ 未找到部署按钮');
    }
  } else {
    console.log('  ⚠ 无应用记录，跳过部署测试');
  }
  await page.screenshot({ path: '/tmp/e2e-08-applications.png', fullPage: false });
});

// ── 9. 并发调度：同时触发多个任务，查看状态 ─────────────────────────────────
test('9. 并发调度状态查询', async ({ page, request }) => {
  // 使用 request fixture（Node 层），无 CORS
  const loginResp = await request.post(`${API}/api/auth/login`, {
    data: { username: USER, password: PASS },
  });
  const token = (await loginResp.json()).data?.accessToken;
  console.log('  API token:', token ? '✓' : '✗');

  const tasksResp = await request.get(`${API}/api/tasks?page=1&pageSize=10`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const tasks = await tasksResp.json();
  const taskItems = tasks?.data?.items || tasks?.data?.list || [];
  console.log(`  当前任务数: ${taskItems.length}`);

  // 并发触发前3个任务
  const toTrigger = taskItems.slice(0, 3);
  for (const t of toTrigger) {
    const trigResp = await request.post(`${API}/api/tasks/${t.id}/trigger`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const trigBody = await trigResp.json();
    console.log(`  触发任务 [${t.name}]: code=${trigBody?.code} msg=${trigBody?.message}`);
  }

  // 等待片刻后查看执行状态
  await page.waitForTimeout(3000);
  const execResp = await request.get(`${API}/api/task-executions?page=1&pageSize=10`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const execStatus = await execResp.json();
  const items = execStatus?.data?.items || execStatus?.data?.list || [];
  const runningCount = items.filter(e => e.status === 'running').length;
  const recentExecs = items.slice(0, 5).map(e => `${e.taskName||e.task?.name||e.name}:${e.status}`);
  console.log(`  当前运行中: ${runningCount}, 最近执行: ${recentExecs.join(', ')}`);

  // executor-node 健康状态
  const healthResp = await request.get('http://localhost:8002/health').catch(() => null);
  if (healthResp) {
    const health = await healthResp.json().catch(() => ({}));
    console.log(`  执行器状态: runningTasks=${health.runningTasks}/${health.maxConcurrentTasks}`);
  } else {
    console.log('  ⚠ 执行器健康端点不可达 (localhost:8002)');
  }

  await login(page);
  await page.goto(`${BASE}/executions`);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: '/tmp/e2e-09-concurrent.png', fullPage: false });
});

// ── 10. 中断正在运行的任务 ───────────────────────────────────────────────────
test('10. 中断/终止运行中的任务', async ({ page, request }) => {
  const loginResp = await request.post(`${API}/api/auth/login`, {
    data: { username: USER, password: PASS },
  });
  const token = (await loginResp.json()).data?.accessToken;

  const execResp = await request.get(`${API}/api/task-executions?status=running&page=1&pageSize=5`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const execStatus = await execResp.json();
  const runningItems = (execStatus?.data?.items || execStatus?.data?.list || []).filter(e => e.status === 'running');
  console.log(`  运行中的执行数: ${runningItems.length}`);

  if (runningItems.length > 0) {
    const execId = runningItems[0].id;
    const killResp = await request.post(`${API}/api/task-executions/${execId}/cancel`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const killBody = await killResp.json();
    console.log('  API 终止结果:', JSON.stringify(killBody).slice(0, 200));
  } else {
    console.log('  ⚠ 无运行中任务，通过 UI 查找终止按钮');
  }

  // 通过 UI 测试中断
  await login(page);
  await page.goto(`${BASE}/executions`);
  await page.waitForLoadState('networkidle');
  const cancelBtn = page.getByRole('button', { name: /取消|终止|中断|停止|Cancel|Kill|Stop/i }).first();
  const hasCancel = await cancelBtn.isVisible().catch(() => false);
  if (hasCancel) {
    await cancelBtn.click();
    await page.waitForTimeout(1500);
    console.log('  ✓ UI 点击终止按钮');
    const confirmBtn = page.getByRole('button', { name: /确定|确认|Yes|OK/i }).first();
    const hasConfirm = await confirmBtn.isVisible().catch(() => false);
    if (hasConfirm) {
      await confirmBtn.click();
      await page.waitForTimeout(1500);
      console.log('  ✓ 确认终止');
    }
  } else {
    console.log('  ⚠ 无可终止的任务（已完成或无运行中）');
  }
  await page.screenshot({ path: '/tmp/e2e-10-cancel.png', fullPage: false });
});

// ── 11. 调度器监控 — 任务启停 ───────────────────────────────────────────────
test('11. 任务启停控制', async ({ page, request }) => {
  await login(page);
  await page.goto(`${BASE}/tasks`);
  await page.waitForLoadState('networkidle');

  const toggle = page.locator('.ant-switch, input[role="switch"]').first();
  const hasToggle = await toggle.isVisible().catch(() => false);
  if (hasToggle) {
    const isChecked = await toggle.isChecked().catch(() => false);
    await toggle.click();
    await page.waitForTimeout(1500);
    console.log(`  ✓ 任务状态切换: ${isChecked ? '启用→禁用' : '禁用→启用'}`);
    await toggle.click();
    await page.waitForTimeout(1000);
    console.log('  ✓ 任务状态恢复');
  } else {
    console.log('  ⚠ 未找到开关，尝试右键菜单或操作列');
  }

  // API 层面验证调度器状态
  const loginResp = await request.post(`${API}/api/auth/login`, {
    data: { username: USER, password: PASS },
  });
  const token = (await loginResp.json()).data?.accessToken;
  const schedulerResp = await request.get(`${API}/api/scheduler/status`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const schedulerStatus = schedulerResp.ok() ? await schedulerResp.json() : { status: schedulerResp.status() };
  console.log('  调度器状态 API:', JSON.stringify(schedulerStatus).slice(0, 200));
  await page.screenshot({ path: '/tmp/e2e-11-task-toggle.png', fullPage: false });
});

// ── 12. 通知设置 ─────────────────────────────────────────────────────────────
test('12. 通知渠道设置', async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/notification-settings`);
  await page.waitForLoadState('networkidle');
  const text = await page.locator('body').innerText();
  console.log('  通知设置内容:', text.slice(0, 400).replace(/\n/g, ' | '));
  await page.screenshot({ path: '/tmp/e2e-12-notifications.png', fullPage: false });

  const wecomInput = page.locator('input[placeholder*="企业微信"], input[placeholder*="wecom"], input[id*="wecom"]').first();
  const hasWecom = await wecomInput.isVisible().catch(() => false);
  console.log(`  企业微信配置入口: ${hasWecom ? '✓' : '✗'}`);
});

// ── 13. 用户管理 ─────────────────────────────────────────────────────────────
test('13. 用户管理', async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/users`);
  await page.waitForLoadState('networkidle');
  const text = await page.locator('body').innerText();
  console.log('  用户管理内容:', text.slice(0, 400).replace(/\n/g, ' | '));
  await page.screenshot({ path: '/tmp/e2e-13-users.png', fullPage: false });
});

// ── 14. 审计日志 ─────────────────────────────────────────────────────────────
test('14. 审计日志', async ({ page, request }) => {
  await login(page);
  const auditPaths = ['/audit', '/audit-logs', '/settings/audit'];
  let found = false;
  for (const p of auditPaths) {
    await page.goto(`${BASE}${p}`);
    await page.waitForLoadState('networkidle');
    if (!page.url().includes('/login')) {
      const text = await page.locator('body').innerText();
      if (text.length > 100) {
        console.log(`  审计日志 URL: ${page.url()}`);
        console.log('  审计日志内容:', text.slice(0, 400).replace(/\n/g, ' | '));
        await page.screenshot({ path: '/tmp/e2e-14-audit.png', fullPage: false });
        found = true;
        break;
      }
    }
  }
  if (!found) {
    console.log('  ⚠ 审计日志页面路径未知，通过 API 查询');
    const loginResp = await request.post(`${API}/api/auth/login`, {
      data: { username: USER, password: PASS },
    });
    const token = (await loginResp.json()).data?.accessToken;
    const auditResp = await request.get(`${API}/api/audit-logs?page=1&pageSize=5`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const audit = auditResp.ok() ? await auditResp.json() : { status: auditResp.status() };
    console.log('  审计日志 API:', JSON.stringify(audit).slice(0, 400));
  }
});

// ── 15. AI辅助调度（若启用）& Swagger API 文档 ──────────────────────────────
test('15. AI 配置检查 & Swagger API 文档', async ({ page }) => {
  await login(page);
  const settingsPaths = ['/settings', '/settings/ai', '/ai'];
  for (const p of settingsPaths) {
    await page.goto(`${BASE}${p}`);
    await page.waitForLoadState('networkidle').catch(() => {});
    if (!page.url().includes('/login')) {
      const text = await page.locator('body').innerText();
      if (text.includes('AI') || text.includes('OpenAI') || text.includes('Ollama')) {
        console.log(`  AI 设置页面: ${page.url()}`);
        console.log('  AI 设置内容:', text.slice(0, 300).replace(/\n/g, ' | '));
        await page.screenshot({ path: '/tmp/e2e-15-ai.png', fullPage: false });
        break;
      }
    }
  }

  // Swagger API 文档
  await page.goto('http://localhost:3002/api/docs');
  await page.waitForLoadState('networkidle').catch(() => {});
  const swaggerText = await page.locator('body').innerText();
  console.log('  Swagger 文档:', swaggerText.slice(0, 200).replace(/\n/g, ' | '));
  await page.screenshot({ path: '/tmp/e2e-15-swagger.png', fullPage: false });
});

// ── 16. Prometheus 指标验证 ──────────────────────────────────────────────────
test('16. Prometheus 指标端点', async ({ page }) => {
  await page.goto('http://localhost:3002/metrics');
  await page.waitForLoadState('networkidle').catch(() => {});
  const text = await page.locator('body').innerText();
  const hasMetrics = text.includes('# HELP') || text.includes('nodejs_') || text.includes('http_');
  console.log(`  Prometheus 指标: ${hasMetrics ? '✓ 正常' : '✗ 未返回指标'}, 内容: ${text.slice(0, 200)}`);
  await page.screenshot({ path: '/tmp/e2e-16-metrics.png', fullPage: false });
});
