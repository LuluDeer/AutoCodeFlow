/**
 * B2 效率升级真机取证（离线 stub + vite dev，真浏览器渲染）。
 *
 * 覆盖用户路径：
 *   ① 列自定义：任务列表恢复一个缺省收起列 → 刷新后仍保留（localStorage 信封持久化）；
 *   ② 保存视图：设搜索 + 状态口径保存为命名视图 → 回到裸 /tasks 后切换该视图，
 *      实际下发的列表请求携带对应 q / status 参数；
 *   ③ 批量操作（执行侧，客户端顺序编排）：多选两条在途执行 → 批量终止，
 *      一条成功一条失败 → 部分失败 toast 如实报告（不伪造整体成功）；
 *   ④ CommandPalette：Ctrl+K 唤起 → 输入关键词 → ↑↓ + Enter 键盘导航到目标页面。
 *
 * 离线口径（同 onboarding-guide.spec.ts 范式）：
 *   · storageState 种子 localStorage：autoflow-lang=zh、autoflow-auth（token 非空过
 *     PrivateRoute，role=admin 过 RequireAdmin）；
 *   · context.route 仅拦截同源 /api/ 前缀（pathname 前缀匹配，不误截 /src/api/ 源码）；
 *     非 API 静态资源直通。
 *
 * 取证边界（如实标注）：dev server + stub 响应，未连真实后端；批量终止的失败项由
 * stub 对 exec-2 返回 500 构造，部分失败语义在 execution-batch 单测与本套件双重覆盖；
 * 任务侧专用批量端点（/api/tasks/batch/*）的逐项失败契约由既有任务列表单测守护，本套件
 * 不重复造写路径。产物：test-results/b2-efficiency/<case>.png + 同名 .json 审计记录。
 */
import { test as base, expect, type Route } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const OUT =
  process.env.B2_OUT || path.join(process.cwd(), 'test-results', 'b2-efficiency');

const STUB_PROFILE = { id: 1, username: 'admin', role: 'admin', totpEnabled: false };

const TASK_ROWS = [
  {
    id: 'task-1', name: '备份任务A', runtime: 'python', entrypoint: 'src/main.py',
    status: 'active', triggerType: 'cron', cronExpression: '0 2 * * *',
    maxRetry: 3, timeout: 300, priority: 2,
    createdAt: '2026-09-01T08:00:00Z', updatedAt: '2026-09-07T08:00:00Z',
  },
  {
    id: 'task-2', name: '备份任务B', runtime: 'node', entrypoint: 'job.js',
    status: 'paused', triggerType: 'manual', cronExpression: '',
    maxRetry: 1, timeout: 120, priority: 1,
    createdAt: '2026-09-02T08:00:00Z', updatedAt: '2026-09-06T08:00:00Z',
  },
];

const EXEC_ROWS = [
  {
    id: 'exec-1', taskId: 'task-1', taskName: '终止成功目标', status: 'running',
    triggerType: 'cron', executorAddress: '10.0.0.1:3002', executorId: 'aaaa1111-2222-3333-4444-555566667777',
    startTime: '2026-09-07T10:00:00Z', endTime: null, duration: null,
    params: null, createdAt: '2026-09-07T10:00:00Z',
  },
  {
    id: 'exec-2', taskId: 'task-1', taskName: '终止失败目标', status: 'running',
    triggerType: 'cron', executorAddress: '10.0.0.2:3002', executorId: 'bbbb8888-9999-0000-1111-222233334444',
    startTime: '2026-09-07T10:01:00Z', endTime: null, duration: null,
    params: null, createdAt: '2026-09-07T10:01:00Z',
  },
  {
    id: 'exec-3', taskId: 'task-2', taskName: '排队未选目标', status: 'waiting',
    triggerType: 'manual', executorAddress: '10.0.0.3:3002', executorId: 'cccc9999-1111-2222-3333-444455556666',
    startTime: '2026-09-07T10:02:00Z', endTime: null, duration: null,
    params: null, createdAt: '2026-09-07T10:02:00Z',
  },
];

