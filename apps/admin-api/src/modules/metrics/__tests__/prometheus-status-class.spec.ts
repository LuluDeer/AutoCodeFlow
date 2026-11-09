/**
 * R183：`status_class` 把「暂时不可用（503）」与「服务端故障（5xx）」分家。
 *
 * ## 为什么这条要单独一个 spec
 *
 * 判据不是「渲染出的字符串长什么样」，而是**告警会怎么算**：
 * `AUTOFLOW_HTTP_5XX_RATE_HIGH` 的分子是
 * `sum(rate(autoflow_http_requests_total{status_class="5xx"}[5m]))`（面板 602
 * 同口径），PromQL 的 `=` 是**精确**匹配。所以这里把 exposition 解析回
 * 「route × status_class → 计数」的表，再按各查询的 selector 求和——
 * 「5xx 桶里有没有混进 503」由**取值相等**判定，而不是字符串前缀
 * （`"5xx-temporary"` 里含 `"5xx"`，前缀判定会误绿）。
 *
 * 另一半原因：`prometheus-metrics.service.spec.ts` 已登记在
 * `scripts/source-size-baseline.json`（棘轮只减不增），把这块专项判据塞进去
 * 会顶破基线；专项 spec 也让「口径」这件事有唯一落点。
 *
 * ## 背景（为什么需要这一档）
 *
 * R178 把「暂时没有可用执行器」一族错误从 500/409 统一到 503（语义 =
 * 「服务暂时不可用、稍后重试」），但**分类没跟着改**：`classifyHttpStatus`
 * 仍把 500~599 一律归 `"5xx"`，于是容量不足照样推高服务端错误率并触发告警
 * ——「改 503 就能不污染错误预算/告警」当时是错的。本 spec 钉住真正的修法：
 * 503 单独成档 `"5xx-temporary"`，**"5xx" 的定义一个字都不动**（500 仍是
 * 500、502/504 仍是 5xx），所以历史曲线不会因为「重新定义 5xx」而集体漂移，
 * 只有 503 那部分改变归属。
 */
import { ConfigService } from "@nestjs/config";

import { PrometheusMetricsService } from "../prometheus-metrics.service";
import { SchedulerMetricsService } from "../../scheduler/scheduler-metrics.service";
import { SchedulerService } from "../../scheduler/scheduler.service";
import { ExecutionCallbackMetricsService } from "../../task/execution-callback-metrics.service";

const QUEUE_EMPTY = {
  waiting: 0,
  active: 0,
  delayed: 0,
  failed: 0,
  completed: 0,
};

/** 与 prometheus-metrics.service.spec.ts 里 RED 段同一构造形态（独立 Registry）。 */
function makeService(): PrometheusMetricsService {
  const config = { get: jest.fn(() => true) };
  return new PrometheusMetricsService(
    config as unknown as ConfigService,
    new SchedulerMetricsService(),
    {
      getQueueDepth: jest.fn().mockResolvedValue({ ...QUEUE_EMPTY }),
    } as unknown as SchedulerService,
    new ExecutionCallbackMetricsService(),
  );
}

/**
 * 从 text exposition 里解析「某 route 下 status_class → 请求计数」。
 *
 * 只认 `autoflow_http_requests_total` 的完整标签形态（method/route/status_class
 * 顺序与 renderHttpRed 一致）；解析不出 / 非目标 route 一律跳过，不猜。
 */
function parseRequestCounts(out: string, route: string): Map<string, number> {
  const counts = new Map<string, number>();
  const line =
    /^autoflow_http_requests_total\{method="([^"]+)",route="([^"]+)",status_class="([^"]+)"\} (\d+)$/;
  for (const raw of out.split("\n")) {
    const match = raw.trim().match(line);
    if (!match || match[2] !== route) continue;
    counts.set(match[3], Number(match[4]));
  }
  return counts;
}

describe('R183 · status_class: 503 单列 "5xx-temporary"', () => {
  it('503 不再计入 status_class="5xx"（容量不足不推高服务端故障率）', async () => {
    const svc = makeService();
    // 同一路由上三种结局：这才是告警分子/分母的分歧点
    svc.recordHttpRequest("POST", "/api/tasks", 500, 8); // 真 bug → 5xx
    svc.recordHttpRequest("POST", "/api/tasks", 503, 2); // 容量不足 → 5xx-temporary
    svc.recordHttpRequest("POST", "/api/tasks", 200, 40); // 正常流量 → 2xx

    const out = await svc.render();
    const counts = parseRequestCounts(out, "/api/tasks");

    // ① 告警分子（= 面板 602 的 5xx 曲线）：只剩真 bug
    expect(counts.get("5xx")).toBe(1);
    // ② 503 有自己的档，且**没有**在 5xx 里留下半份
    expect(counts.get("5xx-temporary")).toBe(1);
    // ③ 分母不变：503 仍是真实请求。把它从流量里删掉会让占比**虚高**得比
    //    原来更厉害（5xx/总请求 从 1/3 变 1/2），那是把噪声换成假警报
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(3);
    // ④ 过渡期口径：一次看全「服务端没接住」（真 bug + 容量不足）用
    //    status_class=~"5xx|5xx-temporary"——新增档 + 旧档 = 改造前那条曲线，
    //    历史因此不断层（只是分成两条 series）
    expect((counts.get("5xx") ?? 0) + (counts.get("5xx-temporary") ?? 0)).toBe(
      2,
    );
    // ⑤ 503 的耗时样本也必须落在新档：P99/均值面板按 status_class 过滤，
    //    样本若留在 5xx 上，就会出现「请求数在 temporary、耗时在 5xx」的错配
    expect(out).toContain(
      'autoflow_http_request_duration_ms_count{method="POST",route="/api/tasks",status_class="5xx-temporary"} 1',
    );
    expect(out).toContain(
      'autoflow_http_request_duration_ms_sum{method="POST",route="/api/tasks",status_class="5xx-temporary"} 2',
    );
  });

  it("只有 503 降级为 temporary，其余 5xx 一律留在 5xx（口径保守）", async () => {
    const svc = makeService();
    for (const code of [500, 501, 502, 504, 599]) {
      svc.recordHttpRequest("GET", "/api/boundary", code, 1);
    }
    svc.recordHttpRequest("GET", "/api/boundary", 503, 1);

    const counts = parseRequestCounts(await svc.render(), "/api/boundary");
    // 500 = 真 bug、501 = 未实现、502/504 = 上游/网关故障、599 = 兜底未知——
    // 全都不属于「等一会儿重试」，一条都不许被降级
    expect(counts.get("5xx")).toBe(5);
    expect(counts.get("5xx-temporary")).toBe(1);
    expect(counts.get("other")).toBeUndefined();
  });

  it("5xx 编号范围内的非 503 码不因新增分档而落到 other（不丢数据）", async () => {
    // 分档是「在 5xx 范围判断之前插一条 503」，顺序写反（把 503 判断放到
    // 范围判断之后就永远走不到；把范围判断改成排除 503 后再兜底 other 就会
    // 让 505/599 掉进 other）——这条专门盯住这两类顺序错误。
    const svc = makeService();
    svc.recordHttpRequest("GET", "/api/edge", 505, 1);
    svc.recordHttpRequest("GET", "/api/edge", 599, 1);

    const counts = parseRequestCounts(await svc.render(), "/api/edge");
    expect(counts.get("5xx")).toBe(2);
    expect(counts.get("other")).toBeUndefined();
    expect(counts.get("5xx-temporary")).toBeUndefined();
  });
});
