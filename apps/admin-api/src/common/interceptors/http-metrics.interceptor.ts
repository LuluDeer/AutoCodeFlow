import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { Observable } from "rxjs";
import { finalize } from "rxjs/operators";
import {
  HTTP_ROUTE_UNMATCHED,
  PrometheusMetricsService,
} from "../../modules/metrics/prometheus-metrics.service";
import { hasSseContentType, isSsePath } from "../utils/sse-compression.util";

/**
 * HTTP RED 埋点（本轮新增）：全局拦截器 → PrometheusMetricsService 快照。
 *
 * ## 为什么是拦截器而不是 middleware
 *
 * RED 的 Duration 要在**响应真正结束**时才有意义（statusCode 已定、处理器
 * 与响应拦截器都已跑完）。Nest 拦截器的 `finalize()` 挂在 Observable 的
 * teardown 上：正常完成、抛异常、被下游拦截器 map 改写，三条路径都会执行
 * 且只执行一次——比 `res.on("finish")` 更贴近「一次请求生命周期」的语义，
 * 也不需要手动摘监听器。
 *
 * ## 路由基数（本文件最关键的一条）
 *
 * `route` label **只能是 Express 路由模板**（`/tasks/:id`），绝不能用
 * `req.originalUrl` / `req.url`：后者带具体 id 与查询串，每来一个任务就多
 * 一条 series，几分钟就能把 Prometheus 打爆（这是 RED 指标最常见的翻车点）。
 *
 * 取值顺序：
 *   1. `req.baseUrl + req.route.path`——Nest 的控制器前缀（含 @Controller
 *      路径与 URI 版本前缀）在 baseUrl 上，`route.path` 是**路由注册时的
 *      模板字符串**，所以 `/api/tasks/8f3…` 会稳定折成 `/api/tasks/:id`；
 *   2. 没有 `route`（404、全局中间件短路、错误请求行）→ 固定值
 *      `"unmatched"`。**绝不回退到原始 URL**：未匹配的路径恰恰是扫描器
 *      最爱打的（`/.env`、`/wp-admin`…），回退成 URL 等于把基数交给攻击者。
 *
 * 模板本身基数有界（= 代码里的路由数量），无需额外做 top-N 截断。
 *
 * ## 为什么排除 SSE / 长连接
 *
 * SSE 流的 Observable 直到客户端断开才 teardown，一条日志流挂几小时就会在
 * Duration 里留下一个几小时的样本——P99 会被单条长流直接带偏，且
 * `_sum` 变成「在线时长」而非「响应耗时」。判定复用 compression filter 的
 * 同一套判据（`isSsePath` 路径兜底 + `hasSseContentType` content-type 主判），
 * 两条是「或」关系：SSE 控制器在建流同步段已 setHeader，finalize 时
 * getHeader 必然读得到；忘记设 content-type 的老路径由 /logs/stream 兜住。
 *
 * ## 观测失败绝不影响业务
 *
 * `recordHttpRequest` 只做内存加法，理论上不会抛；但仍然整段 try/catch——
 * 埋点是旁路，任何异常都不能让一个已经成功的响应变成 500。
 */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: PrometheusMetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // 只处理 HTTP 上下文（本应用无 WS/RPC 控制器，这行是防御性收口）。
    if (context.getType() !== "http") return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const startedAt = process.hrtime.bigint();
    // 方法在请求期不变，路由与状态码必须**在 finalize 时读**（此刻路由可能
    // 尚未匹配、状态码还是默认 200）。
    const method = normalizeMethod(req.method);

    return next.handle().pipe(
      finalize(() => {
        try {
          // SSE / 长连接：不进 Duration（见头注）。路由与状态码一律不读，
          // 连计数器都不加——一条流的「请求数」没有 RED 语义。
          if (isSsePath(req) || hasSseContentType(res)) return;
          const durationMs =
            Number(process.hrtime.bigint() - startedAt) / 1_000_000;
          this.metrics.recordHttpRequest(
            method,
            resolveRoutePattern(req),
            res.statusCode,
            durationMs,
          );
        } catch {
          // 埋点旁路失败不影响响应（见头注）。
        }
      }),
    );
  }
}

/**
 * 取 Express 路由模板（`/tasks/:id` 形态）。
 *
 * `req.route` 在「已匹配到某条路由」时才存在（express 在 Layer.handle 内
 * 挂载）；`baseUrl` 是该路由所属 router 的挂载前缀。两者拼接即得
 * 「控制器前缀 + 模板」的完整路径，与 Prometheus 侧期望的 route label 一致。
 *
 * 未匹配 → "unmatched"（**不**回退原始 URL，理由见类头注）。
 */
export function resolveRoutePattern(
  req: Pick<Request, "route" | "baseUrl">,
): string {
  const routePath = req.route?.path;
  // route.path 可能是数组（同一 handler 注册多个模板）——取首个即可，
  // 基数不变；非字符串一律视为未匹配。
  const template = Array.isArray(routePath) ? routePath[0] : routePath;
  if (typeof template !== "string" || template === "") {
    return HTTP_ROUTE_UNMATCHED;
  }
  const base = typeof req.baseUrl === "string" ? req.baseUrl : "";
  // 两侧都可能带/不带斜杠，拼完再归一，避免 "//tasks" 这种形态漂移。
  const joined = `${base}/${template}`.replace(/\/{2,}/g, "/");
  return joined.length > 1 && joined.endsWith("/")
    ? joined.slice(0, -1)
    : joined;
}

/**
 * HTTP 方法归一化：大写；缺失/非字符串退 "UNKNOWN"（不造空标签值——
 * 空串会让 `method=""` 成为一条独立 series）。
 */
export function normalizeMethod(method: unknown): string {
  return typeof method === "string" && method !== ""
    ? method.toUpperCase()
    : "UNKNOWN";
}
