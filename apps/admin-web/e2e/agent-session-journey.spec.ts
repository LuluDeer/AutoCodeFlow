import { createHash } from 'node:crypto';
import { test as base, expect, type Route } from '@playwright/test';
import type { AgentApproval, AgentSession, AgentStep } from '../src/api/agent';

const AT = '2026-10-12T08:30:00.000Z';
const ACCESS = 'journey-offline-access';
const LIST = '/api/agent/sessions';
const CHAT_ID = 'a190c45c-14c8-4756-a28c-4ca674a8d7a9';
const QUESTION = '昨天的日报为什么晚了十分钟？请用一句话说明。';
const CONCLUSION = '日报在等待上游归档，归档完成后已正常送达。';
const LIST_TITLE = '已结束的归档故障';
const SHARED_TITLE = '夜班任务变更';

function session(id: string, title: string | null, status: string, fields: Partial<AgentSession> = {}): AgentSession {
  return {
    id, title, status, kind: 'incident', createdBy: 'system:event', triggerSource: 'system:event',
    parentSessionId: null, contextJson: null, scopeJson: {}, budgetJson: null, resultJson: null,
    summary: null, errorMessage: null, totalSteps: 0, totalTokensIn: 0, totalTokensOut: 0,
    totalToolCalls: 0, waitingFor: null, createdAt: AT, startedAt: AT, updatedAt: AT, finishedAt: null,
    ...fields,
  };
}

const archived = session('f95ca46b-1ce1-49a5-84f9-a15271645eb0', LIST_TITLE, 'failed', { finishedAt: AT });
const first = session('c7bfce9b-1c52-4954-9757-3b330c086f5c', SHARED_TITLE, 'waiting_input');
const second = session('1fc134d6-5223-4b92-b199-82a8f138daa7', SHARED_TITLE, 'waiting_input');
const stalled = session('b557ac53-212f-41c5-b0ca-b8d401ef3a15', '卡住的指标采集', 'running');
// 新对话永不出现在列表；只在创建成功后通过其 UUID 返回结果。
const listed = [archived, first, second, stalled];
const chat = session(CHAT_ID, null, 'succeeded', {
  kind: 'chat', createdBy: 'user:值班员', triggerSource: 'user:值班员', finishedAt: AT,
  contextJson: { question: QUESTION }, summary: '已定位日报延迟原因。', resultJson: { conclusion: CONCLUSION },
  totalSteps: 1, totalTokensIn: 36, totalTokensOut: 18,
});
const answerStep: AgentStep = {
  id: '225b67f5-9fa0-405e-a08a-f2cb7b55fa11', sessionId: CHAT_ID, seq: 1, role: 'assistant',
  content: CONCLUSION, summary: null, reasoning: null, toolCallsJson: null, toolCallId: null,
  tokensIn: chat.totalTokensIn, tokensOut: chat.totalTokensOut, latencyMs: 120, provider: 'fixture', model: 'demo', createdAt: AT,
};

function approval(owner: AgentSession, id: string, reason: string, taskId: string) {
  const args = JSON.stringify({ taskId });
  const digest = (s: string) => createHash('sha256').update(s).digest('hex');
  return {
    id, sessionId: owner.id, reason, toolName: 'pause_task', status: 'pending',
    approvalKey: `apr-${owner.id}-${digest(`pause_task|${args}`).slice(0, 16)}`,
    argsDigest: digest(args), preview: JSON.stringify({ truncated: false, args }),
    decidedBy: null, decidedAt: null, consumedAt: null, createdAt: AT,
  } satisfies AgentApproval & { preview: string; argsDigest: string };
}

const OTHER_TASK = '0a73b18a-bfbb-4bd6-aee8-6c0a8546d2f8';
const SIBLING_TASK = '2cf1556e-c550-455a-bdc9-25482053bd36';
const TARGET_TASK = '2cb06097-8d57-4c8a-bd83-de61ab980b23';
const target = approval(second, 'fe2653ea-1a06-4f62-8195-c4c5c1c8edfb', '请核对东区日报', TARGET_TASK);
const approvals = [
  approval(first, '66ed3e52-2286-47a7-9d2f-b8fcb7e133d8', '请核对西区日报', OTHER_TASK),
  approval(second, 'bc57c089-b35e-4415-b1cd-e6d1c4e0553f', '请核对东区周报', SIBLING_TASK),
  target,
];

function reply(route: Route, data: unknown, status = 200) {
  return route.fulfill({ status, headers: { 'access-control-allow-origin': '*' },
    json: { code: status, message: 'success', data } });
}

