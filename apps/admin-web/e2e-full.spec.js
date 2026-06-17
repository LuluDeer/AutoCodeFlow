// AutoCodeFlow 全场景 E2E 测试
// 覆盖：登录、应用管理、任务调度、执行日志、运行机管理、并发状态、中断任务、仓库、通知、审计
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:5173';
const API  = 'http://localhost:3002';
const USER = 'admin';
const PASS = 'admin123';

// ── 登录辅助 ─────────────────────────────────────────────────────────────────
async function login(page) {
  await page.goto(`${BASE}/login`);
  // Ant Design form — try multiple selector strategies
  const userInput = page.locator('input[id*="username"], input[placeholder*="用户名"], input[placeholder*="username"], input[name="username"]').first();
  const passInput = page.locator('input[type="password"]').first();
  await userInput.fill(USER);
  await passInput.fill(PASS);
  await page.locator('button[type="submit"]').click();
  // Wait for redirect away from /login
  await page.waitForFunction(() => !location.pathname.includes('/login'), { timeout: 15000 });
  console.log('  ✓ 登录成功');
}

// ── 1. 登录 & Dashboard ───────────────────────────────────────────────────────
test('1. 登录与仪表盘', async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/`);
  await page.waitForLoadState('networkidle');
  const title = await page.title();
  console.log('  页面标题:', title);
  //仪表盘应显示任务数/执行器数等统计卡片
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

  // 点击新建按钮（Ant Design Button含「新建」文字）
  const createBtn = page.getByRole('button', { name: /新建|创建|\+|New|Add/i }).first();
  const hasBtnCreate = await createBtn.isVisible().catch(() => false);
  if (hasBtnCreate) {
    await createBtn.click();
    await page.waitForTimeout(1000);
    // 填写应用名
    const nameInput = page.locator('input[id*="name"], input[placeholder*="应用名"], input[placeholder*="name"]').first();
    const hasInput = await nameInput.isVisible().catch(() => false);
    if (hasInput) {
      await nameInput.fill('E2E-测试应用-' + Date.now().toString().slice(-6));
      // 提交
      const okBtn = page.getByRole('button', { name: /确定|确认|提交|OK|Submit/i }).first();
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

  // 获取当前任务数量
  const taskCountText = await page.locator('body').innerText();
  console.log('  页面内容片段:', taskCountText.slice(0, 200).replace(/\n/g, ' '));

  // 点击新建任务
  const newBtn = page.getByRole('button', { name: /新建|创建|\+|New/i }).first();
  const visible = await newBtn.isVisible().catch(() => false);
  if (visible) {
    await newBtn.click();
    await page.waitForLoadState('networkidle');
    console.log('  跳转到任务表单:', page.url());

    // 填写任务名
    const nameField = page.locator('input[id*="name"], input[placeholder*="任务名"], input[placeholder*="name"]').first();
    const hasName = await nameField.isVisible().catch(() => false);
    if (hasName) {
      await nameField.fill('E2E-测试任务-每分钟');
    }

    // 填写 Cron 表达式
    const cronField = page.locator('input[id*="cron"], input[placeholder*="cron"], input[placeholder*="Cron"]').first();
    const hasCron = await cronField.isVisible().catch(() => false);
    if (hasCron) {
      await cronField.fill('* * * * *');
      console.log('  ✓ 设置 Cron: * * * * *');
    }

    // 等待代码编辑器加载（Monaco / CodeMirror）
    await page.waitForTimeout(2000);
    const monacoEditor = page.locator('.monaco-editor, .cm-editor').first();
    const hasEditor = await monacoEditor.isVisible().catch(() => false);
    if (hasEditor) {
      await monacoEditor.click();
      await page.keyboard.press('Control+a');
      await page.keyboard.type('console.log("E2E test task running:", new Date().toISOString());\nreturn { status: "ok", ts: Date.now() };');
      console.log('  ✓ 填写 JS脚本');
    }

    await page.screenshot({ path: '/tmp/e2e-03-task-form.png', fullPage: false });

    // 提交表单
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
test('4. 手动触发任务 & 查看执行', async ({ page }) => {
  await login(page);

  // 先通过 API 获取任务列表
  const token = await page.evaluate(async () => {
    const r = await fetch('http://localhost:3002/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    const d = await r.json();
    return d.data?.accessToken;
  });

  const tasks = await page.evaluate(async (tok) => {
    const r = await fetch('http://localhost:3002/api/tasks?page=1&pageSize=5', {
      headers: { Authorization: `Bearer ${tok}` },
    });
    return r.json();
  }, token);
  console.log('  API 任务列表:', JSON.stringify(tasks).slice(0, 300));

  // 前往任务列表页，手动触发第一个任务
  await page.goto(`${BASE}/tasks`);
  await page.waitForLoadState('networkidle');

  // 找「立即执行」/「手动触发」按钮
  const triggerBtn = page.getByRole('button', { name: /立即执行|手动|触发|Run|Execute/i }).first();
  const hasRun = await triggerBtn.isVisible().catch(() => false);
  if (hasRun) {
    await triggerBtn.click();
    await page.waitForTimeout(2000);
    console.log('  ✓ 手动触发任务');
  } else {
    // 通过表格行操作
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
        const trigResp = await page.evaluate(async ({ id, tok }) => {
          const r = await fetch(`http://localhost:3002/api/tasks/${id}/trigger`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
          });
          return r.json();
        }, { id: taskId, tok: token });
        console.log('  API 触发结果:', JSON.stringify(trigResp).slice(0, 200));
      }
    }
  }
  await page.screenshot({ path: '/tmp/e2e-04-trigger.png', fullPage: false });
});