function stubData(pathname: string): unknown {
  if (pathname === '/api/auth/profile') return STUB_PROFILE;
  if (pathname === '/api/auth/oidc/status') return { enabled: false };
  if (pathname === '/api/metrics/summary') {
    return { totalTasks: 2, todayRuns: 1, totalExecutors: 1, onlineExecutors: 1,
      executions: { total: 3, success: 0, failed: 0, running: 2 }, successRate: 0, avgDurationMs: 0 };
  }
  if (['/api/metrics/trend', '/api/metrics/executors', '/api/metrics/failures'].includes(pathname)) return [];
  if (pathname === '/api/metrics/scheduler') {
    return { counters: {}, derived: {}, queue: {}, scheduler: { healthy: true, isLeader: true }, instance: { pid: 0, hostname: 'stub' } };
  }
  if (pathname === '/api/tasks/scheduler/stats') return { healthy: true, isLeader: true };
  if (pathname === '/api/tasks') return { items: TASK_ROWS, total: 2, page: 1, pageSize: 20 };
  if (pathname === '/api/tasks/executions/all') return { items: EXEC_ROWS, total: 3, page: 1, pageSize: 20 };
  if (pathname === '/api/agent/inbox/counts') {
    return { pendingApprovals: 0, waitingSessions: 0, stalled: 0, backlogged: 0,
      backlogTruncated: false, deployments: 0, queueStall: 0, failedSessions: 0,
      failedWindowHours: 24, degraded: false };
  }
  if (pathname === '/api/agent/approvals/pending') return { items: [], total: 0, sessionTotal: 0, returned: 0, truncated: false, degraded: false };
  if (pathname === '/api/agent/telemetry/status') return { consent: false };
  if (['/api/projects', '/api/applications', '/api/api-keys', '/api/executor-packages',
    '/api/notification/channels', '/api/notification/silences', '/api/config',
    '/api/mutex-groups', '/api/executors', '/api/executors/groups', '/api/executors/tags',
    '/api/auth/sessions', '/api/sop/assignable-executors', '/api/registry/npm/packages',
  ].includes(pathname)) return [];
  if (pathname === '/api/executors/picker') return { items: [], total: 0 };
  if (pathname === '/api/executors/runtime-config') return {};
  if (pathname === '/api/ai/config') return {};
  if (pathname === '/api/ai/providers') return { providers: [] };
  return { items: [], total: 0, data: [] };
}

interface B2Stubs {
  errors: string[];
  taskRequests: string[];
  killRequests: string[];
}

const test = base.extend<{ b2: B2Stubs }>({
  b2: [async ({ context }, use) => {
    const state: B2Stubs = { errors: [], taskRequests: [], killRequests: [] };
    context.on('pageerror', (err) => state.errors.push(err.message));
    // 仅拦截同源 /api/ 前缀；不能用 '**/api/**' 通配——它会命中源码路径
    // /src/api/**（如 queryClient.ts），把源码模块回成 JSON 封套，MIME 校验失败致 root 空渲染。
    await context.route((url) => url.pathname.startsWith('/api/'), async (route: Route) => {
      const req = route.request();
      const { pathname } = new URL(req.url());
      if (req.method() === 'OPTIONS') {
        return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
      }
      if (req.method() === 'GET' && pathname === '/api/tasks') {
        state.taskRequests.push(req.url());
      }
      // 执行侧无批量 kill 端点：逐条单条 kill。exec-2 构造 500，验证部分失败逐项报告。
      const killMatch = pathname.match(/^\/api\/tasks\/[^/]+\/executions\/([^/]+)\/kill$/);
      if (req.method() === 'POST' && pathname.includes('/kill')) {
        state.killRequests.push(`${req.method()} ${pathname}`);
      }
      if (killMatch) {
        if (killMatch[1] === 'exec-2') {
          return route.fulfill({
            status: 500,
            headers: { 'access-control-allow-origin': '*' },
            json: { code: 500, message: 'boom: executor unreachable' },
          });
        }
        return route.fulfill({
          status: 200,
          headers: { 'access-control-allow-origin': '*' },
          json: { code: 200, message: 'success', data: { success: true, message: 'killed' } },
        });
      }
      return route.fulfill({
        status: 200,
        headers: { 'access-control-allow-origin': '*' },
        json: { code: 200, message: 'success', data: stubData(pathname) },
      });
    });
    await use(state);
  }, { auto: true }],
});

