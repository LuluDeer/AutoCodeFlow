import { test as base, expect } from "@playwright/test";

/**
 * 老板驾驶舱一屏 —— 真浏览器级（第 4 级）验收。
 *
 * ⚠️ 覆盖边界声明：**这是传输层 mock（context.route），不证明后端真跑。**
 *   · 本 spec 用真 build + 真 Chromium 渲染真实 SPA 产物，断言 DOM 可达与
 *     data-testid 可见、交互落点正确；
 *   · 所有 API 响应由 page.route 喂 fixture（含审批/北极星/既有 KPI/认证），
 *     因此只证明「前端在真实浏览器里对这些数据形状渲染正确」，
 *     不证明 API 真返回这些值、不证明后端持久化/约束/队列行为。
 *   真后端证据另见 north-star-real-backend.spec.ts 等 spec；二者不可互相替代。
 *
 * task-13 切片 C1 驾驶舱瘦身：驾驶舱砍为两卡（审批 + 北极星，北极星仅 admin）。
 * 原 CostPostureCard / TtfvCard 不再由驾驶舱渲染——TtfvCard 组件连同
 * e2e/ttfv-card.spec.ts 已整体退役；本 spec 用例 ④⑤ 改为「cockpit 内
 * cost/ttfv 锚缺席」断言（stub 夹具保持成本/北极星两路数据源兼容）。
 *
 * 环境适配（曾导致本 spec 的 unknown 假绿）：.env 把 VITE_API_URL_INTERNAL 指向
 * 独立 API 主机（如 :3105），请求路径是裸 /metrics/summary 而非 /api/metrics/summary。
 * 旧版只 stub '/api/' 前缀 ⇒ 一条都没命中 ⇒ 页面全走读取失败分支，
 * 「未知态」用例假绿、真值用例红。这里按「剥掉 /api 前缀」归一化，并用显式
 * STUB_PATHS 清单 + 认证三路 stub 修正。
 *
 * 运行口径（仓库既有）：
 *   PLAYWRIGHT_BASE_URL=<已起服务地址> npx playwright test e2e/boss-cockpit.spec.ts --config=playwright.config.ts
 */
const ACCESS = "boss-cockpit-stub-access";

interface BossFixtures {
  pendingApprovals: number | null;
  degraded: boolean;
  priceReason:
    | "OK"
    | "NO_TOKEN_SAMPLE"
    | "PRICE_MISSING"
    | "INVALID_TOKEN_COUNT"
    | "INVALID_PRICE";
  currencyValue: number | null;
  errors: string[];
}

const defaults = (): BossFixtures => ({
  pendingApprovals: 3,
  degraded: false,
  priceReason: "NO_TOKEN_SAMPLE",
  currencyValue: null,
  errors: [],
});

type ApiBody = Record<string, unknown>;
const envelope = (data: ApiBody | ApiBody[]) => ({
  code: 200,
  message: "success",
  data,
});

/** 归一化：/api/metrics/summary 与裸 /metrics/summary 都落到同一 stub 键。 */
const norm = (pathname: string) =>
  pathname.startsWith("/api/") ? pathname.slice(4) : pathname;

const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