type Role = 'admin' | 'user';
type Traffic = { creates: unknown[]; agentRequests: string[] };
const test = base.extend<{ accountRole: Role; api: Traffic }>({
  accountRole: ['admin', { option: true }],
  // Playwright 每例一个 BrowserContext，sessionStorage 自然为空。只在新上下文建种子；
  // 刷新不重复写 storage，以便真实验证 profile 补齐、路由及详情的冷启动。
  storageState: async ({ baseURL }, provide) => {
    await provide({ cookies: [], origins: [{ origin: new URL(baseURL!).origin, localStorage: [
      { name: 'autoflow-lang', value: 'zh' },
      { name: 'autoflow-auth', value: JSON.stringify({
        state: { token: ACCESS, refreshToken: 'journey-offline-refresh', user: null }, version: 0,
      }) },
    ] }] });
  },
  api: [async ({ context, baseURL, accountRole }, use) => {
    const origin = new URL(baseURL!).origin;
    const traffic: Traffic = { creates: [], agentRequests: [] };
    const unexpected: string[] = [];
    await context.routeWebSocket(/.*/, () => { /* 不连接上游，包括开发服务器的 HMR。 */ });
    await context.route('**/*', async (route) => {
      const req = route.request();
      const { origin: host, pathname: path, searchParams: q } = new URL(req.url());
      const method = req.method();
      const block = (why: string) => {
        unexpected.push(`${method} ${path}: ${why}`);
        return route.abort('blockedbyclient');
      };
      // 仅页面及同源静态资源直通（包括 Vite 开发模式的 module preload）。
      // 不能用 **/api/** 匹配开发资源 /src/api/*.ts，也不放行未列出的 API 或模型请求。
      if (!path.startsWith('/api/')) {
        const document = req.isNavigationRequest() && ['/agent-sessions', '/inbox', '/login'].includes(path);
        const asset = path === '/acf-fox.svg' // 品牌组件也会以 fetch 读取同一静态 SVG
          || /^\/(?:@vite\/|@id\/|@fs\/|@react-refresh$|src\/|assets\/|node_modules\/|favicon\.ico$)/.test(path);
        return host === origin && method === 'GET' && (document || asset)
          ? route.continue() : block('非前端资源');
      }
      if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: {
        'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'authorization,content-type',
      } });
      if (req.headers().authorization !== `Bearer ${ACCESS}`) return block('缺少测试会话的认证头');
      if (path.startsWith('/api/agent/')) traffic.agentRequests.push(`${method} ${path}`);
      if (accountRole !== 'admin' && path.startsWith('/api/agent/')) return block('普通用户请求了 Agent API');
      if (method === 'POST' && path === LIST) {
        traffic.creates.push(req.postDataJSON());
        return reply(route, { id: CHAT_ID, status: 'pending' }, 201);
      }
      if (method !== 'GET') return block('意外的写操作');
      switch (path) {
        case '/api/auth/profile': return reply(route, { id: 7, username: '值班员', role: accountRole });
        case '/api/projects': case '/api/metrics/failures': return reply(route, []);
        case '/api/app-deployments/approvals/pending': return reply(route, { data: [], total: 0 });
        case '/api/agent/budget': return reply(route, { maxSteps: 12, maxTokens: 4000, maxToolCalls: 6, wallClockMs: 60_000 });
        case `${LIST}/backlogged`: return reply(route, { sessionIds: [], count: 0, probed: 0, truncated: false });
        case `${LIST}/queue-stall`: return reply(route, {
          stalled: false, reason: null, pendingJobs: 0, degraded: false, degradedCounts: false, workersKnown: true,
        });
        case `${LIST}/queue-idle`: return reply(route, {
          idleStuck: false, oldestAgeMs: 0, thresholdMs: 120_000, waitingCount: 0, retried: false,
          suppressedBy: null, degraded: false,
        });
        case LIST: {
          const rows = listed.filter(s => (!q.has('kind') || s.kind === q.get('kind'))
            && (!q.has('status') || s.status === q.get('status')) && (q.get('stalled') !== '1' || s.id === stalled.id));
          const size = Number(q.get('pageSize') || 20);
          const start = (Number(q.get('page') || 1) - 1) * size;
          return reply(route, { items: rows.slice(start, start + size), total: rows.length });
        }
      }
      const match = /^\/api\/agent\/sessions\/([^/]+)(\/approvals)?$/.exec(path);
      if (match) {
        const s = match[1] === CHAT_ID && traffic.creates.length ? chat : listed.find(row => row.id === match[1]);
        if (s) return reply(route, match[2] ? approvals.filter(a => a.sessionId === s.id)
          : { session: s, steps: s.id === CHAT_ID ? [answerStep] : [], toolCalls: [], children: [] });
      }
      return block('没有对应的离线响应');
    });
    await use(traffic);
    expect(unexpected, '未登记请求均已拦截，没有转发给后端').toEqual([]);
  }, { auto: true }],
});

test.use({ locale: 'zh-CN', serviceWorkers: 'block' });
function sessionUrl(params: Record<string, string | null>) {
  return (url: URL) => url.pathname === '/agent-sessions'
    && Object.entries(params).every(([key, value]) => url.searchParams.get(key) === value);
}