function seedInitScript() {
  return `(() => {
    try {
      localStorage.setItem('autoflow-lang', 'zh');
      localStorage.setItem('autoflow-auth', JSON.stringify({ state: {
        token: 'stub-access', refreshToken: 'stub-refresh',
        user: { id: 1, username: 'admin', role: 'admin', totpEnabled: false },
      }, version: 0 }));
    } catch (e) {}
  })();`;
}

async function settle(page: import('@playwright/test').Page) {
  await page.waitForTimeout(900);
}

async function recordShot(page: import('@playwright/test').Page, caseKey: string, stubs: B2Stubs, extra: Record<string, unknown> = {}) {
  fs.mkdirSync(OUT, { recursive: true });
  const shotPath = path.join(OUT, `${caseKey}.png`);
  await page.screenshot({ path: shotPath, fullPage: true });
  const fatal = stubs.errors.filter((e) => !e.includes('favicon') && !e.includes('401') && !e.includes('403'));
  const boundaryHit = await page.evaluate(() => !!document.querySelector('.ant-result-status-error'));
  if (boundaryHit) fatal.push('render error boundary shown (.ant-result-status-error)');
  const record = { case: caseKey, url: page.url(), fatalErrors: fatal, screenshot: shotPath, ...extra };
  fs.writeFileSync(path.join(OUT, `${caseKey}.json`), JSON.stringify(record, null, 2));
  expect(fatal, `fatal page errors on ${caseKey}`).toEqual([]);
}

