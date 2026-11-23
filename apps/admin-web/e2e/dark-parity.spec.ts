/**
 * 暗色主题 parity 真机取证（离线 stub + vite dev，真浏览器渲染）。
 *
 * 目的：在真 Chromium 下钉住 dark/light × zh/en × 关键页的实际渲染，截图落盘并
 * 跑计算样式对比度抽检；只做取证与证据采集，不在 spec 里改业务样式。
 *
 * 离线口径（与 agent-session-journey.spec.ts 同范式）：
 *   · storageState 种子 localStorage：autoflow-theme（三态 persist 键）、
 *     autoflow-lang、autoflow-auth（refreshToken 非空过 PrivateRoute，role=admin 过
 *     RequireAdmin）；
 *   context.route 拦截 /api/**，按端点返回良性空态封套 { code, message, data }，
 *     不连真后端/真库；非 API 同源静态资源直通。
 *
 * 首帧防闪验证：goto 到 domcontentloaded 即读 documentElement[data-theme]，
 * 断言与种子主题一致（THEME_INIT_SCRIPT 在 DOM 解析前注入，无 FOUC 闪白）。
 *
 * 产物：test-results/dark-parity/<theme>-<lang>-<page>.png + 同名 .json 审计记录。
 */
import { test as base, expect, type Route } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const OUT =
  process.env.DARK_PARITY_OUT || path.join(process.cwd(), 'test-results', 'dark-parity');

type Theme = 'dark' | 'light';
type Locale = 'zh' | 'en';

const PAGES = [
  { key: 'login', path: '/login' },
  { key: 'dashboard', path: '/dashboard' },
  { key: 'executions-list', path: '/executions' },
  { key: 'execution-detail', path: '/tasks/task-001/executions/exec-001' },
  { key: 'executors', path: '/executors' },
  { key: 'executor-detail', path: '/executors/exe-001' },
  { key: 'sops', path: '/sops' },
  { key: 'sops-from-video', path: '/sops/from-video' },
  { key: 'sops-from-video-chat', path: '/sops/from-video?session=demo-001' },
  { key: 'agent-sessions', path: '/agent-sessions' },
  { key: 'audit', path: '/audit' },
  { key: 'inbox', path: '/inbox' },
  { key: 'settings', path: '/settings' },
] as const;

const THEMES: Theme[] = ['dark', 'light'];
const LOCALES: Locale[] = ['zh', 'en'];

const STUB_PROFILE = { id: 1, username: 'admin', role: 'admin', totpEnabled: false };

function reply(route: Route, data: unknown, status = 200) {
  return route.fulfill({
    status,
    headers: { 'access-control-allow-origin': '*' },
    json: { code: status, message: 'success', data },
  });
}

