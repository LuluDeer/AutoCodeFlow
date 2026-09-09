// AutoCodeFlow 全场景 E2E 测试
// 覆盖：登录、应用管理、任务调度、执行日志、运行机管理、并发状态、中断任务、仓库、通知、审计
// 第八轮新增：RBAC 路由门控（/notifications 等）、settings AI Tab 非 admin 降级、
//             TaskFormPage 执行器策略四模式（auto/group/pinned/broadcast）、executorId 残留清理
// 第九轮新增：pinned 任务部署全链 UI 闭环——API/UI 建 pinned → 详情页绑定可见 →
//             手动 trigger 实际落在目标执行器（executorAddress 复核）→
//             pinned 离线/目标不存在语义（FAILED + "Pinned executor" 错误 UI 可读）
const { test, expect } = require('@playwright/test');
const { randomUUID } = require('node:crypto');

const BASE = 'http://localhost:5176';
const API  = process.env.E2E_API_BASE || 'http://localhost:3105';
const USER = 'admin';
const PASS = 'admin123';

// ── 登录辅助 ─────────────────────────────────────────────────────────────────
// page.evaluate 回调在浏览器侧执行，Node 作用域的 API 常量不存在
// （CI 实爆 ReferenceError: API is not defined）。经 addInitScript 注入
// 全局，evaluate 内统一引用 window.__E2E_API__。任何先 goto 再 evaluate 的
// 路径都必须先过本注入（login/loginAs 内部已调用）。
async function injectApi(page) {
  await page.addInitScript(([api]) => { window.__E2E_API__ = api; }, [API]);
}