test.describe('B2 效率升级取证', () => {
  test('① 列自定义：恢复「调度」列，刷新后仍保留（信封持久化）', async ({ page, b2 }) => {
    await page.context().addInitScript(seedInitScript());
    await page.goto('/tasks');
    await settle(page);
    await expect(page.getByText('备份任务A')).toBeVisible();

    // 缺省收起：调度表头不可见。打开列设置弹层。
    const headersBefore = await page.locator('.ant-table thead th').allTextContents();
    expect(headersBefore.join('|')).not.toContain('调度');

    await page.getByTestId('tasklist-column-settings').click();
    const scheduleCheckbox = page.getByRole('checkbox', { name: '调度' });
    await expect(scheduleCheckbox).toBeVisible();
    await scheduleCheckbox.click();
    await expect(page.getByRole('columnheader', { name: '调度' })).toBeVisible();

    // 信封落盘：隐藏集合剔除 schedule（其余缺省收起列仍在）。
    const stored = await page.evaluate(() => localStorage.getItem('autoflow-tasklist-columns:v1'));
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    expect(parsed.version).toBe(1);
    expect((parsed.data.hidden as string[]).sort()).toEqual(['priority', 'runtime', 'trigger']);

    // 刷新：偏好从 localStorage 恢复，调度列仍可见。
    await page.reload();
    await settle(page);
    await expect(page.getByText('备份任务A')).toBeVisible();
    await expect(page.getByRole('columnheader', { name: '调度' })).toBeVisible();
    await recordShot(page, '01-columns-persist', b2, { storedEnvelope: parsed });
  });

  test('② 保存视图：切换已保存视图后，列表请求实际携带对应筛选参数', async ({ page, b2 }) => {
    await page.context().addInitScript(seedInitScript());
    await page.goto('/tasks');
    await settle(page);
    await expect(page.getByText('备份任务A')).toBeVisible();
    b2.taskRequests.length = 0;

    // 设搜索词 + 状态口径。
    await page.getByPlaceholder('搜索任务名、描述').fill('备份');
    await page.locator('.ant-select', { hasText: '全部状态' }).first().click();
    await page.locator('.ant-select-item-option', { hasText: '已暂停' }).click();
    await page.waitForTimeout(500);

    // 保存为命名视图。
    await page.getByRole('button', { name: '保存视图' }).click();
    const nameInput = page.getByPlaceholder('视图名称');
    await expect(nameInput).toBeVisible();
    await nameInput.fill('暂停备份');
    await nameInput.press('Enter');
    await expect(page.getByRole('button', { name: '重命名' })).toBeVisible();

    // 回到裸 /tasks（清空口径），首屏请求不带 q/status。
    await page.goto('/tasks');
    await settle(page);
    b2.taskRequests.length = 0;
    await page.waitForTimeout(400);
    const bareUrls = b2.taskRequests.map((u) => new URL(u).search);
    expect(bareUrls.join('&')).not.toContain('status=paused');

    // 切换已保存视图（视图工具条 Select 有专属 testid，避开头部项目切换器与筛选 Select）。
    await page.getByTestId('saved-views-select').click();
    await page.locator('.ant-select-item-option', { hasText: '暂停备份' }).click();
    await page.waitForTimeout(600);

    const applied = b2.taskRequests.map((u) => new URL(u));
    const last = applied[applied.length - 1];
    expect(last.searchParams.get('status')).toBe('paused');
    expect(last.searchParams.get('q')).toBe('备份');
    await recordShot(page, '02-saved-view-applied', b2, { lastRequest: last.search });
  });

  test('③ 批量终止：一条成功一条失败，部分失败如实报告（不伪造整体成功）', async ({ page, b2 }) => {
    await page.context().addInitScript(seedInitScript());
    await page.goto('/executions');
    await settle(page);
    await expect(page.getByText('终止成功目标')).toBeVisible();

    // 按任务名精确定位行（exec-1 成功 / exec-2 失败；exec-3 排队不选）。
    // 不用行序号：固定右列会克隆选择框，全局序号会错位到第三行。
    const successRow = page.locator('.ant-table-tbody tr', { hasText: '终止成功目标' });
    const failRow = page.locator('.ant-table-tbody tr', { hasText: '终止失败目标' });
    await successRow.getByRole('checkbox', { name: '选择行' }).check();
    await failRow.getByRole('checkbox', { name: '选择行' }).check();

    const batchBtn = page.getByRole('button', { name: '批量终止' });
    await expect(batchBtn).toBeVisible();
    await batchBtn.click();
    await page.locator('.ant-popconfirm-buttons .ant-btn-dangerous').click();
    await page.waitForTimeout(1500);
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, '03-kill-requests.json'), JSON.stringify(b2.killRequests, null, 2));

    // 部分失败 toast：1 成功 1 失败，带失败原因。
    await expect(page.locator('.ant-message')).toContainText('1 条失败', { timeout: 10_000 });
    await expect(page.locator('.ant-message')).toContainText('boom');
    await recordShot(page, '03-batch-kill-partial', b2, { killRequests: b2.killRequests });
  });

  test('④ CommandPalette：Ctrl+K 唤起，键盘 ↑↓ + Enter 导航到执行记录页', async ({ page, b2 }) => {
    await page.context().addInitScript(seedInitScript());
    await page.goto('/tasks');
    await settle(page);

    // 注：headless Chromium 会把 Ctrl+K 预留为地址栏快捷键，页面监听器收不到物理按键；
    // 这里向 window 派发等价的合成 KeyboardEvent（ctrlKey + key=k），走的仍是
    // MainLayout 注册的同一条全局 keydown 监听分支（与物理 Ctrl+K 同一代码路径）。
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    });
    const combo = page.getByRole('combobox', { name: '搜索页面、任务、执行记录、执行器、应用' });
    await expect(combo).toBeVisible();
    await combo.fill('执行记录');
    await page.waitForTimeout(300);

    const options = page.locator('[role=option]');
    expect(await options.count()).toBeGreaterThan(0);
    // 置顶静态动作（新建任务 / 创建应用）不参与过滤，排在页项之前；按目标项在
    // 扁平列表中的下标用 ↓ 移动到「执行记录」，再 Enter 触发跳转。
    const optionTexts = await options.allTextContents();
    const targetIdx = optionTexts.findIndex((t) => t.includes('执行记录'));
    expect(targetIdx).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < targetIdx; i += 1) {
      await page.keyboard.press('ArrowDown');
    }
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/executions$/);
    await recordShot(page, '04-palette-navigate', b2);
  });
});