/** 良性空态封套：列表页空数组 + total；详情对象给最小可渲染字段。 */
function stubData(pathname: string, method: string): unknown {
  // 认证 / 会话
  if (pathname === '/api/auth/profile') return STUB_PROFILE;
  if (pathname === '/api/auth/oidc/status') return { enabled: false };
  if (pathname === '/api/auth/sessions') return [];
  // 收件箱计数（扁平 DTO，键齐备防页面读 undefined 崩溃）
  if (pathname === '/api/agent/inbox/counts') {
    return {
      pendingApprovals: 0, waitingSessions: 0, stalled: 0, backlogged: 0,
      backlogTruncated: false, deployments: 0, queueStall: 0, failedSessions: 0,
      failedWindowHours: 24, degraded: false,
    };
  }
  if (pathname === '/api/agent/approvals/pending') {
    return { items: [], total: 0, sessionTotal: 0, returned: 0, truncated: false, degraded: false };
  }
  if (pathname === '/api/agent/budget') {
    return { maxSteps: 40, maxTokens: 200_000, maxToolCalls: 60, wallClockMs: 1_800_000 };
  }
  if (pathname === '/api/agent/telemetry/status') return { consent: false };
  if (/^\/api\/agent\/sessions\/queue-(stall|idle)$/.test(pathname)) {
    return { stalled: false, reason: null, pendingJobs: 0, degraded: false, degradedCounts: false,
      workersKnown: true, idleStuck: false, oldestAgeMs: 0, thresholdMs: 120_000,
      waitingCount: 0, retried: false, suppressedBy: null };
  }
  if (pathname === '/api/agent/sessions/backlogged') return { sessionIds: [], count: 0, probed: 0, truncated: false };
  if (pathname === '/api/agent/sessions') return { items: [], total: 0 };
  // SOP / 视频转 SOP
  if (pathname === '/api/sop/clarifications/pending' || pathname === '/api/sop/assignments/lagging') {
    return { items: [], data: [], total: 0, returned: 0, truncated: false, degraded: false };
  }
  if (pathname === '/api/sop/assignable-executors') return [];
  if (pathname === '/api/sop') return { items: [], total: 0 };
  if (pathname === '/api/ai/sop-sessions') return { items: [] };
  if (pathname === '/api/ai/config') return {};
  if (pathname === '/api/ai/providers') return { providers: [] };
  // 交互式 SOP 会话详情（?session= 深链续跑）：带两条消息，供气泡底色取证。
  if (/^\/api\/ai\/sop-sessions\/[^/]+$/.test(pathname)) {
    const now = new Date().toISOString();
    return {
      id: 'demo-001', status: 'active', provider: 'stub-provider',
      questionsAsked: 1, remainingQuestions: 4, draft: null, media: [],
      messages: [
        { role: 'user', text: '演示用户消息：登录后如何创建第一个自动化任务？', at: now },
        { role: 'assistant', text: '演示助手回复：进入「任务」页点击新建，选择执行器与触发方式即可。', action: 'ask', at: now },
      ],
    };
  }
  // 审计
  if (pathname === '/api/audit') return { data: [], total: 0 };
  if (pathname === '/api/audit/actions') return { actions: [] };
  // 执行器
  if (pathname === '/api/executors') return [];
  if (pathname === '/api/executors/groups' || pathname === '/api/executors/tags') return [];
  if (pathname === '/api/executors/picker') return { items: [], total: 0 };
  if (pathname === '/api/executors/runtime-config') return {};
  if (pathname === '/api/executors/install-cmd') return { command: '', script: '', token: '' };
  if (/^\/api\/executors\/[^/]+\/executions$/.test(pathname)) return { total: 0, items: [] };
  if (/^\/api\/executors\/[^/]+\/metrics$/.test(pathname)) {
    return { cpuUsage: 0, memUsage: 0, diskUsage: 0, networkLatency: null, trend: [] };
  }
  if (/^\/api\/executors\/[^/]+\/removal-impact$/.test(pathname)) {
    return { runningTasks: 0, queuedTasks: 0, affectedDeployments: [] };
  }
  if (/^\/api\/executors\/[^/]+$/.test(pathname)) {
    return {
      id: 'exe-001', appName: 'node-executor', address: '127.0.0.1:9100', status: 'online',
      type: 'node', executorVersion: '2.14.0', cpuUsage: 12, memUsage: 34, runningTaskCount: 0,
      totalTaskCount: 0, failedTaskCount: 0, lastHeartbeat: new Date().toISOString(),
      groupName: null, tags: [], description: null, maxConcurrentTasks: 10, projectId: null,
      runningExecutionIds: [], reservedSlots: 0, deadLetterCount: 0, taskSandbox: 'bwrap',
      dispatchMode: 'push', protocolVersion: 2, versionCompliant: true, offlineReason: null,
      deviceFingerprint: null,
    };
  }
  // 任务 / 执行详情
  if (/^\/api\/tasks\/[^/]+\/executions$/.test(pathname)) return { items: [], total: 0 };
  if (/^\/api\/tasks\/[^/]+\/executions\/[^/]+$/.test(pathname)) {
    return {
      id: 'exec-001', taskId: 'task-001', taskName: 'stub task', status: 'success',
      triggerType: 'manual', executorAddress: null, executorId: null,
      startTime: new Date().toISOString(), endTime: new Date().toISOString(), duration: 1200,
      params: {}, logs: '', errorMessage: null, failureReason: null, exitCode: 0,
      retryCount: 0, agentSessionId: null, taskVersion: null, traceId: null, synthetic: false,
    };
  }
  if (pathname === '/api/tasks') return { items: [], total: 0 };
  // 指标
  if (pathname === '/api/metrics/summary') {
    return { totalTasks: 0, todayRuns: 0, totalExecutors: 0, onlineExecutors: 0,
      executions: { total: 0, success: 0, failed: 0, running: 0 }, successRate: 0, avgDurationMs: 0 };
  }
  if (pathname === '/api/metrics/trend' || pathname === '/api/metrics/executors' || pathname === '/api/metrics/failures') return [];
  if (pathname === '/api/metrics/scheduler') {
    return { counters: { ticks: 0, tickDurationMsTotal: 0, lastTickDurationMs: 0, lastTickAt: null,
      triggersClaimed: 0, triggersSkippedLockHeld: 0, triggersSkippedInactive: 0,
      triggersSkippedBlockStrategy: 0, triggersSkippedMaintenance: 0, triggersSkippedInactive: 0,
      triggersFailed: 0, dependencyTriggersClaimed: 0, dependencyTriggersSkipped: 0,
      triggerLatencyCount: 0, triggerLatencySumMs: 0, triggerLatencyBuckets: [], lastTriggerLatencyMs: 0,
      startedAt: new Date().toISOString() },
      derived: { avgTickDurationMs: 0, tickRatePerSec: 0, triggerClaimRatePerSec: 0,
        avgTriggerLatencyMs: 0, p99TriggerLatencyMs: 0 },
      queue: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
      scheduler: { healthy: true, isLeader: true, activeTimers: 0, activeCronTasks: 0,
        runningTaskCount: 0, totalScheduledTasks: 0, uptime: 0 },
      instance: { pid: 0, hostname: 'stub' } };
  }
  // 应用 / 部署 / 项目 / 通知 / 注册表 / 配置 / 密钥
  if (pathname === '/api/applications' || pathname === '/api/projects' || pathname === '/api/api-keys'
    || pathname === '/api/executor-packages' || pathname === '/api/notification/channels'
    || pathname === '/api/notification/silences' || pathname === '/api/config'
    || pathname === '/api/app-deployments/stats' || pathname === '/api/mutex-groups') return [];
  if (pathname === '/api/app-deployments') return { data: [], total: 0 };
  if (pathname === '/api/app-deployments/approvals/pending') return { items: [], total: 0 };
  if (pathname === '/api/config/history') return { data: [], total: 0 };
  if (pathname === '/api/config/executor-shared-token') return { token: null, hasToken: false };
  if (pathname === '/api/registry/pypi/packages') return { packages: [] };
  if (pathname === '/api/registry/npm/packages') return [];
  // 兜底：宽松列表封套（items/data/total 三键齐备，消费方取任一不致崩溃）。
  return { items: [], total: 0, data: [] };
}

