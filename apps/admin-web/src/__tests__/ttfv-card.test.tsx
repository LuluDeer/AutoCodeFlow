/**
 * TTFV 真实口径上屏 · 前端第 2 级验收（组件级 / RTL + API 层 mock）。
 *
 * 覆盖契约（impl-ttfv-web 承诺的 data-testid）：
 *   · boss-ttfv-card        外层常驻
 *   · boss-ttfv-gate-off / boss-ttfv-no-data / boss-ttfv-ok / boss-ttfv-unknown
 *                            四态互斥，每次只出现一个
 *   · boss-ttfv-median / boss-ttfv-activation / boss-ttfv-sample-size
 *   · boss-ttfv-note / boss-ttfv-as-of
 *
 * 边界声明：本套件 mock 的是 API 层（metricsApi.getNorthStar），只证明「组件在该
 * 数据形状下的分支行为」；不证明后端真跑、不证明传输层已接通。
 * 真浏览器级（同为传输层 mock）见 e2e/ttfv-card.spec.ts。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useAuthStore } from "../store/auth";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cloneElement } from "react";

import DashboardPage from "../pages/DashboardPage";
import TtfvCard from "../components/dashboard/TtfvCard";
import { metricsApi, type NorthStarReport } from "../api/metrics";
import { tasksApi } from "../api/tasks";
import { agentApi } from "../api/agent";
import * as activationApi from "../api/capability-activation";
import { setLanguage, STORAGE_KEY } from "../i18n";

// ── API 层 mock（对齐 boss-cockpit.test.tsx / north-star-card.test.tsx）─────
vi.mock("../api/metrics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/metrics")>();
  return {
    ...actual,
    metricsApi: {
      getSummary: vi.fn(),
      getDailyTrend: vi.fn(),
      getExecutorStats: vi.fn(),
      getRecentFailures: vi.fn(),
      getSchedulerMetrics: vi.fn(),
      getNorthStar: vi.fn(),
    },
  };
});
const mockedMetrics = vi.mocked(metricsApi, true);

vi.mock("../api/tasks", () => ({ tasksApi: { schedulerStats: vi.fn() } }));
const mockedTasks = vi.mocked(tasksApi, true);

vi.mock("../api/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/agent")>();
  return {
    ...actual,
    agentApi: {
      ...actual.agentApi,
      inboxCounts: vi.fn(),
      listPendingApprovals: vi.fn(),
    },
  };
});
const mockedAgent = vi.mocked(agentApi, true);

vi.mock("../api/capability-activation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../api/capability-activation")>();
  return { ...actual, getActivationStats: vi.fn() };
});
const mockedGetActivationStats = vi.mocked(
  activationApi.getActivationStats,
  true,
);

vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({
      children,
    }: {
      children: React.ReactElement<Record<string, unknown>>;
    }) => cloneElement(children, { width: 200, height: 36 }),
  };
});

const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
Object.defineProperty(HTMLElement.prototype, "clientWidth", {
  configurable: true,
  value: 800,
});
Object.defineProperty(HTMLElement.prototype, "clientHeight", {
  configurable: true,
  value: 400,
});
class NoopEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  addEventListener() {}
  close() {}
}
g.EventSource = NoopEventSource;

// ── fixtures ─────────────────────────────────────────────────────────────────
const AS_OF = "2026-11-20T10:30:00.000Z";

type TtfvFixture = {
  dataStatus: "gate_off" | "no_data" | "ok" | "bogus";
  medianMinutes: number | null;
  activation24h: number | null;
  sampleSize: number;
  asOf: string;
  note: string;
};

const baseReport = {
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
};

/** ttfv 显式传 undefined ⇒ 字段整体缺席（未知防御分支）。 */
const reportWith = (ttfv: TtfvFixture | undefined): NorthStarReport =>
  (ttfv === undefined
    ? { ...baseReport }
    : { ...baseReport, ttfv }) as NorthStarReport;

const okFixture = (over: Partial<TtfvFixture> = {}): TtfvFixture => ({
  dataStatus: "ok",
  medianMinutes: 8.5,
  activation24h: 0.5,
  sampleSize: 7,
  asOf: AS_OF,
  note: "真实口径仅覆盖 opt-in install",
  ...over,
});

function renderCard() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <TtfvCard />
    </QueryClientProvider>,
  );
}

