import { test as base, expect } from "@playwright/test";

/**
 * TTFV 三态标缺 —— 真浏览器级（第 4 级）验收。
 *
 * ⚠️ 覆盖边界声明：**这是传输层 mock（context.route），不证明后端真跑。**
 *   · 真 Chromium 渲染真 SPA 产物，断言 data-testid 在真实 DOM 中可见；
 *   · GET .../agent/north-star/metrics 的响应由 page.route 喂三态 fixture，
 *     因此只证明「前端在真实浏览器里对这些数据形状渲染正确」，
 *     不证明后端真返回这些值，也不证明持久化 / 约束 / 队列行为。
 *   后端口径证据见 apps/admin-api/.../ttfv-api-contract.spec.ts（第 2 级），二者不可互替。
 *
 * 环境适配：本仓 .env 把 VITE_API_URL_INTERNAL 指向独立 API 主机（如 :3105），
 * 故请求路径既可能是 /api/xxx 也可能是裸 /xxx；下面按「剥掉 /api 前缀」归一化匹配，
 * 避免只 stub /api/ 导致一律走真实网络、页面落到 login 的假绿。
 *
 * 运行口径：npx playwright test e2e/ttfv-card.spec.ts（需先起 admin-web dev server）。
 */
const ACCESS = "ttfv-card-stub-access";

type DataStatus = "gate_off" | "no_data" | "ok" | "bogus";
interface TtfvFixture {
  dataStatus: DataStatus;
  medianMinutes: number | null;
  activation24h: number | null;
  sampleSize: number;
  asOf: string;
  note: string;
}

interface CardFixtures {
  ttfv: TtfvFixture | undefined;
  errors: string[];
}

const AS_OF = "2026-11-20T10:30:00.000Z";
const defaults = (): CardFixtures => ({
  ttfv: {
    dataStatus: "ok",
    medianMinutes: 8.5,
    activation24h: 0.5,
    sampleSize: 7,
    asOf: AS_OF,
    note: "真实口径仅覆盖 opt-in install",
  },
  errors: [],
});

type ApiBody = Record<string, unknown>;
const envelope = (data: ApiBody | ApiBody[]) => ({
  code: 200,
  message: "success",
  data,
});

const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

const northStar = (ttfv: TtfvFixture | undefined): ApiBody => ({
  as_of: AS_OF,
  business_confirmed: {
    weeks: [
      { week_start: "2026-11-16", active_installs: 7, confirmed_events: 42 },
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
  // 显式 undefined ⇒ 字段整体缺席（未知防御分支）。
  ...(ttfv === undefined ? {} : { ttfv }),
});

/** 归一化：/api/metrics/summary 与裸 /metrics/summary 都落到同一 stub 键。 */
const norm = (pathname: string) =>
  pathname.startsWith("/api/") ? pathname.slice(4) : pathname;

function stub(path: string, fx: CardFixtures): ApiBody | ApiBody[] {
  if (path === "/agent/north-star/metrics") return northStar(fx.ttfv);
  if (path === "/auth/profile") {
    return { id: 1, username: "admin", role: "admin", totpEnabled: false };
  }
  if (path === "/auth/oidc/status") return { enabled: false };
  if (path === "/auth/sse-ticket") return { ticket: "stub" };
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
      pendingApprovals: 3,
      waitingSessions: 2,
      stalled: 0,
      backlogged: 0,
      backlogTruncated: false,
      deployments: 0,
      queueStall: 0,
      failedSessions: 1,
      failedWindowHours: 24,
      degraded: false,
    };
  }
  if (path === "/agent/approvals/pending") {
    return {
      items: [],
      total: 3,
      sessionTotal: 2,
      truncated: false,
      degraded: false,
    };
  }
  if (path === "/capability-activation/stats") {
    return {
      total: 12,
      byCapability: [],
      byProject: [],
      dualBasis: {
        basis: "per-activation",
        invocations: 12,
        successfulDeliveries: 11,
        skipped: 0,
        note: "无 token 样本，金额不可折算。",
        tokenSample: null,
        currencyValue: null,
        priceReason: "NO_TOKEN_SAMPLE",
        allocationNote: "无 token 样本，不折算金额。",
        byCapability: [],
        byProject: [],
      },
    };
  }
  return {
    code: 200,
    message: "success",
    data: { items: [], total: 0, data: [] },
  };
}