const test = base.extend<{ parityErrors: string[] }>({
  parityErrors: [async ({ context }, use) => {
    const errors: string[] = [];
    context.on('pageerror', (err) => errors.push(err.message));
    // 仅拦截同源 /api/ 前缀；不能用 '**/api/**' 通配——它会命中源码路径
    // /src/api/**（如 queryClient.ts），把源码模块回成 JSON 封套，MIME 校验失败致 root 空渲染。
    await context.route((url) => url.pathname.startsWith('/api/'), async (route) => {
      const req = route.request();
      const { pathname } = new URL(req.url());
      if (req.method() === 'OPTIONS') {
        return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
      }
      return reply(route, stubData(pathname, req.method()));
    });
    await use(errors);
  }, { auto: true }],
});

function seedInitScript(theme: Theme, lang: Locale) {
  return `(() => {
    try {
      localStorage.setItem('autoflow-theme', JSON.stringify({ state: { mode: '${theme}' }, version: 0 }));
      localStorage.setItem('autoflow-lang', '${lang}');
      localStorage.setItem('autoflow-auth', JSON.stringify({ state: {
        token: 'stub-access', refreshToken: 'stub-refresh',
        user: { id: 1, username: 'admin', role: 'admin', totpEnabled: false },
      }, version: 0 }));
    } catch (e) {}
  })();`;
}

