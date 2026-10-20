import { ConfigService } from "@nestjs/config";
import { register as globalRegister } from "prom-client";
import { PrometheusMetricsService } from "../prometheus-metrics.service";
import { SchedulerMetricsService } from "../../scheduler/scheduler-metrics.service";
import { SchedulerService } from "../../scheduler/scheduler.service";
import { ExecutionCallbackMetricsService } from "../../task/execution-callback-metrics.service";
// 可观测性补齐轮：运行时计数器模块级入口（Task/Notification 埋点的同一实例）
import { recordRuntime, resetRuntimeMetrics } from "../runtime-metrics-entry";
// R33-A1: 通知投递结果值域登记（四值）——本 spec 独立钉住契约与基数
import { RUNTIME_NOTIFICATION_RESULTS } from "../runtime-metrics";

/**
 * R7: prom-client exposition 端点测试。
 * 每个用例构造独立的 PrometheusMetricsService（内部独立 Registry），
 * 既验证映射正确性，也验证不污染 prom-client 全局 registry。
 */
describe("PrometheusMetricsService (R7 prom-client exposition)", () => {
  let schedulerMetrics: SchedulerMetricsService;
  let callbackMetrics: ExecutionCallbackMetricsService;
  let schedulerService: { getQueueDepth: jest.Mock };

  const QUEUE_EMPTY = {
    waiting: 0,
    active: 0,
    delayed: 0,
    failed: 0,
    completed: 0,
  };
  const QUEUE_DOWN = {
    waiting: null,
    active: null,
    delayed: null,
    failed: null,
    completed: null,
  };

  const makeService = (
    opts: {
      enabled?: boolean;
      defaultMetrics?: boolean;
      /** OBS-05：注入伪 ExecutorRepository（缺省 undefined = 不注入） */
      executorRepository?: Record<string, unknown>;
    } = {},
  ) => {
    const config = {
      get: jest.fn((key: string) => {
        if (key === "metrics.prometheus.enabled") return opts.enabled ?? true;
        if (key === "metrics.prometheus.defaultMetricsEnabled")
          return opts.defaultMetrics ?? true;
        return undefined;
      }),
    };
    schedulerMetrics = new SchedulerMetricsService();
    callbackMetrics = new ExecutionCallbackMetricsService();
    schedulerService = {
      getQueueDepth: jest.fn().mockResolvedValue({ ...QUEUE_EMPTY }),
    };
    return new PrometheusMetricsService(
      config as unknown as ConfigService,
      schedulerMetrics,
      schedulerService as unknown as SchedulerService,
      callbackMetrics,
      opts.executorRepository as never,
    );
  };

  /** 喂入一轮完整的计数事件（每个计数器至少一次） */
  const feedAllCounters = (m: SchedulerMetricsService) => {
    m.recordTick(10);
    m.recordTick(20);
    m.recordTriggerClaimed();
    m.recordTriggerClaimed();
    m.recordTriggerClaimed();
    m.recordTriggerSkippedLockHeld();
    m.recordTriggerSkippedDbClaim();
    m.recordTriggerSkippedInactive();
    m.recordTriggerSkippedBlockStrategy();
    m.recordTriggerSkippedMaintenance();
    m.recordTriggerFailed();
    m.recordTriggerFailed();
    m.recordDependencyTriggerClaimed();
    m.recordDependencyTriggerClaimed();
    m.recordDependencyTriggerSkipped();
  };

  it("maps every SchedulerMetricsService counter to its prometheus series", async () => {
    const svc = makeService();
    feedAllCounters(schedulerMetrics);

    const text = await svc.render();

    expect(text).toContain("# TYPE autoflow_scheduler_ticks_total counter");
    expect(text).toContain("autoflow_scheduler_ticks_total 2");
    expect(text).toContain("autoflow_scheduler_tick_duration_ms_total 30");
    expect(text).toContain("autoflow_scheduler_last_tick_duration_ms 20");
    expect(text).toContain(
      'autoflow_scheduler_triggers_total{result="claimed"} 3',
    );
    expect(text).toContain(
      'autoflow_scheduler_triggers_total{result="failed"} 2',
    );
    expect(text).toContain(
      'autoflow_scheduler_dependency_triggers_total{result="claimed"} 2',
    );
    expect(text).toContain(
      'autoflow_scheduler_dependency_triggers_total{result="skipped"} 1',
    );
  });

  // A-2（审计 FEAT-06）：五个 skip reason 全部透出——含维护窗口
  // （triggersSkippedMaintenance），此前渲染缺失该 reason。
  it("splits the five trigger skip reasons into label series", async () => {
    const svc = makeService();
    feedAllCounters(schedulerMetrics);

    const text = await svc.render();

    expect(text).toContain(
      'autoflow_scheduler_triggers_skipped_total{reason="lock_held"} 1',
    );
    expect(text).toContain(
      'autoflow_scheduler_triggers_skipped_total{reason="db_claim"} 1',
    );
    expect(text).toContain(
      'autoflow_scheduler_triggers_skipped_total{reason="inactive"} 1',
    );
    expect(text).toContain(
      'autoflow_scheduler_triggers_skipped_total{reason="block_strategy"} 1',
    );
    expect(text).toContain(
      'autoflow_scheduler_triggers_skipped_total{reason="maintenance"} 1',
    );
  });

  it("keeps all five trigger skip reason series present with 0 baselines (series-set stability)", async () => {
    const svc = makeService();
    const text = await svc.render();
    for (const reason of [
      "lock_held",
      "db_claim",
      "inactive",
      "block_strategy",
      "maintenance",
    ]) {
      expect(text).toContain(
        `autoflow_scheduler_triggers_skipped_total{reason="${reason}"} 0`,
      );
    }
  });

  // N32 (round-9): callback 401 分类观测 series——对齐既有 reset+inc 快照模式。
  it("maps callback auth outcomes to autoflow_execution_callback_auth_total (N32)", async () => {
    const svc = makeService();
    callbackMetrics.recordAuthResult("ok");
    callbackMetrics.recordAuthResult("ok");
    callbackMetrics.recordAuthResult("v1_expired");
    callbackMetrics.recordAuthResult("v1_binding_mismatch");
    callbackMetrics.recordAuthResult("v1_bad_signature");
    callbackMetrics.recordAuthResult("legacy_shared_invalid");
    callbackMetrics.recordAuthResult("missing_token");
    callbackMetrics.recordAuthResult("bad_address");

    const text = await svc.render();

    expect(text).toContain(
      "# TYPE autoflow_execution_callback_auth_total counter",
    );
    expect(text).toContain(
      'autoflow_execution_callback_auth_total{result="ok"} 2',
    );
    expect(text).toContain(
      'autoflow_execution_callback_auth_total{result="v1_expired"} 1',
    );
    expect(text).toContain(
      'autoflow_execution_callback_auth_total{result="v1_binding_mismatch"} 1',
    );
    expect(text).toContain(
      'autoflow_execution_callback_auth_total{result="v1_bad_signature"} 1',
    );
    expect(text).toContain(
      'autoflow_execution_callback_auth_total{result="legacy_shared_invalid"} 1',
    );
    expect(text).toContain(
      'autoflow_execution_callback_auth_total{result="missing_token"} 1',
    );
    expect(text).toContain(
      'autoflow_execution_callback_auth_total{result="bad_address"} 1',
    );
  });

  it("keeps all seven callback auth result series present (0 baseline) and monotonic across scrapes (N32)", async () => {
    const svc = makeService();
    const first = await svc.render();
    for (const result of [
      "ok",
      "v1_expired",
      "v1_binding_mismatch",
      "v1_bad_signature",
      "legacy_shared_invalid",
      "missing_token",
      "bad_address",
    ]) {
      expect(first).toContain(
        `autoflow_execution_callback_auth_total{result="${result}"} 0`,
      );
    }

    callbackMetrics.recordAuthResult("v1_expired");
    const second = await svc.render();
    expect(second).toContain(
      'autoflow_execution_callback_auth_total{result="v1_expired"} 1',
    );
    // 同一实例重复抓取不产生残留的双 series
    expect(
      second.match(
        /autoflow_execution_callback_auth_total\{result="v1_expired"\} \d+/g,
      ),
    ).toHaveLength(1);
  });

  // 可观测性补齐轮：4 个运行时计数器（执行结果成败 / SSE 并发拒绝 /
  // 通知投递结果 / callback 业务结果分类）——埋点走模块级入口
  // recordRuntime（TaskService / NotificationService 的同一入口），
  // 本 describe 只验证 snapshot→render 映射与 series 稳定性。
  describe("runtime counters (execution result / SSE reject / notification / callback business)", () => {
    // 模块级计数跨用例/文件共享，进入与离开本组用例各显式重置一次。
    beforeEach(() => {
      resetRuntimeMetrics();
    });
    afterEach(() => {
      resetRuntimeMetrics();
    });

    it("renders zero baselines for every known series before any observation", async () => {
      const svc = makeService();
      const text = await svc.render();
      for (const status of ["success", "failed", "timeout"]) {
        expect(text).toContain(
          `autoflow_execution_result_total{status="${status}"} 0`,
        );
      }
      expect(text).toContain("autoflow_sse_streams_rejected_total 0");
      // R33-A1: 通知投递结果值域 = 四值。这里**写死字面量**而非常量——
      // 常量被删值时本用例必须红（契约独立于实现，才是防漂移钉子）。
      for (const channel of [
        "email",
        "slack",
        "dingtalk",
        "wecom",
        "webhook",
        "feishu",
      ]) {
        for (const result of ["success", "failure", "blocked", "skipped"]) {
          expect(text).toContain(
            `autoflow_notification_delivery_total{channel="${channel}",result="${result}"} 0`,
          );
        }
      }
      // 基数钉子：6 渠道 × 4 值 = 24 条 0 值 series（R33-A1 之前是 12）。
      // 多登记/漏登记都会改变这个数字（漏登记 → 新值无基线 → 告警「无数据」）。
      expect(
        text.match(/autoflow_notification_delivery_total\{/g),
      ).toHaveLength(24);
      // 登记表与上面的契约字面量必须完全一致（两个方向都钉）
      expect([...RUNTIME_NOTIFICATION_RESULTS].sort()).toEqual([
        "blocked",
        "failure",
        "skipped",
        "success",
      ]);
      for (const result of [
        "accepted",
        "duplicate",
        "not_found",
        "address_mismatch",
        "address_mismatch_missing_address",
        "error",
      ]) {
        expect(text).toContain(
          `autoflow_callback_business_total{result="${result}"} 0`,
        );
      }
      // ARCH-30: AI 分析结果三分类——同一 0 值基线契约（series 集合稳定，
      // rate() 自首次计数前即可计算）。
      for (const result of ["ok", "fail", "skipped"]) {
        expect(text).toContain(
          `autoflow_ai_analysis_total{result="${result}"} 0`,
        );
      }
    });

    // BUG-01（N51 收口）：reload-config 401 重签重试计数器——同一 recordRuntime
    // → render 快照模式，两个 result 标签均参与 0 基线与观测映射。
    it("renders zero baselines and observed values for autoflow_push_auth_retry_total (BUG-01)", async () => {
      const svc = makeService();
      const baseline = await svc.render();
      expect(baseline).toContain(
        "# TYPE autoflow_push_auth_retry_total counter",
      );
      expect(baseline).toContain(
        'autoflow_push_auth_retry_total{result="reissued_success"} 0',
      );
      expect(baseline).toContain(
        'autoflow_push_auth_retry_total{result="still_unauthorized"} 0',
      );

      recordRuntime("autoflow_push_auth_retry_total", {
        result: "reissued_success",
      });
      recordRuntime("autoflow_push_auth_retry_total", {
        result: "still_unauthorized",
      });
      recordRuntime("autoflow_push_auth_retry_total", {
        result: "still_unauthorized",
      });

      const text = await svc.render();
      expect(text).toContain(
        'autoflow_push_auth_retry_total{result="reissued_success"} 1',
      );
      expect(text).toContain(
        'autoflow_push_auth_retry_total{result="still_unauthorized"} 2',
      );
      // 同一实例重复抓取不产生残留的双 series
      expect(
        text.match(
          /autoflow_push_auth_retry_total\{result="still_unauthorized"\} \d+/g,
        ),
      ).toHaveLength(1);
    });

    it("maps runtime observations to prometheus counter series", async () => {
      const svc = makeService();
      recordRuntime("autoflow_execution_result_total", { status: "failed" });
      recordRuntime("autoflow_execution_result_total", { status: "failed" });
      recordRuntime("autoflow_execution_result_total", { status: "success" });
      recordRuntime("autoflow_sse_streams_rejected_total");
      recordRuntime("autoflow_sse_streams_rejected_total");
      recordRuntime("autoflow_notification_delivery_total", {
        channel: "email",
        result: "success",
      });
      recordRuntime("autoflow_notification_delivery_total", {
        channel: "webhook",
        result: "failure",
      });
      recordRuntime("autoflow_callback_business_total", { result: "accepted" });

      const text = await svc.render();
      expect(text).toContain("# TYPE autoflow_execution_result_total counter");
      expect(text).toContain(
        'autoflow_execution_result_total{status="failed"} 2',
      );
      expect(text).toContain(
        'autoflow_execution_result_total{status="success"} 1',
      );
      expect(text).toContain("autoflow_sse_streams_rejected_total 2");
      expect(text).toContain(
        'autoflow_notification_delivery_total{channel="email",result="success"} 1',
      );
      expect(text).toContain(
        'autoflow_notification_delivery_total{channel="webhook",result="failure"} 1',
      );
      expect(text).toContain(
        'autoflow_callback_business_total{result="accepted"} 1',
      );
    });

    it("keeps runtime series present and monotonic across scrapes", async () => {
      const svc = makeService();
      const first = await svc.render();
      expect(first).toContain(
        'autoflow_callback_business_total{result="not_found"} 0',
      );
      recordRuntime("autoflow_callback_business_total", {
        result: "not_found",
      });
      recordRuntime("autoflow_callback_business_total", {
        result: "not_found",
      });
      const second = await svc.render();
      expect(second).toContain(
        'autoflow_callback_business_total{result="not_found"} 2',
      );
      expect(
        second.match(
          /autoflow_callback_business_total\{result="not_found"\} \d+/g,
        ),
      ).toHaveLength(1);
    });

    it("ignores unknown counter names (record never throws)", async () => {
      const svc = makeService();
      recordRuntime("autoflow_not_a_real_metric" as never, {} as never);
      expect(await svc.render()).not.toContain("autoflow_not_a_real_metric");
    });
  });

  it("exposes queue depth gauges and autoflow_queue_up=1 when Redis is readable", async () => {
    const svc = makeService();
    schedulerService.getQueueDepth.mockResolvedValue({
      waiting: 4,
      active: 2,
      delayed: 1,
      failed: 0,
      completed: 9,
    });

    const text = await svc.render();

    expect(text).toContain('autoflow_queue_depth{state="waiting"} 4');
    expect(text).toContain('autoflow_queue_depth{state="active"} 2');
    expect(text).toContain('autoflow_queue_depth{state="delayed"} 1');
    expect(text).toContain('autoflow_queue_depth{state="failed"} 0');
    expect(text).toContain('autoflow_queue_depth{state="completed"} 9');
    expect(text).toContain("autoflow_queue_up 1");
  });

  it("zeros queue depth gauges and sets autoflow_queue_up=0 when Redis is down", async () => {
    const svc = makeService();
    schedulerService.getQueueDepth.mockResolvedValue({ ...QUEUE_DOWN });

    const text = await svc.render();

    expect(text).toContain("autoflow_queue_up 0");
    for (const state of [
      "waiting",
      "active",
      "delayed",
      "failed",
      "completed",
    ]) {
      expect(text).toContain(`autoflow_queue_depth{state="${state}"} 0`);
    }
  });

  it("keeps counter values monotonic across scrapes (snapshot is source of truth)", async () => {
    const svc = makeService();
    schedulerMetrics.recordTick(5);
    const first = await svc.render();
    expect(first).toContain("autoflow_scheduler_ticks_total 1");

    schedulerMetrics.recordTick(5);
    const second = await svc.render();
    expect(second).toContain("autoflow_scheduler_ticks_total 2");
    // 同一实例重复抓取不产生残留的双 series
    expect(second.match(/autoflow_scheduler_ticks_total \d+/g)).toHaveLength(1);
  });

  it("serializes concurrent renders so counters never regress (N31)", async () => {
    const svc = makeService();
    schedulerMetrics.recordTick(5);
    // 两个 render 并发发起：共享同一次 in-flight 重建（而不是交错 reset），
    // 两次输出必须相等且与串行语义一致。
    const [a, b] = await Promise.all([svc.render(), svc.render()]);
    expect(a).toBe(b);
    expect(a).toContain("autoflow_scheduler_ticks_total 1");
  });

  it("collects process default metrics unless disabled by config", async () => {
    const withDefaults = makeService();
    expect(await withDefaults.render()).toContain(
      "process_cpu_user_seconds_total",
    );

    const withoutDefaults = makeService({ defaultMetrics: false });
    expect(await withoutDefaults.render()).not.toContain(
      "process_cpu_user_seconds_total",
    );
  });

  it("exposes the registry contentType for the response header", () => {
    const svc = makeService();
    expect(svc.contentType).toContain("text/plain");
  });

  it("never writes into the prom-client global registry (test isolation)", async () => {
    const svc = makeService();
    feedAllCounters(schedulerMetrics);
    await svc.render();

    const globalText = await globalRegister.metrics();
    expect(globalText).not.toContain("autoflow_scheduler_ticks_total");
  });

  it("enabled reflects metrics.prometheus.enabled config (default true)", () => {
    expect(makeService().enabled).toBe(true);
    expect(makeService({ enabled: false }).enabled).toBe(false);
  });
});

// CORE-06：调度触发延迟直方图——bucket(le) 累计 + sum/count。
// 自包含作用域（外层 describe 的 makeService 会把 SchedulerMetricsService
// 注入服务——这里复刻同样的构造链，避免跨作用域引用）。
describe("trigger latency histogram (CORE-06)", () => {
  const QUEUE_EMPTY = {
    waiting: 0,
    active: 0,
    delayed: 0,
    failed: 0,
    completed: 0,
  };

  const makeServiceWithMetrics = () => {
    const config = { get: jest.fn(() => true) };
    const schedulerMetrics = new SchedulerMetricsService();
    const callbackMetrics = new ExecutionCallbackMetricsService();
    const svc = new PrometheusMetricsService(
      config as unknown as ConfigService,
      schedulerMetrics,
      {
        getQueueDepth: jest.fn().mockResolvedValue({ ...QUEUE_EMPTY }),
      } as unknown as SchedulerService,
      callbackMetrics,
    );
    return { svc, schedulerMetrics };
  };

  it("renders bucket/sum/count series with stable 0 baselines", async () => {
    const { svc } = makeServiceWithMetrics();
    const out = await svc.render();
    expect(out).toContain(
      `autoflow_scheduler_trigger_latency_ms_bucket{le="10"} 0`,
    );
    expect(out).toContain(
      `autoflow_scheduler_trigger_latency_ms_bucket{le="+Inf"} 0`,
    );
    expect(out).toContain("autoflow_scheduler_trigger_latency_ms_sum 0");
    expect(out).toContain("autoflow_scheduler_trigger_latency_ms_count 0");
  });

  it("renders observed latencies into cumulative buckets", async () => {
    const { svc, schedulerMetrics } = makeServiceWithMetrics();
    schedulerMetrics.recordTriggerLatency(30);
    schedulerMetrics.recordTriggerLatency(4000);

    const out = await svc.render();
    expect(out).toContain(
      `autoflow_scheduler_trigger_latency_ms_bucket{le="50"} 1`,
    );
    expect(out).toContain(
      `autoflow_scheduler_trigger_latency_ms_bucket{le="+Inf"} 2`,
    );
    expect(out).toContain("autoflow_scheduler_trigger_latency_ms_count 2");
  });

  // A-1（审计 CORE-06 渲染口径）：*_bucket 必须是**累计**计数（Prometheus
  // 累积直方图不变量，histogram_quantile/rate 直接消费各 le 的绝对值）。
  // 30ms + 4000ms 两样本下：le=100 应为 1（含 30ms）、le=5000 应为 2（全部）。
  // 旧实现逐桶 inc(cum-prevCum) 写边际值——le=50/le=5000 恰好边际=累计属巧合
  // 路径，中间桶（如 le=100）全错。
  it("writes cumulative counts per le bucket, not per-bucket deltas (A-1)", async () => {
    const { svc, schedulerMetrics } = makeServiceWithMetrics();
    schedulerMetrics.recordTriggerLatency(30);
    schedulerMetrics.recordTriggerLatency(4000);

    const out = await svc.render();
    // 全边界逐一锚定：le 单调不减、末桶（5000）= +Inf = count
    const expected: Array<[string, number]> = [
      ["10", 0],
      ["50", 1],
      ["100", 1],
      ["250", 1],
      ["500", 1],
      ["1000", 1],
      ["2500", 1],
      ["5000", 2],
    ];
    for (const [le, value] of expected) {
      expect(out).toContain(
        `autoflow_scheduler_trigger_latency_ms_bucket{le="${le}"} ${value}`,
      );
    }
    expect(out).toContain(
      `autoflow_scheduler_trigger_latency_ms_bucket{le="+Inf"} 2`,
    );
    expect(out).toContain("autoflow_scheduler_trigger_latency_ms_count 2");
  });

  it("keeps buckets monotonic across scrapes when later samples fall into smaller buckets (A-1)", async () => {
    const { svc, schedulerMetrics } = makeServiceWithMetrics();
    schedulerMetrics.recordTriggerLatency(4000);
    const first = await svc.render();
    expect(first).toContain(
      `autoflow_scheduler_trigger_latency_ms_bucket{le="5000"} 1`,
    );

    schedulerMetrics.recordTriggerLatency(30);
    const second = await svc.render();
    // 新样本落入更小的桶：累计口径下大桶计数不变、小桶递增——
    // 边际值写入会让 le=5000 出现 0（回退），违反 counter 单调不变量。
    expect(second).toContain(
      `autoflow_scheduler_trigger_latency_ms_bucket{le="5000"} 2`,
    );
    expect(second).toContain(
      `autoflow_scheduler_trigger_latency_ms_bucket{le="50"} 1`,
    );
    expect(second).toContain(
      `autoflow_scheduler_trigger_latency_ms_bucket{le="+Inf"} 2`,
    );
  });
});

// OBS-05（容量水位四件套）：PG 连接池水位 + executor 磁盘水位。
// 自包含作用域：用 mock 驱动对象断言取数路径（repo.manager.connection.driver
// .master = pg.Pool 形状的最小面），不触碰真实 DataSource。
describe("capacity water-level gauges (OBS-05)", () => {
  const QUEUE_EMPTY = {
    waiting: 0,
    active: 0,
    delayed: 0,
    failed: 0,
    completed: 0,
  };

  /** pg.Pool 形状的最小 mock（prometheus-metrics.service.ts PgPoolLike） */
  const makePgPool = (
    over: Partial<{
      totalCount: number;
      idleCount: number;
      waitingCount: number;
      max: number;
    }>,
  ) => ({
    totalCount: over.totalCount ?? 0,
    idleCount: over.idleCount ?? 0,
    waitingCount: over.waitingCount ?? 0,
    options: { max: over.max },
  });

  const makeExecutorRepository = (over: {
    master?: ReturnType<typeof makePgPool> | undefined;
    onlineRows?: Array<{ address: string; diskUsage: number | null }>;
    find?: jest.Mock;
  }) => {
    const find =
      over.find ?? jest.fn().mockResolvedValue(over.onlineRows ?? []);
    return {
      manager: { connection: { driver: { master: over.master } } },
      find,
    };
  };

  const makeService = (executorRepository?: Record<string, unknown>) => {
    const config = { get: jest.fn(() => true) };
    const svc = new PrometheusMetricsService(
      config as unknown as ConfigService,
      new SchedulerMetricsService(),
      {
        getQueueDepth: jest.fn().mockResolvedValue({ ...QUEUE_EMPTY }),
      } as unknown as SchedulerService,
      new ExecutionCallbackMetricsService(),
      executorRepository as never,
    );
    return svc;
  };

  it("renders PG pool water level from the pg.Pool handle (active = totalCount - idleCount)", async () => {
    // 20 容量：13 活跃（totalCount 15 - idle 2）、2 空闲、1 排队等待
    const repo = makeExecutorRepository({
      master: makePgPool({
        totalCount: 15,
        idleCount: 2,
        waitingCount: 1,
        max: 20,
      }),
    });
    const out = await makeService(repo).render();

    expect(out).toContain("# TYPE autoflow_db_pool_max_connections gauge");
    expect(out).toContain("autoflow_db_pool_max_connections 20");
    expect(out).toContain("autoflow_db_pool_active_connections 13");
    expect(out).toContain("autoflow_db_pool_idle_connections 2");
    expect(out).toContain("autoflow_db_pool_waiting_requests 1");
  });

  it("zeros PG pool water level when the pool handle is unreachable (max=0 marks unreadable)", async () => {
    // 与既有 queue_down 用例同一姿态：句柄不可达 → 全 0，
    // 抓取方以 max==0 区分"真空闲"与"不可读"，不参与利用率告警。
    const noRepo = await makeService(undefined).render();
    expect(noRepo).toContain("autoflow_db_pool_max_connections 0");
    expect(noRepo).toContain("autoflow_db_pool_active_connections 0");
    expect(noRepo).toContain("autoflow_db_pool_idle_connections 0");
    expect(noRepo).toContain("autoflow_db_pool_waiting_requests 0");

    const noMaster = await makeService(
      makeExecutorRepository({ master: undefined }),
    ).render();
    expect(noMaster).toContain("autoflow_db_pool_max_connections 0");
    expect(noMaster).toContain("autoflow_db_pool_active_connections 0");
  });

  it("clamps active to 0 when the pool reports idle > totalCount (defensive)", async () => {
    const repo = makeExecutorRepository({
      master: makePgPool({
        totalCount: 1,
        idleCount: 3,
        waitingCount: 0,
        max: 10,
      }),
    });
    const out = await makeService(repo).render();
    expect(out).toContain("autoflow_db_pool_active_connections 0");
    expect(out).toContain("autoflow_db_pool_idle_connections 3");
  });

  it("renders executor disk water level per online executor and drops stale series on refresh", async () => {
    const repo = makeExecutorRepository({
      onlineRows: [
        { address: "10.0.0.1:3002", diskUsage: 42.5 },
        { address: "10.0.0.2:3002", diskUsage: 91 },
      ],
    });
    const svc = makeService(repo);
    const first = await svc.render();
    expect(first).toContain(
      "# TYPE autoflow_executor_disk_usage_percent gauge",
    );
    expect(first).toContain(
      'autoflow_executor_disk_usage_percent{executor="10.0.0.1:3002"} 42.5',
    );
    expect(first).toContain(
      'autoflow_executor_disk_usage_percent{executor="10.0.0.2:3002"} 91',
    );

    // 执行器下线（find 结果不再含 10.0.0.1）→ 下一轮抓取 series 消失
    (repo.find as jest.Mock).mockResolvedValue([
      { address: "10.0.0.2:3002", diskUsage: 91 },
    ]);
    const second = await svc.render();
    expect(second).not.toContain('executor="10.0.0.1:3002"');
    expect(second).toContain(
      'autoflow_executor_disk_usage_percent{executor="10.0.0.2:3002"} 91',
    );
  });

  it("keeps the previous disk series when the repository query fails (staleness over disappearance)", async () => {
    const repo = makeExecutorRepository({
      onlineRows: [{ address: "10.0.0.1:3002", diskUsage: 42.5 }],
    });
    const svc = makeService(repo);
    expect(await svc.render()).toContain(
      'autoflow_executor_disk_usage_percent{executor="10.0.0.1:3002"} 42.5',
    );

    (repo.find as jest.Mock).mockRejectedValue(new Error("db blip"));
    const out = await svc.render();
    expect(out).toContain(
      'autoflow_executor_disk_usage_percent{executor="10.0.0.1:3002"} 42.5',
    );
  });

  it("omits legacy executors that never reported diskUsage (no fabricated 0)", async () => {
    const repo = makeExecutorRepository({
      onlineRows: [{ address: "legacy-node", diskUsage: null }],
    });
    const out = await makeService(repo).render();
    expect(out).not.toContain('executor="legacy-node"');
    expect(out).not.toContain("autoflow_executor_disk_usage_percent{");
  });

  it("renders disk water level only for online executors (offline excluded by the query)", async () => {
    // where: { status: ONLINE } 契约由 mock find 直接体现：注入的行即
    // 查询结果；这里复核 find 调用参数携带 ONLINE 过滤（取数路径断言）。
    const find = jest.fn().mockResolvedValue([]);
    const repo = makeExecutorRepository({ find });
    await makeService(repo).render();
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "online" },
        select: { address: true, diskUsage: true },
      }),
    );
  });
});