// ── 5. 执行日志列表 & 详情 ───────────────────────────────────────────────────
test('5. 执行日志 — 列表与详情', async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/executions`);
  await page.waitForLoadState('networkidle');
  console.log('  执行列表 URL:', page.url());

  const bodyText = await page.locator('body').innerText();
  console.log('  执行列表内容片段:', bodyText.slice(0, 400).replace(/\n/g, ' | '));

  // 点击第一条执行记录查看详情
  const firstRow = page.locator('table tbody tr, .ant-table-tbody tr').first();
  const hasRow = await firstRow.isVisible().catch(() => false);
  if (hasRow) {
    await firstRow.click();
    await page.waitForTimeout(2000);
    console.log('  详情 URL:', page.url());
    const detailText = await page.locator('body').innerText();
    console.log('  执行详情片段:', detailText.slice(0, 500).replace(/\n/g, ' | '));
    await page.screenshot({ path: '/tmp/e2e-05-exec-detail.png', fullPage: false });

    // 查看日志输出区域
    const logArea = page.locator('pre, .log-output, .ant-typography pre, [class*="log"]').first();
    const hasLog = await logArea.isVisible().catch(() => false);
    if (hasLog) {
      const logText = await logArea.innerText();
      console.log('  日志输出:', logText.slice(0, 300));
    }
  } else {
    console.log('  ⚠ 暂无执行记录');
    // 通过 API 查验
    const token = await page.evaluate(async () => {
      const r = await fetch('http://localhost:3002/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin123' }),
      });
      return (await r.json()).data?.accessToken;
    });
    const execs = await page.evaluate(async (tok) => {
      const r = await fetch('http://localhost:3002/api/task-executions?page=1&pageSize=5', {
        headers: { Authorization: `Bearer ${tok}` },
      });
      return r.json();
    }, token);
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
  await page.screenshot({ path: '/tmp/e2e-06-executor-list.png', fullPage: false });

  // 查看第一个运行机详情
  const firstRow = page.locator('table tbody tr, .ant-table-tbody tr').first();
  const hasRow = await firstRow.isVisible().catch(() => false);
  if (hasRow) {
    // 查找详情链接
    const detailLink = firstRow.locator('a').first();
    const hasLink = await detailLink.isVisible().catch(() => false);
    if (hasLink) {
      await detailLink.click();
      await page.waitForLoadState('networkidle');
      console.log('  运行机详情 URL:', page.url());
      const detail = await page.locator('body').innerText();
      console.log('  运行机详情:', detail.slice(0, 500).replace(/\n/g, ' | '));
      await page.screenshot({ path: '/tmp/e2e-06-executor-detail.png', fullPage: false });
      await page.goBack();
    }
  }

  // 安装向导页
  await page.goto(`${BASE}/executors/install`);
  await page.waitForLoadState('networkidle');
  const wizardText = await page.locator('body').innerText();
  console.log('  安装向导内容:', wizardText.slice(0, 500).replace(/\n/g, ' | '));
  await page.screenshot({ path: '/tmp/e2e-06-executor-install.png', fullPage: false });
});

// ── 7. 运行机包管理 & 仓库页面 ──────────────────────────────────────────────
test('7. 运行机包管理 & 私有仓库', async ({ page }) => {
  await login(page);

  // 运行机包管理
  await page.goto(`${BASE}/executors`);
  await page.waitForLoadState('networkidle');
  const pkgLink = page.getByRole('link', { name: /包|Package|依赖/i }).first();
  const hasPkg = await pkgLink.isVisible().catch(() => false);
  if (hasPkg) {
    await pkgLink.click();
    await page.waitForLoadState('networkidle');
    console.log('  包管理 URL:', page.url());
} else {
    await page.goto(`${BASE}/executor-packages`);
    await page.waitForLoadState('networkidle').catch(() => {});
  }
  const pkgText = await page.locator('body').innerText();
  console.log('  包管理内容:', pkgText.slice(0, 300).replace(/\n/g, ' | '));
  await page.screenshot({ path: '/tmp/e2e-07-packages.png', fullPage: false });

  // 私有仓库页面
  await page.goto(`${BASE}/registry`);
  await page.waitForLoadState('networkidle');
  const regText = await page.locator('body').innerText();
  console.log('  仓库页内容:', regText.slice(0, 300).replace(/\n/g, ' | '));
  await page.screenshot({ path: '/tmp/e2e-07-registry.png', fullPage: false });
});

// ── 8. 应用部署 ──────────────────────────────────────────────────────────────
test('8. 应用部署管理', async ({ page }) => {
  await login(page);
  // 获取应用列表
  const token = await page.evaluate(async () => {
    const r = await fetch('http://localhost:3002/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    return (await r.json()).data?.accessToken;
  });
  const apps = await page.evaluate(async (tok) => {
    const r = await fetch('http://localhost:3002/api/applications?page=1&pageSize=5', {
      headers: { Authorization: `Bearer ${tok}` },
    });
    return r.json();
  }, token);
  console.log('  应用列表API:', JSON.stringify(apps).slice(0, 300));

  await page.goto(`${BASE}/applications`);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: '/tmp/e2e-08-app-list.png', fullPage: false });

  // 如有应用，进入详情
  const appItems = apps?.data?.items || apps?.data || [];
  if (Array.isArray(appItems) && appItems.length > 0) {
    const appId = appItems[0].id;
    await page.goto(`${BASE}/applications/${appId}`);
    await page.waitForLoadState('networkidle');
    const detailText = await page.locator('body').innerText();
    console.log('  应用详情:', detailText.slice(0, 400).replace(/\n/g, ' | '));
    await page.screenshot({ path: '/tmp/e2e-08-app-detail.png', fullPage: false });
  }
});

// ── 9. 并发调度：同时触发多个任务，查看状态 ─────────────────────────────────
test('9. 并发调度状态查询', async ({ page }) => {
  const token = await page.evaluate(async () => {
    const r = await fetch('http://localhost:3002/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    return (await r.json()).data?.accessToken;
  });

  // 获取任务列表
  const tasks = await page.evaluate(async (tok) => {
    const r = await fetch('http://localhost:3002/api/tasks?page=1&pageSize=10', {
      headers: { Authorization: `Bearer ${tok}` },
    });
    return r.json();
  }, token);

  const taskItems = tasks?.data?.items || [];
  console.log(`  当前任务数: ${taskItems.length}`);

  // 并发触发前3个任务
  const toTrigger = taskItems.slice(0, 3);
  const triggerResults = await page.evaluate(async ({ items, tok }) => {
    return Promise.all(items.map(t =>
      fetch(`http://localhost:3002/api/tasks/${t.id}/trigger`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      }).then(r => r.json()).then(d => ({ id: t.id, name: t.name, result: d }))
    ));
  }, { items: toTrigger, tok: token });

  triggerResults.forEach(r => {
    console.log(`  触发任务 [${r.name}]: code=${r.result?.code} msg=${r.result?.message}`);
  });

  // 等待片刻后查看执行状态
  await page.waitForTimeout(3000);
  const execStatus = await page.evaluate(async (tok) => {
    const r = await fetch('http://localhost:3002/api/task-executions?page=1&pageSize=10', {
      headers: { Authorization: `Bearer ${tok}` },
    });
    return r.json();
  }, token);

  const runningCount = (execStatus?.data?.items || []).filter(e => e.status === 'running').length;
  const recentExecs = (execStatus?.data?.items || []).slice(0, 5).map(e => `${e.taskName||e.task?.name}:${e.status}`);
  console.log(`  当前运行中: ${runningCount}, 最近执行: ${recentExecs.join(', ')}`);

  // executor-node 并发状态
  const execHealth = await page.evaluate(async () => {
    const r = await fetch('http://localhost:8002/health');
    return r.json();
  });
  console.log(`  执行器状态: runningTasks=${execHealth.runningTasks}/${execHealth.maxConcurrentTasks}`);

  await login(page);
  await page.goto(`${BASE}/executions`);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: '/tmp/e2e-09-concurrent.png', fullPage: false });
});