/** 计算样式对比度抽检：收集自带文本的叶子节点，按最近非透明祖先底色算比值。 */
async function contrastAudit(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const parse = (color: string): [number, number, number] | null => {
      const m = color.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const parts = m[1].split(',').map((p) => parseFloat(p.trim()));
      return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
    };
    const lum = (rgb: [number, number, number]) => {
      const [r, g, b] = rgb.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: [number, number, number], b: [number, number, number]) => {
      const l1 = lum(a);
      const l2 = lum(b);
      const hi = Math.max(l1, l2);
      const lo = Math.min(l1, l2);
      return (hi + 0.05) / (lo + 0.05);
    };
    const violations: Array<Record<string, string | number>> = [];
    document.querySelectorAll('body *').forEach((el) => {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent || '')
        .join('').trim();
      if (!own) return;
      let bg = 'rgba(255,255,255,1)';
      let node: HTMLElement | null = el;
      while (node && node !== document.documentElement) {
        const bs = getComputedStyle(node);
        if (bs.backgroundColor && bs.backgroundColor !== 'rgba(0, 0, 0, 0)') {
          bg = bs.backgroundColor;
          break;
        }
        node = node.parentElement;
      }
      const fg = style.color;
      const fgRgb = parse(fg);
      const bgRgb = parse(bg);
      if (!fgRgb || !bgRgb) return;
      const r = ratio(fgRgb, bgRgb);
      const size = parseFloat(style.fontSize);
      const weight = parseFloat(style.fontWeight);
      const large = size >= 24 || (size >= 18.66 && weight >= 600);
      const threshold = large ? 3 : 4.5;
      if (r < threshold) {
        violations.push({
          tag: el.tagName, text: own.slice(0, 30), fg, bg,
          ratio: Number(r.toFixed(2)), fontSize: style.fontSize, weight: style.fontWeight,
        });
      }
    });
    return violations;
  });
}

fs.mkdirSync(OUT, { recursive: true });

for (const theme of THEMES) {
  for (const lang of LOCALES) {
    test.describe(`dark-parity ${theme} / ${lang}`, () => {
      for (const entry of PAGES) {
        test(`${entry.key} (${theme}/${lang})`, async ({ page, parityErrors }) => {
          await page.context().addInitScript(seedInitScript(theme, lang));
          await page.goto(entry.path);
          // 首帧防闪：DOM 解析后 data-theme 必须已是种子主题（无闪白/闪暗过渡）。
          await page.waitForLoadState('domcontentloaded');
          const dataTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
          expect(dataTheme).toBe(theme);

          // 等懒加载 chunk 与首屏查询落地（SSE/长轮询已被 stub 截断，不会挂住 networkidle）。
          await page.waitForTimeout(900);

          const violations = await contrastAudit(page);
          // react-error-boundary 吞掉渲染异常后不发 pageerror，需直接探测兜底 Result。
          const boundaryHit = await page.evaluate(
            () => !!document.querySelector('.ant-result-status-error'),
          );
          const fatal = parityErrors.filter(
            (e) => !e.includes('favicon') && !e.includes('401') && !e.includes('403'),
          );
          if (boundaryHit) fatal.push('render error boundary shown (.ant-result-status-error)');

          const base = `${theme}-${lang}-${entry.key}`;
          const shotPath = path.join(OUT, `${base}.png`);
          await page.screenshot({ path: shotPath, fullPage: true });

          const record = {
            theme, lang, page: entry.key, path: entry.path, url: page.url(),
            dataTheme, title: await page.title(),
            fatalErrors: fatal, contrastViolations: violations,
            screenshot: shotPath,
          };
          fs.writeFileSync(path.join(OUT, `${base}.json`), JSON.stringify(record, null, 2));

          // 取证口径：不允许未捕获致命 JS 错误（坏链/空态崩溃会进错误边界，截图可见）。
          expect(fatal, `fatal page errors on ${entry.key}`).toEqual([]);
        });
      }
    });
  }
}