test.describe('Agent 会话交付', { tag: '@agent-journey' }, () => {
  test('提交普通文字，直接读新会话；刷新仍能查看，关闭回到原筛选', { tag: '@desktop' }, async ({ page, api }) => {
    const filters = { kind: 'incident', status: 'failed' };
    await page.goto('/agent-sessions?kind=incident&status=failed');
    await expect(page.getByText(LIST_TITLE, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '新建会话' }).click();
    const form = page.getByRole('dialog', { name: /新建.*会话/ });
    await form.getByLabel(/问题|目标/).fill(QUESTION);
    await form.getByRole('button', { name: '新建会话' }).click();
    await expect.poll(() => api.creates).toEqual([expect.objectContaining({
      kind: 'chat', context: expect.objectContaining({ question: QUESTION }),
    })]);
    await expect(page).toHaveURL(sessionUrl({ ...filters, session: CHAT_ID }));
    await expect(form).toBeHidden();
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByRole('region', { name: '本次问题' }).getByText(QUESTION, { exact: true })).toBeVisible();
    await expect(drawer.getByRole('region', { name: 'Agent 答复' }).getByText(CONCLUSION, { exact: true })).toBeVisible();
    await drawer.getByRole('tab', { name: '上下文与结论' }).click();
    const result = drawer.getByRole('tabpanel', { name: '上下文与结论' });
    await expect(result).toContainText(QUESTION);
    await expect(result).toContainText(CONCLUSION);

    await page.reload();
    await expect(page).toHaveURL(sessionUrl({ ...filters, session: CHAT_ID, tab: 'meta' }));
    await expect(result).toContainText(CONCLUSION);
    await drawer.getByRole('button', { name: /关闭|close/i }).click();
    await expect(drawer).toBeHidden();
    await expect(page).toHaveURL(sessionUrl({ ...filters, session: null, tab: null }));
    await expect(page.getByText(LIST_TITLE, { exact: true })).toBeVisible();
    await expect(page.getByText(SHARED_TITLE, { exact: true })).toHaveCount(0);
    expect(api.creates).toHaveLength(1); // 刷新/关闭不能重放创建
  });

  test.describe('窄屏收件箱', { tag: '@narrow' }, () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test('按同名记录的审批理由进入指定会话和审批单，而非第一条', async ({ page, api }) => {
      await page.goto('/inbox');
      const rows = page.getByTestId('inbox-row-agentApprovals').filter({ hasText: SHARED_TITLE });
      await expect(rows).toHaveCount(3); // 两个同名会话；目标会话还有另一张同工具的待审批单。
      const row = rows.filter({ hasText: target.reason });
      await row.getByRole('link', { name: '查看审批' }).click();
      await expect(page).toHaveURL(sessionUrl({ session: second.id, tab: 'approvals', approvalKey: target.approvalKey }));
      const drawer = page.getByRole('dialog');
      await expect(drawer.getByRole('tab', { name: /审批单/ })).toHaveAttribute('aria-selected', 'true');
      const panel = drawer.getByRole('tabpanel', { name: /审批单/ });
      const entry = panel.getByRole('row').filter({ hasText: target.reason });
      await expect(entry.getByText('taskId', { exact: true })).toBeVisible();
      const resource = entry.getByText(TARGET_TASK, { exact: true });
      await resource.scrollIntoViewIfNeeded(); // 窄屏审批表可横向滚动到参数列
      await expect(resource).toBeInViewport();
      await expect(panel.getByText(OTHER_TASK, { exact: true })).toHaveCount(0);
      await expect(panel.getByText(SIBLING_TASK, { exact: true })).toHaveCount(0);
      expect(api.creates).toHaveLength(0);
    });

    test('卡住的运行中会话仅可查看，收件箱及详情均无恢复动作', async ({ page, api }) => {
      await page.goto('/inbox');
      const row = page.getByTestId('inbox-row-stalled').filter({ hasText: stalled.title! });
      await expect(row).toBeVisible();
      const writeAction = /接管|恢\s*复|批\s*准|授\s*予|拒\s*绝/;
      await expect(row.getByRole('button', { name: writeAction })).toHaveCount(0);
      await row.getByRole('link', { name: '查看会话' }).click();
      await expect(page).toHaveURL(sessionUrl({ session: stalled.id, stalled: '1' }));
      const drawer = page.getByRole('dialog');
      await expect(drawer.getByText(stalled.title!, { exact: true })).toBeVisible();
      // 两次 GET 都已返回（计数从未知变为 0）再查负断言，避免「尚未加载」假绿。
      await expect(drawer.getByRole('tab', { name: '推理步骤（0）' })).toBeVisible();
      await expect(drawer.getByText('尚未记录推理步骤。', { exact: true })).toBeVisible();
      await expect(drawer.getByRole('tab', { name: '审批单（0）' })).toBeVisible();
      await expect(drawer.getByRole('button', { name: writeAction })).toHaveCount(0);
      expect(api.creates).toHaveLength(0);
    });
  });

  test.describe('普通用户', { tag: '@permissions' }, () => {
    test.use({ accountRole: 'user' });
    test('直接打开审批深链或收件箱得到 403，且不请求 Agent 数据', async ({ page, api }) => {
      for (const path of [`/agent-sessions?session=${second.id}&tab=approvals`, '/inbox']) {
        await page.goto(path);
        await expect(page.getByText('403', { exact: true })).toBeVisible();
        await expect(page.getByText(/此页面仅管理员可见/)).toBeVisible();
        await expect(page.getByRole('dialog')).toHaveCount(0);
      }
      expect(api.agentRequests).toEqual([]);
    });
  });
});