function renderDashboard() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/dashboard"]}>
        <Routes>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route
            path="/inbox"
            element={<div data-testid="inbox-probe">inbox</div>}
          />
          <Route path="/tasks/:id" element={<div>task-detail-mock</div>} />
          <Route
            path="/executors/:id"
            element={<div>executor-detail-mock</div>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** 驾驶舱其余三路数据源设为健康默认；各用例只覆写 getNorthStar 的 ttfv。 */
function mockAll() {
  mockedMetrics.getSummary.mockResolvedValue({
    totalTasks: 3,
    todayRuns: 12,
    totalExecutors: 2,
    onlineExecutors: 2,
    executions: { total: 120, success: 110, failed: 10, running: 1 },
    successRate: 91.7,
    avgDurationMs: 3200,
  } as never);
  mockedMetrics.getDailyTrend.mockResolvedValue([
    { date: daysAgo(1), success: 8, failed: 0, timeout: 0 },
  ] as never);
  mockedMetrics.getExecutorStats.mockResolvedValue([] as never);
  mockedMetrics.getRecentFailures.mockResolvedValue([] as never);
  mockedMetrics.getSchedulerMetrics.mockResolvedValue({
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
  } as never);
  mockedTasks.schedulerStats.mockResolvedValue({
    healthy: true,
    isLeader: true,
    activeTimers: 2,
    activeCronTasks: 1,
    runningTaskCount: 1,
    totalScheduledTasks: 3,
    uptime: 60,
  } as never);
  mockedAgent.inboxCounts.mockResolvedValue({
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
  } as never);
  mockedAgent.listPendingApprovals.mockResolvedValue({
    items: [],
    total: 3,
    sessionTotal: 2,
    truncated: false,
    degraded: false,
  } as never);
  mockedGetActivationStats.mockResolvedValue({
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
  } as never);
  mockedMetrics.getNorthStar.mockResolvedValue(reportWith(okFixture()));
}

const textOf = (id: string) => screen.getByTestId(id).textContent ?? "";

/** 四态互斥断言：命中的那一态存在，其余三态一律不存在。 */
function expectOnlyState(state: "gate-off" | "no-data" | "ok" | "unknown") {
  const all = ["gate-off", "no-data", "ok", "unknown"] as const;
  for (const s of all) {
    const node = screen.queryByTestId(`boss-ttfv-${s}`);
    if (s === state) expect(node).not.toBeNull();
    else expect(node).toBeNull();
  }
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.setItem(STORAGE_KEY, "zh");
  void setLanguage("zh");
  // 角色化 Dashboard 后，四牌同屏用例需 admin；其它卡片单测不受影响。
  useAuthStore.setState({ user: { id: 1, username: 'boss', role: 'admin' } as never });
  mockAll();
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({ user: null });
});