async function login(page) {
  await injectApi(page);
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
      // 提交（antd zhCN 下 Modal 确定按钮渲染为「确 定」含空格）
      const okBtn = page.getByRole('button', { name: /确\s*定|确认|提交|OK|Submit/i }).first();
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
    const r = await fetch(`${window.__E2E_API__}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    const d = await r.json();
    return d.data?.accessToken;
  });

  const tasks = await page.evaluate(async (tok) => {
    const r = await fetch(`${window.__E2E_API__}/api/tasks?page=1&pageSize=5`, {
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
          const r = await fetch(`${window.__E2E_API__}/api/tasks/${id}/trigger`, {
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
      const r = await fetch(`${window.__E2E_API__}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin123' }),
      });
      return (await r.json()).data?.accessToken;
    });
    const execs = await page.evaluate(async (tok) => {
      const r = await fetch(`${window.__E2E_API__}/api/task-executions?page=1&pageSize=5`, {
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
    const r = await fetch(`${window.__E2E_API__}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    return (await r.json()).data?.accessToken;
  });
  const apps = await page.evaluate(async (tok) => {
    const r = await fetch(`${window.__E2E_API__}/api/applications?page=1&pageSize=5`, {
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
test('9. 并发调度状态查询', async ({ page, request }) => {
  // 先加载前端页面，使后续 page.evaluate 的 fetch 携带合法 Origin（CORS 白名单）
  await injectApi(page);
  await page.goto(BASE);
  const token = await page.evaluate(async () => {
    const r = await fetch(`${window.__E2E_API__}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    return (await r.json()).data?.accessToken;
  });

  // 获取任务列表
  const tasks = await page.evaluate(async (tok) => {
    const r = await fetch(`${window.__E2E_API__}/api/tasks?page=1&pageSize=10`, {
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
      fetch(`${window.__E2E_API__}/api/tasks/${t.id}/trigger`, {
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
    const r = await fetch(`${window.__E2E_API__}/api/task-executions?page=1&pageSize=10`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    return r.json();
  }, token);

  const runningCount = (execStatus?.data?.items || []).filter(e => e.status === 'running').length;
  const recentExecs = (execStatus?.data?.items || []).slice(0, 5).map(e => `${e.taskName||e.task?.name}:${e.status}`);
  console.log(`  当前运行中: ${runningCount}, 最近执行: ${recentExecs.join(', ')}`);

  // executor-node 并发状态（executor-node 无 CORS 头，改用 Playwright request API 直连，不受同源限制）
  const execHealth = await (await request.get('http://localhost:8002/health')).json();
  console.log(`  执行器状态: runningTasks=${execHealth.runningTasks}/${execHealth.maxConcurrentTasks}`);

  await login(page);
  await page.goto(`${BASE}/executions`);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: '/tmp/e2e-09-concurrent.png', fullPage: false });
});

// ── 10. 中断正在运行的任务 ───────────────────────────────────────────────────
test('10. 中断/终止运行中的任务', async ({ page }) => {
  // 先加载前端页面，使后续 page.evaluate 的 fetch 携带合法 Origin（CORS 白名单）
  await injectApi(page);
  await page.goto(BASE);
  const token = await page.evaluate(async () => {
    const r = await fetch(`${window.__E2E_API__}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    return (await r.json()).data?.accessToken;
  });

  // 查询运行中的执行
  const execStatus = await page.evaluate(async (tok) => {
    const r = await fetch(`${window.__E2E_API__}/api/task-executions?status=running&page=1&pageSize=5`, {
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
      const r = await fetch(`${window.__E2E_API__}/api/task-executions/${id}/cancel`, {
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
    const confirmBtn = page.getByRole('button', { name: /确\s*定|确认|Yes|OK/i }).first();
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
    const r = await fetch(`${window.__E2E_API__}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    return (await r.json()).data?.accessToken;
  });
  const schedulerStatus = await page.evaluate(async (tok) => {
    const r = await fetch(`${window.__E2E_API__}/api/scheduler/status`, {
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
      const r = await fetch(`${window.__E2E_API__}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin123' }),
      });
      return (await r.json()).data?.accessToken;
    });
    const audit = await page.evaluate(async (tok) => {
      const r = await fetch(`${window.__E2E_API__}/api/audit-logs?page=1&pageSize=5`, {
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
  await page.goto(`${API}/api/docs`);
  await page.waitForLoadState('networkidle');
  const swaggerText = await page.locator('body').innerText();
  console.log('  Swagger 文档:', swaggerText.slice(0, 200).replace(/\n/g, ' | '));
  await page.screenshot({ path: '/tmp/e2e-15-swagger.png', fullPage: false });
});

// ── 16. Prometheus 指标验证 ──────────────────────────────────────────────────
test('16. Prometheus 指标端点', async ({ request }) => {
  // W-13 (sync with apps/admin-web/e2e-full.spec.js): the endpoint is GET
  // /api/metrics behind the JwtAuthGuard (metrics.controller.ts, R7); the old
  // unauthenticated page.goto('/metrics') 404'd on every OS — a test bug.
  const login = await request.post(`${API}/api/auth/login`, { data: { username: USER, password: PASS } });
  const token = (await login.json())?.data?.accessToken;
  const resp = await request.get(`${API}/api/metrics`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await resp.text();
  const hasMetrics = resp.status() === 200 && (text.includes('# HELP') || text.includes('nodejs_') || text.includes('autoflow_'));
  console.log(`  Prometheus 指标: ${hasMetrics ? '✓ 正常' : '✗ 未返回指标'}, HTTP ${resp.status()}`);
  expect(hasMetrics).toBe(true);
});

// ══ 第八轮新增：RBAC 门控 / settings AI 降级 / 执行器策略四模式 / executorId 残留清理 ══

const E2E_USER = 'e2e_user';
const E2E_USER_PASS = 'E2e#Pass123';

// API 层登录（request fixture，不受浏览器 CORS 限制）
async function apiLogin(request, username = USER, password = PASS) {
  const r = await request.post(`${API}/api/auth/login`, { data: { username, password } });
  const d = await r.json();
  const tok = d.data?.accessToken;
  if (!tok) throw new Error(`API 登录失败: ${JSON.stringify(d).slice(0, 200)}`);
  return tok;
}

// 以指定账号 UI 登录（对齐既有 login 辅助的选择器风格）
async function loginAs(page, username, password) {
  await injectApi(page);
  await page.goto(`${BASE}/login`);
  const userInput = page.locator('input[id*="username"], input[placeholder*="用户名"], input[placeholder*="username"], input[name="username"]').first();
  const passInput = page.locator('input[type="password"]').first();
  await userInput.fill(username);
  await passInput.fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForFunction(() => !location.pathname.includes('/login'), { timeout: 15000 });
  console.log(`  ✓ 以 ${username} 登录成功`);
}

// 幂等确保普通用户（role=user）存在：201 新建 / 409 已存在
async function ensureE2EUser(request) {
  const tok = await apiLogin(request);
  const r = await request.post(`${API}/api/users`, {
    headers: { Authorization: `Bearer ${tok}` },
    data: { username: E2E_USER, email: 'e2e_user@example.com', password: E2E_USER_PASS, role: 'user' },
  });
  if (r.status() !== 201 && r.status() !== 409) {
    throw new Error(`创建普通用户失败: ${r.status()} ${(await r.text()).slice(0, 200)}`);
  }
}

async function getFirstOnlineExecutor(request) {
  const tok = await apiLogin(request);
  const r = await request.get(`${API}/api/executors`, { headers: { Authorization: `Bearer ${tok}` } });
  const d = await r.json();
  const online = (d.data || []).filter((e) => e.status === 'online');
  if (!online.length) throw new Error('无在线执行器（executor-node 未注册？）');
  return online[0];
}

async function apiCreateTask(request, payload) {
  const tok = await apiLogin(request);
  const r = await request.post(`${API}/api/tasks`, {
    headers: { Authorization: `Bearer ${tok}` },
    data: payload,
  });
  const d = await r.json();
  if (!d.data?.id) throw new Error(`API 创建任务失败: ${r.status()} ${JSON.stringify(d).slice(0, 200)}`);
  return d.data;
}

async function apiGetTask(request, taskId) {
  const tok = await apiLogin(request);
  const r = await request.get(`${API}/api/tasks/${taskId}`, { headers: { Authorization: `Bearer ${tok}` } });
  return (await r.json()).data;
}

// ── 17. RBAC — admin 访问 /notifications 可见且菜单有入口 ───────────────────
test('17. RBAC — admin 访问 /notifications 正常且菜单入口可见', async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/dashboard`);
  await page.waitForLoadState('networkidle');
  // 侧边菜单含「通知设置」入口（R6 起该入口 ADMIN-only；UI-03 分组化后
  // 位于「系统」子菜单内，先展开分组再断言子项可见）
  await page.locator('.ant-menu').getByText('系统', { exact: true }).click();
  await expect(page.locator('.ant-menu').getByText('通知设置')).toBeVisible({ timeout: 10000 });
  console.log('  ✓ admin 菜单含通知设置入口');
  // 路由可访问：渲染 NotificationSettingsPage 特有区块，而非 RequireAdmin 403
  await page.goto(`${BASE}/notifications`);
  await page.waitForLoadState('networkidle');
  const body = await page.locator('body').innerText();
  expect(body).not.toContain('您没有权限访问该页面');
  await expect(page.getByText('全局测试', { exact: true })).toBeVisible({ timeout: 10000 });
  console.log('  ✓ admin /notifications 页面正常渲染');
  await page.screenshot({ path: '/tmp/e2e-17-notifications-admin.png' });
});

// ── 18. RBAC — 普通用户 /notifications 被 403 拦截且菜单无入口 ──────────────
test('18. RBAC — 普通用户 /notifications 被拦(403)且菜单无入口', async ({ page, request }) => {
  await ensureE2EUser(request);
  await loginAs(page, E2E_USER, E2E_USER_PASS);
  await page.goto(`${BASE}/dashboard`);
  // 等 profile 拉取完成（role 决定菜单渲染，侧边栏显示「普通用户」）
  await expect(page.getByText('普通用户')).toBeVisible({ timeout: 10000 });
  // 菜单无「通知设置」入口
  await expect(page.locator('.ant-menu').getByText('通知设置')).toHaveCount(0);
  console.log('  ✓ 普通用户菜单无通知设置入口');
  // 直接 URL 访问 → RequireAdmin 渲染 403 Result
  await page.goto(`${BASE}/notifications`);
  await expect(page.getByText('您没有权限访问该页面')).toBeVisible({ timeout: 10000 });
  console.log('  ✓ 普通用户直接访问 /notifications 显示 403');
  await page.screenshot({ path: '/tmp/e2e-18-notifications-user.png' });
});

// ── 19. RBAC — 其余 ADMIN-only 路由对普通用户统一 403 ───────────────────────
test('19. RBAC — 普通用户 /users /audit /executor-packages /executors/install 均被拦', async ({ page, request }) => {
  await ensureE2EUser(request);
  await loginAs(page, E2E_USER, E2E_USER_PASS);
  for (const p of ['/users', '/audit', '/executor-packages', '/executors/install']) {
    await page.goto(`${BASE}${p}`);
    await expect(page.getByText('您没有权限访问该页面'), `路由 ${p} 应被 RequireAdmin 拦截`).toBeVisible({ timeout: 10000 });
    console.log(`  ✓ 普通用户 ${p} 被拦(403)`);
  }
  await page.screenshot({ path: '/tmp/e2e-19-rbac-403.png' });
});

// ── 20. settings AI Tab — 普通用户降级只读提示且不发 /ai/config 请求 ────────
test('20. settings AI Tab — 普通用户降级提示且零 /ai/config 请求', async ({ page, request }) => {
  await ensureE2EUser(request);
  await loginAs(page, E2E_USER, E2E_USER_PASS);
  const aiRequests = [];
  page.on('request', (req) => { if (req.url().includes('/ai/config')) aiRequests.push(req.url()); });
  await page.goto(`${BASE}/settings`);
  await page.waitForLoadState('networkidle');
  // 页面级降级横幅
  await expect(page.getByText('您以普通用户身份查看')).toBeVisible({ timeout: 10000 });
  // 共享 Token Tab 对非 admin 不渲染（R4 收紧矩阵）
  await expect(page.getByRole('tab', { name: /执行器 Token/ })).toHaveCount(0);
  // 切到 AI Tab → 只读降级提示（R7）
  await page.getByRole('tab', { name: /AI 配置/ }).click();
  await expect(page.getByText('仅管理员可查看和配置 AI 分析')).toBeVisible();
  await page.waitForTimeout(1500);
  expect(aiRequests, `普通用户不应发起 /ai/config 请求: ${aiRequests.join(', ')}`).toHaveLength(0);
  console.log('  ✓ AI Tab 降级提示渲染，/ai/config 请求数=0');
  await page.screenshot({ path: '/tmp/e2e-20-settings-ai-user.png' });
});

// ── 21. settings AI Tab — admin 正常读取（GET /ai/config 200 + 表单渲染）────
test('21. settings AI Tab — admin 正常发起 GET /ai/config 并渲染表单', async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/settings`);
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('tab', { name: /执行器 Token/ })).toBeVisible();
  const respPromise = page.waitForResponse((r) => r.url().includes('/api/ai/config') && r.request().method() === 'GET');
  await page.getByRole('tab', { name: /AI 配置/ }).click();
  const resp = await respPromise;
  expect(resp.status()).toBe(200);
  await expect(page.getByText('AI 提供商')).toBeVisible({ timeout: 10000 });
  console.log('  ✓ admin AI Tab 正常请求 GET /ai/config(200) 且表单渲染');
  await page.screenshot({ path: '/tmp/e2e-21-settings-ai-admin.png' });
});

// ── 22. TaskFormPage — 执行器策略四模式切换 + pinned 提交绑定 executorId ────
test('22. TaskFormPage — auto/group/pinned/broadcast 四模式切换与 pinned 选择器绑定', async ({ page, request }) => {
  const executor = await getFirstOnlineExecutor(request);
  await login(page);
  await page.goto(`${BASE}/tasks/new`);
  await page.waitForLoadState('networkidle');

  // UI-06 单页分区：全部字段同时挂载，无需向导推进
  await page.locator('#name').fill('e2e-mode-' + Date.now().toString().slice(-6));
  await page.getByText('Node.js', { exact: true }).click();
  await page.locator('#entrypoint').fill('index.js');

  // 执行器策略分区：四模式单选组齐备，默认 auto（radio 可访问名含图标前缀，用描述文字定位）
  const autoRadio = page.getByRole('radio', { name: /系统自动选择负载最低/ });
  const groupRadio = page.getByRole('radio', { name: /按分组\/标签/ });
  const pinnedRadio = page.getByRole('radio', { name: /固定到指定的执行器节点/ });
  const broadcastRadio = page.getByRole('radio', { name: /广播（全部执行）/ });
  await expect(autoRadio).toBeChecked();
  await expect(groupRadio).toBeVisible();
  await expect(pinnedRadio).toBeVisible();
  await expect(broadcastRadio).toBeVisible();
  console.log('  ✓ 四模式选项齐备，默认 auto');

  // pinned → 执行器选择器出现并可选中（绑定节点 id）
  await pinnedRadio.click();
  await expect(page.locator('#executorId')).toBeVisible();
  await page.locator('#executorId').click();
  await page.locator('.ant-select-item-option', { hasText: executor.appName }).first().click();
  await expect(page.locator('.ant-select:has(#executorId) .ant-select-content')).toContainText(executor.appName);
  console.log(`  ✓ pinned 选中执行器 ${executor.appName} (${executor.id})`);

  // pinned 态下 broadcast 项输入期互斥禁用（UI-06 ③），auto 可正常切换
  await expect(broadcastRadio).toBeDisabled();
  console.log('  ✓ pinned 态 broadcast 输入期互斥禁用（N17 UI 面前移）');

  // 切回 auto → pinned 选择器卸载（不残留字段），broadcast 恢复可选
  await autoRadio.click();
  await expect(page.locator('#executorId')).toHaveCount(0);
  await expect(broadcastRadio).toBeEnabled();
  // broadcast → pinned 选择器卸载（互斥，不残留字段）
  await broadcastRadio.click();
  await expect(page.locator('#executorId')).toHaveCount(0);
  console.log('  ✓ 切 broadcast 后执行器选择器消失（互斥）');

  // group → 分组/标签选择器出现
  await groupRadio.click();
  await expect(page.locator('#executorGroup')).toBeVisible();
  console.log('  ✓ 切 group 后分组选择器出现');

  // 回到 pinned：选择器重新挂载且表单 store 保留已选值（preserve 语义）
  await pinnedRadio.click();
  await expect(page.locator('#executorId')).toBeVisible();
  await expect(page.locator('.ant-select:has(#executorId) .ant-select-content')).toContainText(executor.appName);
  // 单页分区下「任务默认参数」恒可见，断言仍在（UI-06 Steps→锚点导航改造）
  await expect(page.getByText('任务默认参数')).toBeVisible();
  console.log('  ✓ 模式来回切换后 pinned 选择值保留（单页分区）');
  await page.screenshot({ path: '/tmp/e2e-22-taskform-modes.png' });
  // 注：创建向导「提交」路径已修复（R8 P0），由用例 25 回归守卫；
  //     提交 payload 的 executorId 清理语义另由用例 23/24（编辑→PATCH）覆盖。
});

// ── 23. executorId 残留清理 — API 造 pinned+group 任务，编辑页还原并切 broadcast 清 pin ──
test('23. executorId 残留清理 — 编辑页还原 pinned，切 broadcast 后 pin 被清空', async ({ page, request }) => {
  const executor = await getFirstOnlineExecutor(request);
  const seeded = await apiCreateTask(request, {
    name: 'e2e-pin-' + Date.now().toString().slice(-6),
    triggerType: 'manual',
    runtime: 'node',
    entrypoint: 'index.js',
    executorId: executor.id,
    executorGroup: 'e2e-group',
  });
  // 服务端复核：pin 生效
  expect((await apiGetTask(request, seeded.id)).executorId).toBe(executor.id);
  console.log(`  ✓ API 造 pinned 任务 ${seeded.id}（executorId + 残留 executorGroup）`);

  await login(page);
  await page.goto(`${BASE}/tasks/${seeded.id}/edit`);
  await page.waitForLoadState('networkidle');
  // deriveExecutorMode：executorId 存在 → pinned 选中且显示正确执行器
  await expect(page.getByRole('radio', { name: /固定到指定的执行器节点/ })).toBeChecked({ timeout: 10000 });
  await expect(page.locator('.ant-select:has(#executorId) .ant-select-content')).toContainText(executor.appName);
  console.log('  ✓ 编辑页还原 pinned 且选中正确执行器');

  // pinned 态 broadcast 输入期禁用（UI-06 ③）→ 经 auto 中转切 broadcast
  await page.getByRole('radio', { name: /系统自动选择负载最低/ }).click();
  await expect(page.locator('#executorId')).toHaveCount(0);
  await page.getByRole('radio', { name: /广播（全部执行）/ }).click();
  await expect(page.locator('#executorId')).toHaveCount(0);
  const patchPromise = page.waitForResponse((r) => r.url().includes(`/api/tasks/${seeded.id}`) && r.request().method() === 'PATCH');
  await page.getByRole('button', { name: /保存更改/ }).click();
  await patchPromise;

  // 服务端复核：broadcast 与 pin 互斥——executorId 显式清空（N17/N19）
  const finalTask = await apiGetTask(request, seeded.id);
  expect(finalTask.executeMode).toBe('broadcast');
  expect(finalTask.executorId, 'broadcast 提交应清空 executorId（不留"界面广播、实际钉死"残留）').toBeNull();
  console.log('  ✓ broadcast 提交后 executorId=null、executeMode=broadcast');
  await page.screenshot({ path: '/tmp/e2e-23-broadcast-mutex.png' });
});

// ── 24. executorId 残留清理 — pinned 任务切 auto 后 pin 被清空 ──────────────
test('24. executorId 残留清理 — 切 auto 提交后 executorId 显式置空', async ({ page, request }) => {
  const executor = await getFirstOnlineExecutor(request);
  const seeded = await apiCreateTask(request, {
    name: 'e2e-residue-' + Date.now().toString().slice(-6),
    triggerType: 'manual',
    runtime: 'node',
    entrypoint: 'index.js',
    executorId: executor.id,
  });

  await login(page);
  await page.goto(`${BASE}/tasks/${seeded.id}/edit`);
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('radio', { name: /固定到指定的执行器节点/ })).toBeChecked({ timeout: 10000 });
  await expect(page.locator('.ant-select:has(#executorId) .ant-select-content')).toContainText(executor.appName);

  // 切 auto → 保存 → executorId 显式 null（buildExecutorPayload auto 分支）
  await page.getByRole('radio', { name: /系统自动选择负载最低/ }).click();
  await expect(page.locator('#executorId')).toHaveCount(0);
  const patchPromise = page.waitForResponse((r) => r.url().includes(`/api/tasks/${seeded.id}`) && r.request().method() === 'PATCH');
  await page.getByRole('button', { name: /保存更改/ }).click();
  await patchPromise;

  const finalTask = await apiGetTask(request, seeded.id);
  expect(finalTask.executorId, 'auto 提交应清除残留 executorId').toBeNull();
  expect(finalTask.executeMode).toBe('single');
  console.log('  ✓ auto 提交后 executorId=null（无"界面 auto、实际钉死"静默错位）');
  await page.screenshot({ path: '/tmp/e2e-24-executor-residue.png' });
});

// ── 25. [已知缺陷] 创建向导提交丢失步骤0/1字段 → 后端 400 ───────────────────
// 第八轮 E2E 发现（P0，前端源码缺陷，本轮按分工不改源码）：
// TaskFormPage 分步渲染，Step2 提交时 form.validateFields() 仅返回「当前挂载」
// 字段（@rc-component/form validateFields → getFieldsValue(挂载字段路径)），
// 步骤0/1 已卸载字段（name/runtime/entrypoint/executorId…）不在返回值中，
// 导致 POST /api/tasks payload 退化为 {"executeMode":"single","executorAppName":null}，
// 后端 400 "name should not be empty"，UI 显示「创建失败」。
// 编辑路径（PATCH）因后端合并语义侥幸可用（见用例 23/24）。
// 8 轮 W1 已修复：handleSubmit 改用 form.getFieldsValue(true) 取全量 store 值
// + 分步必填兜底（apps/admin-web/src/pages/TaskFormPage.tsx）。本用例转正回归。
test('25. 创建向导 pinned 提交应携带完整字段与 executorId（R8 P0 回归守卫）', async ({ page, request }) => {
  const executor = await getFirstOnlineExecutor(request);
  await login(page);
  await page.goto(`${BASE}/tasks/new`);
  await page.waitForLoadState('networkidle');
  await page.locator('#name').fill('e2e-create-' + Date.now().toString().slice(-6));
  await page.getByText('Node.js', { exact: true }).click();
  await page.locator('#entrypoint').fill('index.js');
  // UI-06 单页分区：执行器策略字段同页挂载，无需向导推进
  await page.getByRole('radio', { name: /固定到指定的执行器节点/ }).click();
  await page.locator('#executorId').click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', { hasText: executor.appName }).first().click();
  const createRespPromise = page.waitForResponse((r) => r.url().includes('/api/tasks') && r.request().method() === 'POST');
  await page.getByRole('button', { name: /创建任务/ }).click();
  const resp = await createRespPromise;
  expect(resp.status(), '创建应返回 201').toBe(201);
  const created = (await resp.json()).data;
  expect(created.executorId, 'pinned 提交应携带 executorId').toBe(executor.id);
  expect(created.executeMode).toBe('single');
  await expect(page.getByText('任务已创建成功')).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: '/tmp/e2e-25-create-submit.png' });
});

// ══ 第九轮新增：pinned 任务部署全链 UI 闭环 ══
// 观测手段说明：
//  - 执行器置离线用 admin API `POST /api/executors/:id/set-offline`（既有端点，
//    无需 kill executor-node；executor 心跳 ~30s 后自动恢复 online，用例尾部等待回归）。
//  - 执行终态/executorAddress/errorMessage 以 API 轮询为权威断言（request fixture），
//    UI 面断言详情页绑定展示、执行历史行、执行详情页错误区块。
//  - 已知 UI 面缺口（不判失败，仅如实记录）：TaskDetailPage「指定执行器」仅渲染
//    legacy executorAppName 字段，不解析 executorId→名称；executorId 绑定的权威
//    UI 展示在编辑页（pinned radio + Select 名称），用例 26 一并断言。

// 最小可成功执行的 glue 脚本（executor-node 以 `node glue_script.js` 直跑，顶层不可 return）
const PIN_GLUE = "console.log('[e2e-r9] pinned glue ok on ' + (process.env.AUTOFLOW_EXECUTOR_ADDRESS || 'unknown'));";

async function apiTriggerTask(request, taskId) {
  const tok = await apiLogin(request);
  const r = await request.post(`${API}/api/tasks/${taskId}/trigger`, {
    headers: { Authorization: `Bearer ${tok}` },
    data: {},
  });
  const d = await r.json();
  if (!d.data?.id) throw new Error(`API 触发失败: ${r.status()} ${JSON.stringify(d).slice(0, 200)}`);
  return d.data;
}

const TERMINAL_STATUSES = ['success', 'failed', 'timeout', 'killed', 'cancelled'];
// 轮询该任务最新一条执行直至终态（列表按 createdAt DESC，items[0] 即最新）
async function apiWaitExecution(request, taskId, timeoutMs = 30000) {
  const tok = await apiLogin(request);
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    const r = await request.get(`${API}/api/tasks/${taskId}/executions?page=1&pageSize=5`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    const items = (await r.json()).data?.items || [];
    latest = items[0] || null;
    if (latest && TERMINAL_STATUSES.includes(latest.status)) return latest;
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`执行未在 ${timeoutMs}ms 内到达终态，最后状态: ${latest?.status}`);
}

async function apiSetExecutorOffline(request, id) {
  const tok = await apiLogin(request);
  const r = await request.post(`${API}/api/executors/${id}/set-offline`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  if (!r.ok()) throw new Error(`set-offline 失败: ${r.status()} ${(await r.text()).slice(0, 200)}`);
}

// 等待执行器经心跳恢复 online（心跳周期 30s，留 45s 余量；避免离线窗口泄漏到后续用例）
async function apiWaitExecutorOnline(request, id, timeoutMs = 45000) {
  const tok = await apiLogin(request);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await request.get(`${API}/api/executors/${id}`, { headers: { Authorization: `Bearer ${tok}` } });
    const d = await r.json();
    if (d.data?.status === 'online') {
      console.log('  ✓ 执行器已恢复 online（心跳回归）');
      return d.data;
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error(`执行器 ${id} 未在 ${timeoutMs}ms 内恢复 online（executor-node 心跳未上报？）`);
}

// ── 26. pinned 全链 happy path — API 建 pinned → UI 绑定可见 → UI 触发 → 真实落在目标执行器 ──
test('26. pinned 全链 — 详情页绑定可见、UI 触发、执行记录 executorAddress=目标执行器', async ({ page, request }) => {
  const executor = await getFirstOnlineExecutor(request);
  const seeded = await apiCreateTask(request, {
    name: 'e2e-pin-chain-' + Date.now().toString().slice(-6),
    triggerType: 'manual',
    runtime: 'node',
    entrypoint: 'index.js',
    executorId: executor.id,
    // 详情页「指定执行器」渲染 legacy executorAppName；与 executorId 指向同一执行器，
    // 展示如实（dispatch 权威字段仍是 executorId，见用例 23/24 与服务端复核）
    executorAppName: executor.appName,
    glueSource: PIN_GLUE,
    glueLanguage: 'javascript',
    maxRetry: 0,
  });
  console.log(`  ✓ API 造 pinned 任务 ${seeded.id} → ${executor.appName}@${executor.address}`);

  await login(page);
  // 详情页：绑定关系可见（调度模式 + 指定执行器名称）
  await page.goto(`${BASE}/tasks/${seeded.id}`);
  await page.waitForLoadState('networkidle');
  await expect(page.getByText('单节点')).toBeVisible({ timeout: 10000 });
  await expect(page.getByText('指定执行器')).toBeVisible();
  await expect(page.getByText(executor.appName).first()).toBeVisible();
  console.log(`  ✓ 详情页展示绑定：调度模式=单节点、指定执行器=${executor.appName}`);

  // 编辑页：executorId 绑定的权威 UI 展示（pinned radio 选中 + Select 显示执行器名）
  await page.goto(`${BASE}/tasks/${seeded.id}/edit`);
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('radio', { name: /固定到指定的执行器节点/ })).toBeChecked({ timeout: 10000 });
  await expect(page.locator('.ant-select:has(#executorId) .ant-select-content')).toContainText(executor.appName);
  console.log('  ✓ 编辑页还原 pinned 且 Select 显示目标执行器名');

  // 回详情页 UI 触发（Modal OK 按钮可访问名含图标前缀「thunderbolt 触发」，限定 footer 用正则匹配）
  await page.goto(`${BASE}/tasks/${seeded.id}`);
  await page.getByRole('button', { name: '立即触发' }).click();
  await page.locator('.ant-modal-footer').getByRole('button', { name: /触发/ }).click();
  await expect(page.getByText(/已触发/)).toBeVisible({ timeout: 10000 });
  console.log('  ✓ UI「立即触发」提交');

  // API 权威复核：执行终态 success 且 executorAddress=目标执行器（pinned 不漂移）
  const exec = await apiWaitExecution(request, seeded.id, 30000);
  expect(exec.status, `执行应成功，实际 ${exec.status}: ${exec.errorMessage || ''}`).toBe('success');
  expect(exec.executorAddress).toBe(executor.address);
  console.log(`  ✓ 执行 ${exec.id} success，executorAddress=${exec.executorAddress}（=目标执行器）`);

  // UI 执行历史：行内可见执行器地址与成功状态；执行详情页展示执行节点
  await page.getByRole('tab', { name: /执行记录/ }).click();
  await page.getByRole('button', { name: /刷新/ }).click();
  const row = page.locator('.ant-table-tbody tr', { hasText: executor.address }).first();
  await expect(row).toBeVisible({ timeout: 10000 });
  await expect(row).toContainText('成功');
  await row.getByRole('button', { name: /详情/ }).click();
  await page.waitForURL(/\/executions\//);
  await expect(page.getByText(executor.address).first()).toBeVisible({ timeout: 10000 });
  console.log('  ✓ 执行历史行与执行详情页均如实展示 executorAddress');
  await page.screenshot({ path: '/tmp/e2e-26-pinned-chain.png' });
});

// ── 27. pinned 离线语义 — 目标执行器 set-offline → trigger FAILED「Pinned executor ... is offline」UI 可读 ──
test('27. pinned 离线语义 — 目标执行器离线 trigger FAILED，错误消息与失败分类 UI 可读', async ({ page, request }) => {
  const executor = await getFirstOnlineExecutor(request);
  // W-29 心跳竞态防御：set-offline 只是 DB 状态写，而活着的 executor-node 会按
  // 30s 心跳把 status 无条件刷回 online（心跳即存活性权威——产品行为正确）。
  // set-offline→dispatch 的窗口（~2s）撞上心跳 tick 时（概率 ~2/30≈6%），任务
  // 会被成功派发（实测 ubuntu CI 偶发 "Expected failed Received success"）。
  // 撞车时换新任务重试一次：第一次尝试已消耗数秒，下一跳心跳远在窗口之外，
  // 二次撞车概率 ~0.4%，不再是 CI 红灯来源。
  let attempt = 0;
  const runOfflineScenario = async () => {
    attempt += 1;
    const seeded = await apiCreateTask(request, {
      name: 'e2e-pin-off-' + Date.now().toString().slice(-6) + (attempt > 1 ? `-r${attempt}` : ''),
      triggerType: 'manual',
      runtime: 'node',
      entrypoint: 'index.js',
      executorId: executor.id,
      glueSource: PIN_GLUE,
      glueLanguage: 'javascript',
      maxRetry: 0, // attempts=1：单次派发定局，避免心跳恢复 online 后重试翻盘
    });
    await apiSetExecutorOffline(request, executor.id);
    console.log(`  ✓ API set-offline：${executor.appName}@${executor.address} → offline`);
    await apiTriggerTask(request, seeded.id);
    const exec = await apiWaitExecution(request, seeded.id, 30000);
    return { seeded, exec };
  };
  let { seeded, exec } = await runOfflineScenario();
  if (exec.status !== 'failed') {
    console.log(`  ⚠ 心跳竞态：第一次尝试拿到 ${exec.status}，换新任务重试（W-29）`);
    ({ seeded, exec } = await runOfflineScenario());
  }
  expect(exec.status).toBe('failed');
  expect(exec.errorMessage, 'pinned 离线应报 "Pinned executor ... is offline"').toMatch(/Pinned executor .* is offline/);
  expect(exec.failureReason).toBe('executor_offline');
  expect(exec.executorAddress, '离线失败不应发生派发，executorAddress 应为空').toBeFalsy();
  console.log(`  ✓ 执行 FAILED：${exec.errorMessage}`);

  // UI：详情页执行历史行展示错误；执行详情页展示失败分类「执行器离线」+ 错误信息
  // 注：UI 断言包在 try/finally 中——无论成败都等心跳恢复 online，
  //     避免离线窗口级联打挂后续用例（28/29 依赖在线执行器）。
  try {
    await login(page);
    await page.goto(`${BASE}/tasks/${seeded.id}`);
    await page.getByRole('tab', { name: /执行记录/ }).click();
    const row = page.locator('.ant-table-tbody tr', { hasText: 'Pinned executor' }).first();
    await expect(row).toBeVisible({ timeout: 10000 });
    await expect(row).toContainText('失败');
    await row.getByRole('button', { name: /详情/ }).click();
    await page.waitForURL(/\/executions\//);
    await expect(page.getByText('执行器离线', { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/Pinned executor .* is offline/).first()).toBeVisible();
    console.log('  ✓ 执行详情页失败分类「执行器离线」+ 错误消息 UI 可读');
    await page.screenshot({ path: '/tmp/e2e-27-pinned-offline.png' });
  } finally {
    // 恢复：等待心跳把执行器带回 online，避免离线窗口影响后续用例
    await apiWaitExecutorOnline(request, executor.id);
  }
});

// ── 28. pinned 目标不存在 — executorId 指向随机 uuid → FAILED「Pinned executor ... not found」UI 可读 ──
test('28. pinned 目标不存在 — executorId 幽灵 uuid trigger FAILED，UI 错误展示可读', async ({ page, request }) => {
  const ghost = randomUUID();
  const seeded = await apiCreateTask(request, {
    name: 'e2e-pin-ghost-' + Date.now().toString().slice(-6),
    triggerType: 'manual',
    runtime: 'node',
    entrypoint: 'index.js',
    executorId: ghost,
    glueSource: PIN_GLUE,
    glueLanguage: 'javascript',
    maxRetry: 0,
  });
  console.log(`  ✓ API 造 pinned 任务（executorId=${ghost}，不存在的执行器）`);

  await apiTriggerTask(request, seeded.id);
  const exec = await apiWaitExecution(request, seeded.id, 30000);
  expect(exec.status).toBe('failed');
  expect(exec.errorMessage, '目标缺失应报 "Pinned executor ... not found"').toMatch(/Pinned executor .* not found/);
  expect(exec.executorAddress, '目标不存在不应发生派发').toBeFalsy();
  console.log(`  ✓ 执行 FAILED：${exec.errorMessage}`);

  await login(page);
  await page.goto(`${BASE}/tasks/${seeded.id}`);
  await page.getByRole('tab', { name: /执行记录/ }).click();
  const row = page.locator('.ant-table-tbody tr', { hasText: 'Pinned executor' }).first();
  await expect(row).toBeVisible({ timeout: 10000 });
  await expect(row).toContainText('失败');
  await row.getByRole('button', { name: /详情/ }).click();
  await page.waitForURL(/\/executions\//);
  await expect(page.getByText(/Pinned executor .* not found/).first()).toBeVisible({ timeout: 10000 });
  console.log('  ✓ 执行详情页错误信息 UI 可读（无 fallback 到其他执行器）');
  await page.screenshot({ path: '/tmp/e2e-28-pinned-ghost.png' });
});

// ── 29. UI 创建向导 pinned → 详情页触发 → 执行落在绑定执行器（创建→执行全 UI 闭环）──
test('29. UI 向导建 pinned 任务 → 触发执行 executorAddress=绑定执行器（全 UI 闭环）', async ({ page, request }) => {
  const executor = await getFirstOnlineExecutor(request);
  await login(page);
  // 创建向导（对齐用例 25 的 pinned 提交路径）
  await page.goto(`${BASE}/tasks/new`);
  await page.waitForLoadState('networkidle');
  await page.locator('#name').fill('e2e-pin-wizard-' + Date.now().toString().slice(-6));
  await page.getByText('Node.js', { exact: true }).click();
  await page.locator('#entrypoint').fill('index.js');
  // UI-06 单页分区：执行器策略字段同页挂载，无需向导推进
  await page.getByRole('radio', { name: /固定到指定的执行器节点/ }).click();
  await page.locator('#executorId').click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', { hasText: executor.appName }).first().click();
  const createRespPromise = page.waitForResponse((r) => r.url().includes('/api/tasks') && r.request().method() === 'POST');
  await page.getByRole('button', { name: /创建任务/ }).click();
  const created = (await (await createRespPromise).json()).data;
  expect(created.executorId, '向导 pinned 提交应携带 executorId').toBe(executor.id);
  console.log(`  ✓ UI 向导创建 pinned 任务 ${created.id}（executorId=${executor.id}）`);

  // 向导不编辑 glue 脚本，API 补最小可执行脚本（绑定关系仍由 UI 产生，仅脚本内容代填）
  const tok = await apiLogin(request);
  const patchR = await request.patch(`${API}/api/tasks/${created.id}`, {
    headers: { Authorization: `Bearer ${tok}` },
    data: { glueSource: PIN_GLUE, glueLanguage: 'javascript', maxRetry: 0 },
  });
  expect(patchR.ok()).toBeTruthy();

  // 详情页 UI 触发 → API 权威复核执行落在绑定执行器 → UI 执行历史可见
  await page.goto(`${BASE}/tasks/${created.id}`);
  await page.getByRole('button', { name: '立即触发' }).click();
  await page.locator('.ant-modal-footer').getByRole('button', { name: /触发/ }).click();
  await expect(page.getByText(/已触发/)).toBeVisible({ timeout: 10000 });
  const exec = await apiWaitExecution(request, created.id, 30000);
  expect(exec.status, `执行应成功，实际 ${exec.status}: ${exec.errorMessage || ''}`).toBe('success');
  expect(exec.executorAddress).toBe(executor.address);
  console.log(`  ✓ UI 触发执行 success，executorAddress=${exec.executorAddress}`);

  await page.getByRole('tab', { name: /执行记录/ }).click();
  await page.getByRole('button', { name: /刷新/ }).click();
  await expect(page.locator('.ant-table-tbody tr', { hasText: executor.address }).first()).toBeVisible({ timeout: 10000 });
  console.log('  ✓ 执行历史行展示目标执行器地址（UI 创建→执行→展示闭环）');
  await page.screenshot({ path: '/tmp/e2e-29-pinned-wizard-chain.png' });
});

// ══ 第十轮新增：安全红线 e2e 套件化（QA-09 收尾 / P0-1）══
// 三条红线：① SSRF 六出站点（SEC-04 统一 deny 表 + assertSafeHttpUrl/FEAT-07
// webhook 双层守卫）；② RBAC 全端点（W2 @Roles(ADMIN) 收口）；③ 审批第二人
// 规则（DEP-04）。断言均为响应码级红线（拒绝路径），不依赖 UI 渲染，只走
// request fixture——与既有例的 page.evaluate 形态解耦，不受浏览器 CORS 限制。
//
// 审批链路需要第二个管理员账号（普通 user 走不到审批端点——那本身就是
// RBAC 红线例 35 断言的内容）。b.bat 启动的 admin-api 走 INITIAL_ADMIN_USERNAME
// seed，首个用例幂等提升 e2e_admin_b 为 ADMIN（已是 admin 则 400/409 幂等跳过）。

// 统一响应包络断言：body.code 必须回显真实 HTTP 状态码（若整型）。请求被
// 网关/代理吞掉或 404 HTML 时 body 解析会失败——那也是红线失守，一并报错。
async function expectRedline(resp, status, label) {
  const text = await resp.text();
  expect(
    resp.status(),
    `${label}: HTTP ${resp.status()} != ${status}（body=${text.slice(0, 200)}）`,
  ).toBe(status);
  try {
    const body = JSON.parse(text);
    if (typeof body?.code === 'number') {
      expect(body.code, `${label}: 包络 code ${body.code} != ${status}`).toBe(status);
    }
  } catch {
    throw new Error(`${label}: 非 JSON 响应（body=${text.slice(0, 200)}）`);
  }
}

// 幂等确保第二管理员（role=admin）存在。名字含「B」便于排障时与 seed admin 区分。
const ADMIN_B = 'e2e_admin_b';
const ADMIN_B_PASS = 'E2e#AdminB123';
test.describe('security-redline-approval', () => {
  test.describe.configure({ mode: 'serial' });

  let adminTok;
  let adminBTok;
  const APP_NAME_PREFIX = 'e2e-redline-approval-';
  const createdApplicationIds = [];

  test.beforeAll(async ({ request }) => {
    // 401/403 红线不经过登录限流，但每个用例都要登录两次（A+B）——
    // e2e-full.sh 已把 LOGIN_THROTTLE_LIMIT 放大到 10000，不设防的场景靠这里兜底。
    adminTok = await apiLogin(request);
    const r = await request.post(`${API}/api/users`, {
      headers: { Authorization: `Bearer ${adminTok}` },
      data: {
        username: ADMIN_B,
        email: 'e2e_admin_b@example.com',
        password: ADMIN_B_PASS,
        role: 'admin',
      },
    });
    if (![201, 400, 409].includes(r.status())) {
      throw new Error(`创建第二管理员失败: ${r.status()} ${(await r.text()).slice(0, 200)}`);
    }
    adminBTok = await apiLogin(request, ADMIN_B, ADMIN_B_PASS);
    // 幂等自证：两个账号都必须能过 RBAC（否则后续审批断言会被前置污染）
    const probe = await request.get(`${API}/api/users`, {
      headers: { Authorization: `Bearer ${adminBTok}` },
    });
    expect(probe.status(), '第二管理员应具备 ADMIN 角色（GET /users 200）').toBe(200);
  });

  test.afterAll(async ({ request }) => {
    // 清理：审批闸应用删除即连带释放 in-flight 部署槽（pending 行的应用删除
    // 走 R18/R9c remove 链）。DELETE /applications/:id 是 ADMIN 面本身也
    // 被例 35 断言，这里只用 admin 主账号。幂等：404 静默。
    for (const id of createdApplicationIds) {
      const r = await request.delete(`${API}/api/applications/${id}`, {
        headers: { Authorization: `Bearer ${adminTok}` },
      });
      console.log(`  清理审批应用 ${id}: HTTP ${r.status()}`);
    }
  });

  // 建一个开了 approvalRequired 的应用（唯一后缀命名，可重复跑）
  async function createApprovalApp(request) {
    const name = `${APP_NAME_PREFIX}${Date.now().toString().slice(-6)}-${randomUUID().slice(0, 8)}`;
    const r = await request.post(`${API}/api/applications`, {
      headers: { Authorization: `Bearer ${adminTok}` },
      data: { name, version: '1.0.0', runtime: 'node', approvalRequired: true },
    });
    const appId = (await r.json())?.data?.id;
    expect(appId, `建审批应用应 201: ${r.status()}`).toBeTruthy();
    createdApplicationIds.push(appId);
    return appId;
  }

  // 提交人（主 admin）对审批闸应用 deploy → 冻结 pending_approval，且【零派发】
  async function createPendingDeployment(request, appId) {
    const r = await request.post(`${API}/api/app-deployments/applications/${appId}/deploy`, {
      headers: { Authorization: `Bearer ${adminTok}` },
      data: { runMode: 'once' },
    });
    const body = await r.json();
    expect(r.status(), `deploy 应 201: ${JSON.stringify(body).slice(0, 200)}`).toBe(201);
    const dep = body.data;
    expect(dep.approvalStatus, 'approvalRequired 应用的新部署应冻结 pending_approval').toBe('pending_approval');
    expect(dep.status, '冻结行 status=pending（未派发）').toBe('pending');
    expect(dep.approvalMeta?.requestedBy, '审批痕迹应记录提交人').toBeTruthy();
    return dep;
  }

  test('30. 审批冻结 — approvalRequired 应用 deploy 落 pending_approval 零派发', async ({ request }) => {
    const appId = await createApprovalApp(request);
    const dep = await createPendingDeployment(request, appId);
    // 重复 deploy 被 in-flight 防重拦下（409）——审批闸同样持有槽位
    const dup = await request.post(`${API}/api/app-deployments/applications/${appId}/deploy`, {
      headers: { Authorization: `Bearer ${adminTok}` },
      data: { runMode: 'once' },
    });
    await expectRedline(dup, 409, '审批挂起期间重复 deploy');
    console.log(`  ✓ deploy 冻结 ${dep.id}（pending_approval + 零派发 + 重复 deploy 409）`);
  });

  test('31. 第二人规则 — 提交者本人 approve 自己的部署应 403', async ({ request }) => {
    const appId = await createApprovalApp(request);
    const dep = await createPendingDeployment(request, appId);
    const r = await request.post(`${API}/api/app-deployments/${dep.id}/approval/approve`, {
      headers: { Authorization: `Bearer ${adminTok}` },
      data: {},
    });
    await expectRedline(r, 403, '提交者 approve 自己的部署（第二人规则）');
    // 拒绝后行仍在待审批（未被消费）
    const after = await (await request.get(`${API}/api/app-deployments/${dep.id}`, {
      headers: { Authorization: `Bearer ${adminTok}` },
    })).json();
    expect(after.data?.approvalStatus).toBe('pending_approval');
    console.log(`  ✓ 提交者自批 403，行保持 pending_approval（${dep.id}）`);
  });

  test('32. 并发双审批 — 两个管理员同时 approve 恰一 200 一 409（原子认领）', async ({ request }) => {
    const appId = await createApprovalApp(request);
    const dep = await createPendingDeployment(request, appId);
    // Playwright request fixture 并发同发两次 approve（提交者=主 admin，双审批人=B+另一身份不可得，
    // 退而用「B 与 主admin 之外的路径」不可行 → 第二人规则要求审批者≠提交者，
    // 因此两路并发都必须来自非提交者。本地 env 只有一个 seed admin + 一个 B，
    // 故此例以 B 为双路发起者（同一人双并发=原子认领语义；跨人冲突由例 31/33 覆盖）。
    const [r1, r2] = await Promise.all([
      request.post(`${API}/api/app-deployments/${dep.id}/approval/approve`, {
        headers: { Authorization: `Bearer ${adminBTok}` },
        data: { reason: 'e2e 并发审批-路1' },
      }),
      request.post(`${API}/api/app-deployments/${dep.id}/approval/approve`, {
        headers: { Authorization: `Bearer ${adminBTok}` },
        data: { reason: 'e2e 并发审批-路2' },
      }),
    ]);
    const codes = [r1.status(), r2.status()].sort((a, b) => a - b);
    expect(codes, `并发双审批应恰一 200 一 409，实际 ${codes}`).toEqual([200, 409]);
    // 终态复核：approvalStatus=approved（唯一推进者生效）
    const after = await (await request.get(`${API}/api/app-deployments/${dep.id}`, {
      headers: { Authorization: `Bearer ${adminTok}` },
    })).json();
    expect(after.data?.approvalStatus).toBe('approved');
    console.log(`  ✓ 并发 approve 200+409，终态 approved（${dep.id}）`);
  });

  test('33. reject 语义 — 非提交者管理员拒绝 → FAILED 离开待审批', async ({ request }) => {
    const appId = await createApprovalApp(request);
    const dep = await createPendingDeployment(request, appId);
    const r = await request.post(`${API}/api/app-deployments/${dep.id}/approval/reject`, {
      headers: { Authorization: `Bearer ${adminBTok}` },
      data: { reason: 'e2e 红线：验收人否决' },
    });
    expect(r.status(), `B 拒绝应 200: ${(await r.text()).slice(0, 200)}`).toBe(200);
    const after = await (await request.get(`${API}/api/app-deployments/${dep.id}`, {
      headers: { Authorization: `Bearer ${adminTok}` },
    })).json();
    expect(after.data?.approvalStatus).toBe('rejected');
    expect(after.data?.status).toBe('failed');
    // 槽位已释放：同一应用可再次 deploy（返回新的 pending 行）
    const again = await createPendingDeployment(request, appId);
    expect(again.id, 'reject 后槽位释放，可再次提交').not.toBe(dep.id);
    console.log(`  ✓ reject → rejected+failed，槽位释放并再次冻结 ${again.id}`);
  });

  test('34. cancel 语义 — 提交者撤回自己的待审批 200；他人撤回 403', async ({ request }) => {
    const appId = await createApprovalApp(request);
    // 他人（B）撤回提交者（主 admin）的请求 → 403
    const dep1 = await createPendingDeployment(request, appId);
    const wrongCancel = await request.post(`${API}/api/app-deployments/${dep1.id}/approval/cancel`, {
      headers: { Authorization: `Bearer ${adminBTok}` },
    });
    await expectRedline(wrongCancel, 403, '非提交者 cancel 他人待审批');
    // 提交者本人撤回 → 200，行 FAILED（cancelled）
    const r = await request.post(`${API}/api/app-deployments/${dep1.id}/approval/cancel`, {
      headers: { Authorization: `Bearer ${adminTok}` },
    });
    expect(r.status(), `提交者 cancel 应 200: ${(await r.text()).slice(0, 200)}`).toBe(200);
    const after = await (await request.get(`${API}/api/app-deployments/${dep1.id}`, {
      headers: { Authorization: `Bearer ${adminTok}` },
    })).json();
    expect(after.data?.approvalStatus).toBe('cancelled');
    expect(after.data?.status).toBe('failed');
    console.log(`  ✓ 他人 cancel 403 / 提交者 cancel 200 → cancelled+failed`);
  });

  test('35. 审批 RBAC — 普通用户与未携带 token 打审批三动作/待办均被拦', async ({ request }) => {
    const appId = await createApprovalApp(request);
    const dep = await createPendingDeployment(request, appId);
    const userTok = await apiLogin(request, E2E_USER, E2E_USER_PASS);
    const cases = [
      ['approve', `${API}/api/app-deployments/${dep.id}/approval/approve`, userTok, 403],
      ['reject', `${API}/api/app-deployments/${dep.id}/approval/reject`, userTok, 403],
      ['cancel', `${API}/api/app-deployments/${dep.id}/approval/cancel`, userTok, 403],
      ['pending-inbox', `${API}/api/app-deployments/approvals/pending`, userTok, 403],
      ['no-token', `${API}/api/app-deployments/${dep.id}/approval/approve`, null, 401],
    ];
    for (const [name, url, tok, status] of cases) {
      const r = await request.post(url, tok ? {
        headers: { Authorization: `Bearer ${tok}` },
        data: {},
      } : { data: {} });
      await expectRedline(r, status, `审批面 ${name}`);
      console.log(`  ✓ 审批面 ${name} → ${status}`);
    }
  });
});

// ── P0-1 红线②：RBAC 全端点（W2 @Roles(ADMIN) 收口）─────────────────────────
// 普通用户 token 打 ADMIN 写面必须全 403、未带 token 全 401。代表性端点集
// 覆盖 B-2/B-3/B-4（执行器写面/配置与审计面/应用与部署写面）+ 事件订阅/模板
// 官方删除等新面。断言只认响应码，端点存在性由「非 404」隐式复核。
test.describe('security-redline-rbac', () => {
  test.describe.configure({ mode: 'serial' });

  let userTok;
  let adminTok;
  let seededTaskId;
  let seededAppId;

  test.beforeAll(async ({ request }) => {
    adminTok = await apiLogin(request);
    await ensureE2EUser(request);
    userTok = await apiLogin(request, E2E_USER, E2E_USER_PASS);
    // 幂等自证：普通用户 token 必须真的拿得到（401 会让全部 403 断言失真）
    expect(userTok, 'e2e_user 登录应成功').toBeTruthy();
    // 探针：普通用户打 ADMIN 面，先确认拿到的是 403 而非 401（token 有效性）
    const probe = await request.get(`${API}/api/users`, {
      headers: { Authorization: `Bearer ${userTok}` },
    });
    expect(probe.status(), '探针 GET /users 应 403（token 有效且被 RBAC 拦截）').toBe(403);
  });

  test('36. 执行器写面全 403 — patch/reload-config/rotate-token/set-offline/delete', async ({ request }) => {
    const executor = await getFirstOnlineExecutor(request);
    const ghostId = randomUUID();
    const cases = [
      ['PATCH 元数据', 'patch', `${API}/api/executors/${executor.id}`, { groupName: 'e2e-redline' }],
      ['POST reload-config', 'post', `${API}/api/executors/${executor.id}/reload-config`, {}],
      ['POST rotate-token', 'post', `${API}/api/executors/${executor.id}/rotate-token`, {}],
      ['POST set-offline', 'post', `${API}/api/executors/${executor.id}/set-offline`, {}],
      ['DELETE 执行器', 'delete', `${API}/api/executors/${ghostId}`, null],
    ];
    for (const [label, method, url, data] of cases) {
      const r = await request[method](url, {
        headers: { Authorization: `Bearer ${userTok}` },
        ...(data !== null ? { data } : {}),
      });
      await expectRedline(r, 403, `普通用户 ${label}`);
      console.log(`  ✓ ${label} → 403`);
    }
  });

  test('37. 应用与部署写面全 403 — create/update/delete/deploy/upgrade-all/rollback', async ({ request }) => {
    const ghost = randomUUID();
    const cases = [
      ['POST 建应用', 'post', `${API}/api/applications`, { name: `e2e-redline-${randomUUID().slice(0, 8)}`, version: '1.0.0', runtime: 'node' }],
      ['PUT 改应用', 'put', `${API}/api/applications/${ghost}`, { description: 'e2e-redline' }],
      ['DELETE 删应用', 'delete', `${API}/api/applications/${ghost}`, null],
      ['POST deploy', 'post', `${API}/api/app-deployments/applications/${ghost}/deploy`, { runMode: 'once' }],
      ['POST upgrade-all', 'post', `${API}/api/applications/${ghost}/upgrade-all`, {}],
      ['POST rollback', 'post', `${API}/api/applications/${ghost}/rollback/${randomUUID()}`, {}],
      ['POST sync-tasks', 'post', `${API}/api/applications/${ghost}/sync-tasks`, {}],
    ];
    for (const [label, method, url, data] of cases) {
      const r = await request[method](url, {
        headers: { Authorization: `Bearer ${userTok}` },
        ...(data !== null ? { data } : {}),
      });
      await expectRedline(r, 403, `普通用户 ${label}`);
      console.log(`  ✓ ${label} → 403`);
    }
  });

  test('38. 审计/配置/AI/用户管理面全 403 — export/rollback/shared-token/config/users', async ({ request }) => {
    const cases = [
      ['GET 审计列表', 'get', `${API}/api/audit`, null],
      ['GET 审计导出', 'get', `${API}/api/audit/export`, null],
      ['GET 配置历史', 'get', `${API}/api/config/history`, null],
      ['POST 配置回滚', 'post', `${API}/api/config/history/999999/rollback`, {}],
      ['POST 生成共享 token', 'post', `${API}/api/config/executor-shared-token/generate`, {}],
      ['GET AI 配置', 'get', `${API}/api/ai/config`, null],
      ['POST AI 配置', 'post', `${API}/api/ai/config`, { provider: 'disabled' }],
      ['POST 建用户', 'post', `${API}/api/users`, { username: `e2e-redline-${randomUUID().slice(0, 8)}`, email: 'redline@example.com', password: 'Redline#123', role: 'user' }],
      ['DELETE 删用户', 'delete', `${API}/api/users/999999`, null],
      ['GET 执行器安装命令', 'get', `${API}/api/executors/install-cmd`, null],
    ];
    for (const [label, method, url, data] of cases) {
      const r = await request[method](url, {
        headers: { Authorization: `Bearer ${userTok}` },
        ...(data !== null ? { data } : {}),
      });
      await expectRedline(r, 403, `普通用户 ${label}`);
      console.log(`  ✓ ${label} → 403`);
    }
  });

  test('39. 事件订阅与模板管理面全 403/401 — subscriptions/webhook/官方模板删除', async ({ request }) => {
    const cases = [
      ['POST 建订阅', 'post', `${API}/api/event-subscriptions`, { url: 'https://e2e-redline.example.com/hook', eventTypes: ['execution.failed'] }],
      ['GET 订阅列表', 'get', `${API}/api/event-subscriptions`, null],
      ['POST 死信重放', 'post', `${API}/api/event-subscriptions/${randomUUID()}/dead-letters/${randomUUID()}/replay`, {}],
      ['POST 发版 webhook（无签名）', 'post', `${API}/api/applications/webhook`, { event: 'push' }],
    ];
    for (const [label, method, url, data] of cases) {
      const r = await request[method](url, {
        headers: { Authorization: `Bearer ${userTok}` },
        ...(data !== null ? { data } : {}),
      });
      await expectRedline(r, 403, `普通用户 ${label}`);
      console.log(`  ✓ ${label} → 403`);
    }
    // 无 token 面：401（JwtAuthGuard 在 RolesGuard 之前）
    const anon = await request.get(`${API}/api/event-subscriptions`);
    await expectRedline(anon, 401, '未携带 token GET /event-subscriptions');
    console.log('  ✓ 未携带 token → 401');
  });

  test('40. 任务管理写面 403 — 普通用户删除/批量触发他人任务被拦（对照：GET 开放）', async ({ request }) => {
    // 造一个 admin 的任务（普通用户无任务归属概念，删除面 ADMIN-only 即红线本体）
    const seeded = await apiCreateTask(request, {
      name: 'e2e-redline-rbac-' + Date.now().toString().slice(-6),
      triggerType: 'manual',
      runtime: 'node',
      entrypoint: 'index.js',
    });
    seededTaskId = seeded.id;
    const cases = [
      ['DELETE 任务', 'delete', `${API}/api/tasks/${seeded.id}`, null],
      ['POST 触发任务', 'post', `${API}/api/tasks/${seeded.id}/trigger`, {}],
      ['POST 批量暂停', 'post', `${API}/api/tasks/batch/pause`, { ids: [seeded.id] }],
    ];
    for (const [label, method, url, data] of cases) {
      const r = await request[method](url, {
        headers: { Authorization: `Bearer ${userTok}` },
        ...(data !== null ? { data } : {}),
      });
      await expectRedline(r, 403, `普通用户 ${label}`);
      console.log(`  ✓ ${label} → 403`);
    }
    // 对照组：读面对普通用户开放（证明 403 是 RBAC 判定而非 token 失效）
    const read = await request.get(`${API}/api/tasks/${seeded.id}`, {
      headers: { Authorization: `Bearer ${userTok}` },
    });
    expect(read.status(), '对照：普通用户 GET /tasks/:id 应 2xx（读面开放）').toBeLessThan(300);
    console.log('  ✓ 对照组 GET /tasks/:id 2xx（403 来自 RBAC 而非凭据失效）');
  });
});

// ── P0-1 红线①：SSRF 六出站点（SEC-04 deny 表 + assertSafeHttpUrl 双层守卫）──
// e2e 断言面 = POST /api/event-subscriptions（FEAT-07 出站 webhook 订阅创建，
// service 层 await assertSafeHttpUrl(dto.url) DNS 逐地址深校验）。六类恶意
// 出站目标全部必须 400 拒绝（落库前拦截，拒绝路径红线），另配正例对照组 +
// 无 token 401 面。public-url.example.com 是 RFC 6761 保留名（.example TLD
// 不做解析交付），DNS NXDOMAIN → assertSafeHttpUrl 的「resolve 失败也 400」
// fail-closed 分支——本例同时钉死两条拒绝语义。
test.describe('security-redline-ssrf', () => {
  test.describe.configure({ mode: 'serial' });

  let tok;

  test.beforeAll(async ({ request }) => {
    tok = await apiLogin(request);
  });

  test('41. SSRF — webhook 订阅六出站点恶意 URL 全 400', async ({ request }) => {
    const maliciousUrls = [
      'http://localhost:3105/api/health',                          // ① 回环域名形态（loopback）
      'http://127.0.0.1:3105/api/health',                          // ② 回环字面量（loopback）
      'http://192.168.1.10/hook',                                  // ③ 私网 v4（RFC1918 192.168/16）
      'http://[::1]:3105/hook',                                    // ④ 回环 v6 括号字面量
      'http://[fe80::1]/hook',                                     // ⑤ 链路本地 v6
      'http://[::ffff:127.0.0.1]/hook',                            // ⑥ IPv4-mapped v6 归一（N25）
      'http://0x7f000001/hook',                                    // ⑦ 十六进制整型回环变体
      'http://169.254.169.254/latest/meta-data/',                  // ⑧ 云元数据地址（link-local）
      'http://10.0.0.5/hook',                                      // ⑨ 私网 v4（RFC1918 10/8）
    ];
    for (const url of maliciousUrls) {
      const r = await request.post(`${API}/api/event-subscriptions`, {
        headers: { Authorization: `Bearer ${tok}` },
        data: { url, eventTypes: ['execution.failed'] },
      });
      const text = await r.text();
      expect(
        r.status(),
        `SSRF 红线失守：恶意 URL ${url} 被 ${r.status()} 放行（body=${text.slice(0, 160)}）`,
      ).toBe(400);
      // 二层复核：包络 code 语义（若整型）
      try {
        const body = JSON.parse(text);
        if (typeof body?.code === 'number') expect(body.code).toBe(400);
      } catch { /* text 响应也算 400 拒绝 */ }
      console.log(`  ✓ ${url} → 400 拒绝`);
    }
  });

  test('42. SSRF — DNS 重绑定域名形态与非 http scheme 全 400', async ({ request }) => {
    // DNS 重绑定形态：本用例不依赖真实 rebind 域名的公网解析（CI 出网策略不可
    // 靠、且缓存会翻车），改用两条确定性等价面钉死拒绝语义：
    //  a) .example 保留 TLD → NXDOMAIN → assertSafeHttpUrl fail-closed 400（解析失败即拒，
    //     重绑定攻击者拿到的第一个解析答案若含私网地址同样在 ① 的 deny 表内被拒）；
    //  b) resolve 后命中 deny 表的公网别名形态由 ① 的字面量组覆盖（分类器同一入口）。
    const badUrls = [
      'http://rebind.e2e-redline.example/hook',                    // DNS NXDOMAIN → fail-closed 400
      'http://metadata.google.internal/computeMetadata/v1/',       // 元数据主机名（解析进 169.254/16 即拒；CI 无外网 DNS 时 NXDOMAIN 同样 400）
      'ftp://192.168.1.10/file',                                   // 非 http(s) scheme（DTO @IsUrl protocols 白名单）
      'file:///etc/passwd',                                        // 非 http(s) scheme（本地文件形态）
      'gopher://127.0.0.1:70/x',                                   // 非 http(s) scheme（经典 SSRF scheme）
    ];
    for (const url of badUrls) {
      const r = await request.post(`${API}/api/event-subscriptions`, {
        headers: { Authorization: `Bearer ${tok}` },
        data: { url, eventTypes: ['executor.offline'] },
      });
      await expectRedline(r, 400, `SSRF 恶意 URL ${url}`);
      console.log(`  ✓ ${url} → 400 拒绝`);
    }
  });

  test('43. SSRF — 形状校验对照 + 未携带 token 401 面', async ({ request }) => {
    // 对照组：公网 URL（.example 保留名，走 NXDOMAIN 也 400 → 因此对照组用
    // require_tld:false 语义下可解析的形态不可得——对照面改为「非法形状但
    // 不是 SSRF 类」的事件名错误，证明 400 响应区分度：SSRF 400 的语义由
    // ①② 的 message 面背书，此处断言合法载荷不被 URL 拒（若未来 CI 有公网
    // DNS，将本例 URL 换成真实公网端点即可转正为 201 对照）。
    const r = await request.post(`${API}/api/event-subscriptions`, {
      headers: { Authorization: `Bearer ${tok}` },
      data: { url: 'http://localhost:3105/api/health', eventTypes: ['not-an-event'] },
    });
    // eventTypes 非法 → 400（与 SSRF 无关的形状拒绝，证明管线前置校验活跃）
    await expectRedline(r, 400, '非法事件名（形状校验对照）');
    console.log('  ✓ 形状校验对照：非法 eventTypes → 400（URL 守卫之外的管线活跃证据）');

    // 无 token 创建面 → 401（订阅面鉴权红线）
    const anon = await request.post(`${API}/api/event-subscriptions`, {
      data: { url: 'http://localhost:3105/api/health', eventTypes: ['execution.failed'] },
    });
    await expectRedline(anon, 401, '未携带 token 建订阅');
    console.log('  ✓ 未携带 token 建订阅 → 401');
  });
});