const STUB_PATHS = [
  "/agent/north-star/metrics",
  "/auth/profile",
  "/auth/oidc/status",
  "/auth/sse-ticket",
  "/metrics/summary",
  "/metrics/trend",
  "/metrics/executors",
  "/metrics/failures",
  "/metrics/scheduler",
  "/tasks/scheduler-stats",
  "/agent/inbox/counts",
  "/agent/approvals/pending",
  "/capability-activation/stats",
];

const test = base.extend<{ card: CardFixtures }>({
  card: [
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
  await expect(page.getByTestId("boss-cockpit")).toBeVisible();
}

test.describe("TTFV 三态标缺（传输层 mock，非真后端）", () => {
  test("① gate_off ⇒ 标缺态可见、无中位数、无「0 分钟」", async ({
    page,
    card,
  }) => {
    card.ttfv = {
      dataStatus: "gate_off",
      medianMinutes: 8.5,
      activation24h: 0.5,
      sampleSize: 5,
      asOf: AS_OF,
      note: "系统开关未启用",
    };
    await openDashboard(page);
    await expect(page.getByTestId("boss-ttfv-gate-off")).toBeVisible();
    await expect(page.getByTestId("boss-ttfv-median")).toHaveCount(0);
    const text = await page.getByTestId("boss-ttfv-card").innerText();
    expect(text).not.toContain("0 分钟");
    expect(text).not.toContain("8.5 分钟");
  });

  test("② no_data ⇒ 标缺态可见、无中位数", async ({ page, card }) => {
    card.ttfv = {
      dataStatus: "no_data",
      medianMinutes: null,
      activation24h: null,
      sampleSize: 0,
      asOf: AS_OF,
      note: "授权后暂无可算样本",
    };
    await openDashboard(page);
    await expect(page.getByTestId("boss-ttfv-no-data")).toBeVisible();
    await expect(page.getByTestId("boss-ttfv-median")).toHaveCount(0);
    const text = await page.getByTestId("boss-ttfv-card").innerText();
    expect(text).not.toContain("0 分钟");
  });

  test("③ ok + 8.5 + 0.5 ⇒ 有数据态、8.5 分钟与百分比", async ({ page }) => {
    await openDashboard(page);
    await expect(page.getByTestId("boss-ttfv-ok")).toBeVisible();
    await expect(page.getByTestId("boss-ttfv-median")).toContainText(
      "8.5 分钟",
    );
    await expect(page.getByTestId("boss-ttfv-activation")).toContainText("50%");
  });

  test("④ ok + activation24h=null ⇒ 24h 单列标缺，绝不 0%", async ({
    page,
    card,
  }) => {
    card.ttfv = {
      dataStatus: "ok",
      medianMinutes: 8.5,
      activation24h: null,
      sampleSize: 7,
      asOf: AS_OF,
      note: "",
    };
    await openDashboard(page);
    await expect(page.getByTestId("boss-ttfv-ok")).toBeVisible();
    await expect(page.getByTestId("boss-ttfv-activation")).toContainText(
      "样本未满 24h",
    );
    await expect(page.getByTestId("boss-ttfv-activation")).not.toContainText(
      "0%",
    );
  });

  test("⑤ ttfv 字段缺席 ⇒ unknown、无数字、无 pageerror", async ({
    page,
    card,
  }) => {
    card.ttfv = undefined;
    await openDashboard(page);
    await expect(page.getByTestId("boss-ttfv-unknown")).toBeVisible();
    await expect(page.getByTestId("boss-ttfv-median")).toHaveCount(0);
    const text = await page.getByTestId("boss-ttfv-card").innerText();
    expect(text).not.toContain("8.5");
    expect(card.errors.filter((e) => !e.includes("favicon"))).toEqual([]);
  });

  test("⑥ 矛盾防御：ok + median=null ⇒ unknown", async ({ page, card }) => {
    card.ttfv = {
      dataStatus: "ok",
      medianMinutes: null,
      activation24h: 0.5,
      sampleSize: 7,
      asOf: AS_OF,
      note: "",
    };
    await openDashboard(page);
    await expect(page.getByTestId("boss-ttfv-unknown")).toBeVisible();
    await expect(page.getByTestId("boss-ttfv-ok")).toHaveCount(0);
  });

  test("⑦ 驾驶舱四牌同屏：ttfv / approval / cost / north-star 均在 cockpit 内", async ({
    page,
  }) => {
    await openDashboard(page);
    const cockpit = page.getByTestId("boss-cockpit");
    for (const id of [
      "boss-ttfv-card",
      "boss-approval-card",
      "boss-cost-card",
      "north-star-card",
    ]) {
      await expect(cockpit.locator(`[data-testid="${id}"]`)).toHaveCount(1);
    }
  });
});