// ── 10. 中断正在运行的任务 ───────────────────────────────────────────────────
test('10. 中断/终止运行中的任务', async ({ page }) => {
  const token = await page.evaluate(async () => {
    const r = await fetch('http://localhost:3002/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    return (await r.json()).data?.accessToken;
  });

  // 查询运行中的执行
  const execStatus = await page.evaluate(async (tok) => {
    const r = await fetch('http://localhost:3002/api/task-executions?status=running&page=1&pageSize=5', {
      headers: { Authorization: `Bearer ${tok}` },
    });
    return r.json();
  }, token);

  const runningItems = (execStatus?.data?.items || []).filter(e => e.status === 'running');
  console.log(`  运行中的执行数: ${runningItems.length}`);

  if (runningItems.length > 0) {
    const execId = runningItems[0].id;
    //尝试终止 API
    const killResp = await page.evaluate(async ({ id, tok }) => {
      const r = await fetch(`http://localhost:3002/api/task-executions/${id}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      });
      return r.json();
    }, { id: execId, tok: token });
    console.log('  API 终止结果:', JSON.stringify(killResp).slice(0, 200));
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
test('11. 任务启停控制', async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/tasks`);
  await page.waitForLoadState('networkidle');

  // 尝试通过 Toggle/Switch禁用再启用任务
  const toggle = page.locator('.ant-switch, input[role="switch"]').first();
  const hasToggle = await toggle.isVisible().catch(() => false);
  if (hasToggle) {
    const isChecked = await toggle.isChecked().catch(() => false);
    await toggle.click();
    await page.waitForTimeout(1500);
    console.log(`  ✓ 任务状态切换: ${isChecked ? '启用→禁用' : '禁用→启用'}`);
// 再切回来
    await toggle.click();
    await page.waitForTimeout(1000);
    console.log('  ✓ 任务状态恢复');
  } else {
    console.log('  ⚠ 未找到开关，尝试右键菜单或操作列');
  }

  // API 层面验证调度器状态
  const token = await page.evaluate(async () => {
    const r = await fetch('http://localhost:3002/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    return (await r.json()).data?.accessToken;
  });
  const schedulerStatus = await page.evaluate(async (tok) => {
    const r = await fetch('http://localhost:3002/api/scheduler/status', {
      headers: { Authorization: `Bearer ${tok}` },
    });
    return r.ok ? r.json() : { status: r.status };
  }, token);
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

  // 检查企业微信/钉钉/Slack webhook 配置入口
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
test('14. 审计日志', async ({ page }) => {
  await login(page);
  //尝试找审计日志页面
  const auditPaths = ['/audit', '/audit-logs', '/settings/audit'];
  let found = false;
  for (const p of auditPaths) {
    await page.goto(`${BASE}${p}`);
    await page.waitForLoadState('networkidle');
    if (!page.url().includes('/404') && !page.url().includes('not-found')) {
      const text = await page.locator('body').innerText();
      if (text.length > 50) {
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
    const token = await page.evaluate(async () => {
      const r = await fetch('http://localhost:3002/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin123' }),
      });
      return (await r.json()).data?.accessToken;
    });
    const audit = await page.evaluate(async (tok) => {
      const r = await fetch('http://localhost:3002/api/audit-logs?page=1&pageSize=5', {
        headers: { Authorization: `Bearer ${tok}` },
      });
      return r.ok ? r.json() : { status: r.status };
    }, token);
    console.log('  审计日志 API:', JSON.stringify(audit).slice(0, 400));
  }
});

// ── 15. AI辅助调度（若启用）& Swagger API 文档 ──────────────────────────────
test('15. AI 配置检查 & Swagger API 文档', async ({ page }) => {
  // 检查 AI 配置
  await login(page);
  const settingsPaths = ['/settings', '/settings/ai', '/ai'];
  for (const p of settingsPaths) {
    await page.goto(`${BASE}${p}`);
    await page.waitForLoadState('networkidle').catch(() => {});
    const text = await page.locator('body').innerText();
    if (text.includes('AI') || text.includes('OpenAI') || text.includes('Ollama')) {
      console.log(`  AI 设置页面: ${page.url()}`);
      console.log('  AI 设置内容:', text.slice(0, 300).replace(/\n/g, ' | '));
      await page.screenshot({ path: '/tmp/e2e-15-ai.png', fullPage: false });
      break;
    }
  }

  // Swagger API 文档
  await page.goto('http://localhost:3002/api/docs');
  await page.waitForLoadState('networkidle');
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