/** 六路 KPI/趋势/调度等既有数据 + boss 三路 fixture 的统一桩。 */
function stub(path: string, fx: BossFixtures): ApiBody | ApiBody[] {
  if (path === "/auth/profile") {
    return { id: 1, username: "admin", role: "admin", totpEnabled: false };
  }
  if (path === "/auth/oidc/status") return { enabled: false };
  if (path === "/auth/sse-ticket") return { ticket: "stub" };
  // Dashboard 还会读项目列表与两个 SOP 计数；不 stub 就会打到真实 API（本机 :3105 时有时无），
  // 首屏报「网络连接失败」并落到骨架，导致 unknown 假绿 / 真值用例偶发红。
  if (path === "/projects") return [];
  if (
    ["/sop/clarifications/pending", "/sop/assignments/lagging"].includes(path)
  ) {
    return { items: [], total: 0 };
  }
  if (path === "/metrics/summary") {
    return {
      totalTasks: 3,
      todayRuns: 12,
      totalExecutors: 2,
      onlineExecutors: 2,
      executions: { total: 120, success: 110, failed: 10, running: 1 },
      successRate: 91.7,
      avgDurationMs: 3200,
    };
  }
  if (path === "/metrics/trend") {
    return [
      { date: daysAgo(2), success: 5, failed: 1, timeout: 0 },
      { date: daysAgo(1), success: 8, failed: 0, timeout: 0 },
      { date: daysAgo(0), success: 3, failed: 2, timeout: 0 },
    ];
  }
  if (["/metrics/executors", "/metrics/failures"].includes(path)) return [];
  if (path === "/metrics/scheduler") {
    return {
      counters: {
        ticks: 100,
        tickDurationMsTotal: 500,
        lastTickDurationMs: 3,
        lastTickAt: new Date().toISOString(),
        triggersClaimed: 20,
        triggersSkippedLockHeld: 0,
        triggersSkippedDbClaim: 0,
        triggersSkippedInactive: 0,
        triggersSkippedBlockStrategy: 0,
        triggersSkippedMaintenance: 0,
        triggersFailed: 0,
        dependencyTriggersClaimed: 0,
        dependencyTriggersSkipped: 0,
        triggerLatencyCount: 15,
        triggerLatencySumMs: 1500,
        triggerLatencyBuckets: [10, 4, 1, 0, 0, 0, 0, 0],
        lastTriggerLatencyMs: 42,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
      },
      derived: {
        avgTickDurationMs: 5,
        tickRatePerSec: 1.6,
        triggerClaimRatePerSec: 0.3,
        avgTriggerLatencyMs: 100,
        p99TriggerLatencyMs: 80,
      },
      queue: { waiting: 0, active: 1, delayed: 0, failed: 0, completed: 20 },
      scheduler: {
        healthy: true,
        isLeader: true,
        activeTimers: 2,
        activeCronTasks: 1,
        runningTaskCount: 1,
        totalScheduledTasks: 3,
        uptime: 60,
      },
      instance: { pid: 1234, hostname: "test-host" },
    };
  }
  if (path.endsWith("/scheduler-stats") || path === "/tasks/scheduler-stats") {
    return {
      healthy: true,
      isLeader: true,
      activeTimers: 2,
      activeCronTasks: 1,
      runningTaskCount: 1,
      totalScheduledTasks: 3,
      uptime: 60,
    };
  }
  if (path === "/agent/inbox/counts") {
    return {
      pendingApprovals: fx.pendingApprovals,
      waitingSessions: 2,
      stalled: 0,
      backlogged: 0,
      backlogTruncated: false,
      deployments: 0,
      queueStall: 0,
      failedSessions: 1,
      failedWindowHours: 24,
      degraded: fx.degraded,
    };
  }
  if (path === "/agent/approvals/pending") {
    return {
      items: [],
      total: fx.pendingApprovals,
      sessionTotal: 2,
      truncated: false,
      degraded: fx.degraded,
    };
  }
  if (path === "/capability-activation/stats") {
    return {
      total: 12,
      byCapability: [
        {
          capabilityKey: "browser",
          count: 12,
          success: 11,
          failure: 1,
          blocked: 0,
        },
      ],
      byProject: [{ projectId: "proj-a", count: 12 }],
      dualBasis: {
        basis: "per-activation",
        invocations: 12,
        successfulDeliveries: 11,
        skipped: 0,
        note: "无 token 样本，金额不可折算。",
        tokenSample: null,
        currencyValue: fx.currencyValue,
        priceReason: fx.priceReason,
        allocationNote: "无 token 样本，不折算金额。",
        byCapability: [],
        byProject: [],
      },
    };
  }
  if (path === "/agent/north-star/metrics") {
    return {
      as_of: "2026-11-20T10:30:00.000Z",
      business_confirmed: {
        weeks: [
          {
            week_start: "2026-11-16",
            active_installs: 7,
            confirmed_events: 42,
          },
        ],
        totals: { active_install_weeks: 7, confirmed_events: 42 },
      },
      business_results_proxy: {
        weeks: [{ week_start: "2026-11-16", executions: 99 }],
        totals: { executions: 99 },
      },
      promotionEligibility: {
        eligible: true,
        reasons: [],
        reasonDetails: [],
        weeks: 1,
        activeInstallWeeks: 7,
        thresholds: { minWeeks: 4, minActiveInstallWeeks: 20 },
      },
      warnings: ["⚠️ 有产物/有证据 ≠ 被业务确认，代理值勿当严格值"],
    };
  }
  return {
    code: 200,
    message: "success",
    data: { items: [], total: 0, data: [] },
  };
}

/** 显式清单（归一化后的裸路径）：认证三路 + boss 三路 + 既有 KPI 六路。 */
const STUB_PATHS = [
  "/auth/profile",
  "/auth/oidc/status",
  "/auth/sse-ticket",
  "/projects",
  "/sop/clarifications/pending",
  "/sop/assignments/lagging",
  "/agent/inbox/counts",
  "/agent/approvals/pending",
  "/capability-activation/stats",
  "/agent/north-star/metrics",
  "/metrics/summary",
  "/metrics/trend",
  "/metrics/executors",
  "/metrics/failures",
  "/metrics/scheduler",
  "/tasks/scheduler-stats",
];

const test = base.extend<{ boss: BossFixtures }>({
  boss: [
    async ({ context }, use) => {
      const fx = defaults();
      context.on("pageerror", (err) => fx.errors.push(err.message));
      await context.route(
        (url) => STUB_PATHS.includes(norm(url.pathname)),
        async (route) => {
          const req = route.request();
          const path = norm(new URL(req.url()).pathname);
          if (req.method() === "OPTIONS") {
            return route.fulfill({
              status: 204,
              headers: { "access-control-allow-origin": "*" },
            });
          }
          // 回显请求 origin，满足独立 API 主机下的 CORS credential 校验。
          const origin = req.headers().origin ?? "*";
          return route.fulfill({
            status: 200,
            headers: {
              "access-control-allow-origin": origin,
              "access-control-allow-credentials": "true",
              "content-type": "application/json",
            },
            body: JSON.stringify(envelope(stub(path, fx))),
          });
        },
      );
      await use(fx);
    },
    { auto: true },
  ],
});