// ── HTTP RED（本轮新增）────────────────────────────────────────────────────
// 自包含作用域：拦截器只写进程内快照，这里直接调 recordHttpRequest 驱动
// snapshot → exposition 的映射（拦截器自身的判定在
// common/interceptors/__tests__/http-metrics.interceptor.spec.ts 里测）。
describe("HTTP RED metrics (autoflow_http_*)", () => {
  const QUEUE_EMPTY = {
    waiting: 0,
    active: 0,
    delayed: 0,
    failed: 0,
    completed: 0,
  };

  const makeService = () => {
    const config = { get: jest.fn(() => true) };
    return new PrometheusMetricsService(
      config as unknown as ConfigService,
      new SchedulerMetricsService(),
      {
        getQueueDepth: jest.fn().mockResolvedValue({ ...QUEUE_EMPTY }),
      } as unknown as SchedulerService,
      new ExecutionCallbackMetricsService(),
    );
  };

  it("declares counter/gauge types for the whole RED surface", async () => {
    const out = await makeService().render();
    expect(out).toContain("# TYPE autoflow_http_requests_total counter");
    expect(out).toContain(
      "# TYPE autoflow_http_request_duration_ms_sum counter",
    );
    expect(out).toContain(
      "# TYPE autoflow_http_request_duration_ms_count counter",
    );
    expect(out).toContain(
      "# TYPE autoflow_http_request_duration_ms_bucket counter",
    );
    // 本仓没有 prom-client Histogram——RED 直方图沿用三个手写 Counter
    expect(out).not.toContain(
      "# TYPE autoflow_http_request_duration_ms histogram",
    );
  });

  it("renders method / route / status_class label series", async () => {
    const svc = makeService();
    svc.recordHttpRequest("GET", "/api/tasks/:id", 200, 12);
    svc.recordHttpRequest("GET", "/api/tasks/:id", 200, 30);
    svc.recordHttpRequest("POST", "/api/tasks", 201, 40);

    const out = await svc.render();
    expect(out).toContain(
      'autoflow_http_requests_total{method="GET",route="/api/tasks/:id",status_class="2xx"} 2',
    );
    expect(out).toContain(
      'autoflow_http_requests_total{method="POST",route="/api/tasks",status_class="2xx"} 1',
    );
    expect(out).toContain(
      'autoflow_http_request_duration_ms_count{method="GET",route="/api/tasks/:id",status_class="2xx"} 2',
    );
    // 12 + 30
    expect(out).toContain(
      'autoflow_http_request_duration_ms_sum{method="GET",route="/api/tasks/:id",status_class="2xx"} 42',
    );
  });

  it("keeps 4xx and 5xx in distinguishable status_class series (error rate)", async () => {
    const svc = makeService();
    svc.recordHttpRequest("GET", "/api/tasks/:id", 404, 3);
    svc.recordHttpRequest("GET", "/api/tasks/:id", 500, 4);
    svc.recordHttpRequest("GET", "/api/tasks/:id", 503, 5);
    svc.recordHttpRequest("GET", "/api/tasks/:id", 301, 1);
    // 非标准状态码（响应未写 statusCode）归 other，不伪造 2xx/5xx
    svc.recordHttpRequest("GET", "/api/tasks/:id", 0, 1);

    const out = await svc.render();
    expect(out).toContain(
      'autoflow_http_requests_total{method="GET",route="/api/tasks/:id",status_class="4xx"} 1',
    );
    expect(out).toContain(
      'autoflow_http_requests_total{method="GET",route="/api/tasks/:id",status_class="5xx"} 2',
    );
    expect(out).toContain(
      'autoflow_http_requests_total{method="GET",route="/api/tasks/:id",status_class="3xx"} 1',
    );
    expect(out).toContain(
      'autoflow_http_requests_total{method="GET",route="/api/tasks/:id",status_class="other"} 1',
    );
  });

  it("writes cumulative histogram buckets plus a +Inf bucket equal to count", async () => {
    const svc = makeService();
    svc.recordHttpRequest("GET", "/api/health", 200, 3);
    svc.recordHttpRequest("GET", "/api/health", 200, 120);
    svc.recordHttpRequest("GET", "/api/health", 200, 9000);

    const out = await svc.render();
    const at = (le: string) =>
      `autoflow_http_request_duration_ms_bucket{method="GET",route="/api/health",status_class="2xx",le="${le}"}`;
    // 累计口径：le=5 只有 3ms；le=250 含 3+120；le=5000 仍只有前两个；
    // +Inf 收口全部 3 个样本。
    expect(out).toContain(`${at("5")} 1`);
    expect(out).toContain(`${at("10")} 1`);
    expect(out).toContain(`${at("100")} 1`);
    expect(out).toContain(`${at("250")} 2`);
    expect(out).toContain(`${at("5000")} 2`);
    expect(out).toContain(`${at("+Inf")} 3`);
    expect(out).toContain(
      'autoflow_http_request_duration_ms_count{method="GET",route="/api/health",status_class="2xx"} 3',
    );
  });

  it("keeps counter series monotonic across scrapes and does not duplicate series", async () => {
    const svc = makeService();
    svc.recordHttpRequest("GET", "/api/tasks/:id", 200, 10);
    const first = await svc.render();
    expect(first).toContain(
      'autoflow_http_requests_total{method="GET",route="/api/tasks/:id",status_class="2xx"} 1',
    );

    svc.recordHttpRequest("GET", "/api/tasks/:id", 200, 10);
    const second = await svc.render();
    expect(second).toContain(
      'autoflow_http_requests_total{method="GET",route="/api/tasks/:id",status_class="2xx"} 2',
    );
    expect(
      second.match(
        /autoflow_http_requests_total\{method="GET",route="\/api\/tasks\/:id",status_class="2xx"\} \d+/g,
      ),
    ).toHaveLength(1);
  });

  it("does not fabricate series for label combinations never observed", async () => {
    const svc = makeService();
    svc.recordHttpRequest("GET", "/api/tasks/:id", 200, 10);
    const out = await svc.render();
    // 未观测过的路由/状态类不铺 0 基线（路由集合由代码决定，基数有界）
    expect(out).not.toContain('route="/api/executors"');
    expect(out).not.toContain('status_class="5xx"');
  });

  it("clamps a negative/non-finite duration instead of poisoning the histogram", async () => {
    const svc = makeService();
    svc.recordHttpRequest("GET", "/api/health", 200, -5);
    svc.recordHttpRequest("GET", "/api/health", 200, Number.NaN);
    const out = await svc.render();
    expect(out).toContain(
      'autoflow_http_request_duration_ms_bucket{method="GET",route="/api/health",status_class="2xx",le="5"} 2',
    );
    expect(out).toContain(
      'autoflow_http_request_duration_ms_sum{method="GET",route="/api/health",status_class="2xx"} 0',
    );
  });
});