describe("ttfv-card — TTFV 三态标缺（第 2 级组件级）", () => {
  it("1. gate_off ⇒ 标缺态可见、不显示「0 分钟」、不显示中位数", async () => {
    // 即便后端误带数值，未启用态也不许上屏。
    mockedMetrics.getNorthStar.mockResolvedValue(
      reportWith(
        okFixture({
          dataStatus: "gate_off",
          medianMinutes: 8.5,
          activation24h: 0.5,
        }),
      ) as never,
    );

    renderCard();

    expect(await screen.findByTestId("boss-ttfv-gate-off")).toBeTruthy();
    expectOnlyState("gate-off");
    expect(screen.queryByTestId("boss-ttfv-median")).toBeNull();
    expect(textOf("boss-ttfv-card")).not.toContain("0 分钟");
    expect(textOf("boss-ttfv-card")).not.toContain("8.5 分钟");
  });

  it("2. no_data ⇒ 标缺态可见、无中位数", async () => {
    mockedMetrics.getNorthStar.mockResolvedValue(
      reportWith(
        okFixture({
          dataStatus: "no_data",
          medianMinutes: null,
          activation24h: null,
          sampleSize: 0,
          note: "授权后暂无可算样本",
        }),
      ) as never,
    );

    renderCard();

    expect(await screen.findByTestId("boss-ttfv-no-data")).toBeTruthy();
    expectOnlyState("no-data");
    expect(screen.queryByTestId("boss-ttfv-median")).toBeNull();
    expect(textOf("boss-ttfv-card")).not.toContain("0 分钟");
    expect(screen.getByTestId("boss-ttfv-sample-size")).toBeTruthy();
  });

  it("3. ok + median=8.5 + activation=0.5 ⇒ 有数据态、显示 8.5 与 50%", async () => {
    mockedMetrics.getNorthStar.mockResolvedValue(
      reportWith(okFixture()) as never,
    );

    renderCard();

    expect(await screen.findByTestId("boss-ttfv-ok")).toBeTruthy();
    expectOnlyState("ok");
    expect(screen.getByTestId("boss-ttfv-median").textContent).toContain(
      "8.5 分钟",
    );
    expect(screen.getByTestId("boss-ttfv-activation").textContent).toContain(
      "50%",
    );
    expect(screen.getByTestId("boss-ttfv-sample-size").textContent).toContain(
      "7",
    );
    expect(screen.getByTestId("boss-ttfv-as-of")).toBeTruthy();
  });

  it("4. ok + activation24h=null ⇒ 24h 单列标缺，绝不显示 0%", async () => {
    mockedMetrics.getNorthStar.mockResolvedValue(
      reportWith(
        okFixture({
          activation24h: null,
        }),
      ) as never,
    );

    renderCard();

    expect(await screen.findByTestId("boss-ttfv-ok")).toBeTruthy();
    const activation = screen.getByTestId("boss-ttfv-activation");
    expect(activation.textContent).toContain("样本未满 24h");
    expect(activation.textContent).not.toContain("0%");
    // 中位数照常显示，单列标缺不牵连其他列。
    expect(screen.getByTestId("boss-ttfv-median").textContent).toContain(
      "8.5 分钟",
    );
  });

  it("5. ttfv 字段整体缺席 ⇒ unknown、不崩、不显示任何数字", async () => {
    mockedMetrics.getNorthStar.mockResolvedValue(
      reportWith(undefined) as never,
    );

    renderCard();

    expect(await screen.findByTestId("boss-ttfv-unknown")).toBeTruthy();
    expectOnlyState("unknown");
    expect(screen.queryByTestId("boss-ttfv-median")).toBeNull();
    expect(screen.queryByTestId("boss-ttfv-activation")).toBeNull();
    expect(screen.queryByTestId("boss-ttfv-sample-size")).toBeNull();
    expect(textOf("boss-ttfv-card")).not.toContain("8.5");
    expect(textOf("boss-ttfv-card")).not.toContain("50%");
  });

  it("6. 矛盾防御：dataStatus=ok 但 medianMinutes=null ⇒ unknown", async () => {
    mockedMetrics.getNorthStar.mockResolvedValue(
      reportWith(
        okFixture({
          medianMinutes: null,
        }),
      ) as never,
    );

    renderCard();

    expect(await screen.findByTestId("boss-ttfv-unknown")).toBeTruthy();
    expectOnlyState("unknown");
    expect(screen.queryByTestId("boss-ttfv-ok")).toBeNull();
    expect(screen.queryByTestId("boss-ttfv-median")).toBeNull();
  });

  it("7. 驾驶舱四牌同屏：ttfv / approval / cost / north-star 都在 boss-cockpit 内", async () => {
    mockedMetrics.getNorthStar.mockResolvedValue(
      reportWith(okFixture()) as never,
    );

    renderDashboard();

    const cockpit = await screen.findByTestId("boss-cockpit");
    expect(await screen.findByTestId("boss-ttfv-card")).toBeTruthy();
    for (const id of [
      "boss-approval-card",
      "boss-cost-card",
      "north-star-card",
      "boss-ttfv-card",
    ]) {
      expect(cockpit.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }
    // 四态仍互斥，四牌同屏不改变标缺判定。
    expectOnlyState("ok");
  });

  it("8. 非法 dataStatus ⇒ unknown（严格字面量，不做大小写容错）", async () => {
    mockedMetrics.getNorthStar.mockResolvedValue(
      reportWith(
        okFixture({
          dataStatus: "bogus",
        }),
      ) as never,
    );

    renderCard();

    expect(await screen.findByTestId("boss-ttfv-unknown")).toBeTruthy();
    expectOnlyState("unknown");
  });

  it("9. 非有限 median（NaN）⇒ unknown（与 null 同档防御）", async () => {
    mockedMetrics.getNorthStar.mockResolvedValue(
      reportWith(
        okFixture({
          medianMinutes: Number.NaN,
        }),
      ) as never,
    );

    renderCard();

    expect(await screen.findByTestId("boss-ttfv-unknown")).toBeTruthy();
    expectOnlyState("unknown");
  });

  it("10. 读取失败 ⇒ unknown，不崩成空态也不显示 0", async () => {
    mockedMetrics.getNorthStar.mockRejectedValue(new Error("503"));

    renderCard();

    expect(await screen.findByTestId("boss-ttfv-unknown")).toBeTruthy();
    expectOnlyState("unknown");
    expect(textOf("boss-ttfv-card")).not.toContain("0 分钟");
  });

  it("11. note 在 gate_off 分支按后端原文上屏", async () => {
    mockedMetrics.getNorthStar.mockResolvedValue(
      reportWith(
        okFixture({
          dataStatus: "gate_off",
          note: "系统开关未启用",
        }),
      ) as never,
    );

    renderCard();

    expect(await screen.findByTestId("boss-ttfv-gate-off")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId("boss-ttfv-note").textContent).toContain(
        "系统开关未启用",
      );
    });
  });
});