function seedInitScript() {
  return `(() => {
    try {
      localStorage.setItem('autoflow-lang', 'zh');
      localStorage.setItem('autoflow-auth', JSON.stringify({ state: {
        token: '${ACCESS}', refreshToken: 'stub-refresh',
        user: { id: 1, username: 'admin', role: 'admin', totpEnabled: false },
      }, version: 0 }));
    } catch (e) {}
  })();`;
}

async function openDashboard(page: import("@playwright/test").Page) {
  await page.context().addInitScript(seedInitScript());
  await page.goto("/dashboard");
  // Vite dev 首次按需编译 + 六路查询并发，首屏可能超过默认 5s 断言窗口。
  await expect(page.getByTestId("boss-cockpit")).toBeVisible({
    timeout: 15000,
  });
}

test.describe("老板驾驶舱一屏（传输层 mock，非真后端）", () => {
  test("① 首屏两卡同屏：审批卡 + 北极星卡可见，北极星仅一处，cost/ttfv 锚缺席", async ({
    page,
    boss,
  }) => {
    await openDashboard(page);
    await expect(page.getByTestId("boss-approval-card")).toBeVisible();
    await expect(page.getByTestId("boss-approval-count")).toContainText("3");
    // 北极星卡：strict 锚点在 cockpit 内且全页唯一。
    const cockpit = page.getByTestId("boss-cockpit");
    await expect(
      cockpit.locator('[data-testid="north-star-strict"]'),
    ).toHaveCount(1);
    await expect(page.locator('[data-testid="north-star-strict"]')).toHaveCount(
      1,
    );
    // 瘦身契约：驾驶舱不再渲染成本卡与 TTFV 卡（ttfv spec 已退役）。
    await expect(cockpit.locator('[data-testid="boss-cost-card"]')).toHaveCount(0);
    await expect(cockpit.locator('[data-testid="boss-cost-amount"]')).toHaveCount(0);
    await expect(cockpit.locator('[data-testid="boss-cost-unavailable"]')).toHaveCount(0);
    await expect(cockpit.locator('[data-testid="boss-ttfv-card"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="boss-ttfv-card"]')).toHaveCount(0);
    expect(boss.errors.filter((e) => !e.includes("favicon"))).toEqual([]);
  });

  test("② null+degraded ⇒ 未知可见、count 不存在、审批卡无 0", async ({
    page,
    boss,
  }) => {
    boss.pendingApprovals = null;
    boss.degraded = true;
    await openDashboard(page);
    await expect(page.getByTestId("boss-approval-unknown")).toBeVisible();
    await expect(page.getByTestId("boss-approval-count")).toHaveCount(0);
    const cardText = await page.getByTestId("boss-approval-card").innerText();
    expect(cardText).not.toContain("0");
  });

  test("③ pendingApprovals=0 ⇒ 空态可见、不显示未知", async ({
    page,
    boss,
  }) => {
    boss.pendingApprovals = 0;
    await openDashboard(page);
    await expect(page.getByTestId("boss-approval-empty")).toBeVisible();
    await expect(page.getByTestId("boss-approval-unknown")).toHaveCount(0);
  });

  test("④ NO_TOKEN_SAMPLE ⇒ 驾驶舱不渲染成本卡（诚实标缺语义上屏退役）", async ({
    page,
  }) => {
    await openDashboard(page);
    await expect(page.getByTestId("boss-cost-card")).toHaveCount(0);
    await expect(page.getByTestId("boss-cost-unavailable")).toHaveCount(0);
    await expect(page.getByTestId("boss-cost-amount")).toHaveCount(0);
    // 全页文本也不出现折算金额假事实。
    const cockpitText = await page.getByTestId("boss-cockpit").innerText();
    expect(cockpitText).not.toContain("¥0.00");
  });

  test("⑤ 成本 OK+123.45 ⇒ 驾驶舱内仍无 cost 锚（数据形状无关，两卡不变）", async ({
    page,
    boss,
  }) => {
    boss.priceReason = "OK";
    boss.currencyValue = 123.45;
    await openDashboard(page);
    const cockpit = page.getByTestId("boss-cockpit");
    await expect(page.getByTestId("boss-cost-amount")).toHaveCount(0);
    await expect(page.getByTestId("boss-cost-unavailable")).toHaveCount(0);
    await expect(page.getByTestId("boss-cost-card")).toHaveCount(0);
    // 两卡同屏契约在成本数据为真值时依旧成立。
    await expect(cockpit.locator('[data-testid="north-star-strict"]')).toHaveCount(1);
    await expect(cockpit.locator('[data-testid="boss-approval-card"]')).toHaveCount(1);
  });

  test("⑥ 审批入口点击跳 /inbox", async ({ page }) => {
    await openDashboard(page);
    await page.getByTestId("boss-approval-link").click();
    await expect(page).toHaveURL(/\/inbox/);
  });
});