// ── 执行器 fleet 水位（本轮新增）──────────────────────────────────────────
// 解锁 AllExecutorsOffline 告警的两个 gauge。核心纪律与 OBS-05 磁盘水位一致：
// **DB 抖动保留上一轮值，绝不 reset 成 0**——否则每次 PG 毛刺都会误报
// 「全部执行器离线」。
describe("executor fleet gauges (autoflow_executors_online / _total)", () => {
  const QUEUE_EMPTY = {
    waiting: 0,
    active: 0,
    delayed: 0,
    failed: 0,
    completed: 0,
  };

  /**
   * count() 的 mock：按 where 分派——带 status 过滤的算 online，不带的是 total。
   * `count` 可被单个用例替换（用于模拟 DB 抖动）。
   */
  const makeFleetRepo = (counts: { total: number; online: number }) => {
    const count = jest.fn((options?: { where?: { status?: string } }) =>
      Promise.resolve(options?.where?.status ? counts.online : counts.total),
    );
    return { count } as unknown as { count: jest.Mock };
  };

  const makeService = (executorRepository?: Record<string, unknown>) => {
    const config = { get: jest.fn(() => true) };
    return new PrometheusMetricsService(
      config as unknown as ConfigService,
      new SchedulerMetricsService(),
      {
        getQueueDepth: jest.fn().mockResolvedValue({ ...QUEUE_EMPTY }),
      } as unknown as SchedulerService,
      new ExecutionCallbackMetricsService(),
      executorRepository as never,
    );
  };

  it("renders online and total as gauges from the Executor repository", async () => {
    const repo = makeFleetRepo({ total: 5, online: 3 });
    const out = await makeService(repo).render();

    expect(out).toContain("# TYPE autoflow_executors_online gauge");
    expect(out).toContain("# TYPE autoflow_executors_total gauge");
    expect(out).toContain("autoflow_executors_online 3");
    expect(out).toContain("autoflow_executors_total 5");
  });

  it("queries ONLINE for the online gauge and no filter for the total gauge", async () => {
    const repo = makeFleetRepo({ total: 2, online: 2 });
    await makeService(repo).render();
    expect(repo.count).toHaveBeenCalledWith({
      where: { status: "online" },
    });
    expect(repo.count).toHaveBeenCalledWith();
  });

  it("renders 0 online when the fleet is genuinely offline (total > 0)", async () => {
    const repo = makeFleetRepo({ total: 4, online: 0 });
    const out = await makeService(repo).render();
    // 真实的全离线：online=0 且 total 仍 > 0 → AllExecutorsOffline 可判据
    expect(out).toContain("autoflow_executors_online 0");
    expect(out).toContain("autoflow_executors_total 4");
  });

  it("keeps the last value on a DB error instead of resetting to 0 (no false AllExecutorsOffline)", async () => {
    const repo = makeFleetRepo({ total: 5, online: 3 });
    const svc = makeService(repo);
    const first = await svc.render();
    expect(first).toContain("autoflow_executors_online 3");
    expect(first).toContain("autoflow_executors_total 5");

    // DB 抖动：count 直接 reject
    (repo.count as jest.Mock).mockRejectedValue(new Error("db blip"));
    const out = await svc.render();
    expect(out).toContain("autoflow_executors_online 3");
    expect(out).toContain("autoflow_executors_total 5");
    // 关键反例：绝不能被渲染成 0
    expect(out).not.toContain("autoflow_executors_online 0");
  });

  it("keeps the last value when only the second count() fails", async () => {
    const repo = makeFleetRepo({ total: 5, online: 3 });
    const svc = makeService(repo);
    await svc.render();

    let call = 0;
    (repo.count as jest.Mock).mockImplementation(() => {
      call += 1;
      // 第一个查询（total）成功、第二个（online）失败：整轮丢弃
      return call === 1
        ? Promise.resolve(9)
        : Promise.reject(new Error("blip"));
    });
    const out = await svc.render();
    expect(out).toContain("autoflow_executors_total 5");
    expect(out).toContain("autoflow_executors_online 3");
    expect(out).not.toContain("autoflow_executors_total 9");
  });

  it("keeps total=0 when the repository is not injected, so AllExecutorsOffline cannot false-fire", async () => {
    const out = await makeService(undefined).render();
    // 无标签 Gauge 由 prom-client 在 reset 时铺 0 基线，故两者都在且都是 0。
    // 这正是告警表达式要的形态：AllExecutorsOffline 的判据是
    // `online == 0 and total > 0`——取数路径缺席（total=0）时不会误报
    // 「全部执行器离线」，只会在真有注册执行器时判据成立。
    expect(out).toContain("autoflow_executors_online 0");
    expect(out).toContain("autoflow_executors_total 0");
  });

  it("picks up fleet changes on the next scrape (gauge is not monotonic)", async () => {
    const repo = makeFleetRepo({ total: 5, online: 3 });
    const svc = makeService(repo);
    expect(await svc.render()).toContain("autoflow_executors_online 3");

    (repo.count as jest.Mock).mockImplementation(
      (options?: { where?: { status?: string } }) =>
        Promise.resolve(options?.where?.status ? 5 : 6),
    );
    const out = await svc.render();
    expect(out).toContain("autoflow_executors_online 5");
    expect(out).toContain("autoflow_executors_total 6");
  });
});
