import { Controller, Get, Logger, Req, Res, UseGuards } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Request, Response } from "express";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { SkipTimeout } from "../../common/decorators/skip-timeout.decorator";
// SEC-09: SSE 长连接豁免限流——建连不进计数窗口，防 Dashboard Tab 自动
// 重连被误杀（logs/stream @SkipThrottle 先例，SEC-09 分域矩阵见
// src/config/throttle-profiles.ts 头注）。
import { SkipThrottle } from "@nestjs/throttler";
import { MetricsService } from "./metrics.service";
import { MetricsStreamSlotService } from "./metrics-stream-slot.service";

/**
 * UI-14 第一阶段：Dashboard 汇总流。
 *
 * GET /metrics/stream —— SSE 推送 summary + executors 概要 + 队列深度快照。
 *
 * 实现要点（全部沿用既有先例，零新模式）：
 * - @Res() library mode 直写：全局 ResponseInterceptor 的 {code,message,data}
 *   envelope 会破坏 SSE 流（metrics.controller GET /metrics R7 先例注释、
 *   task.controller logs/stream N8 注释同款论述）。新增 SSE 路由若改
 *   @Sse()/return Observable 会破流，必须保持 @Res() 直写。
 * - @SkipTimeout()：流的挂起时长 = 客户端停留时长，豁免全局 30s 请求超时
 *   （logs/stream N8 先例——否则 TimeoutInterceptor 以 TimeoutError 掐断流，
 *   HttpExceptionFilter 会对已写出 SSE 头的响应再 status(408).json()）。
 * - 鉴权：类级 JwtAuthGuard 与 /metrics/* 其余端点一致；EventSource 无法带
 *   Authorization 头的回退走 ?access_token=（jwt.strategy SSE_QUERY_TOKEN_
 *   PATH_SUFFIXES 需含 /metrics/stream，见该文件 UI-14 注记）。
 * - 容量：MetricsStreamSlotService 独立槽位（默认 32，METRICS_STREAM_MAX_
 *   GLOBAL 覆盖），占用在写 SSE 头之前（超限渲染为真 503），释放幂等 +
 *   finally 双保险；active/limit 双 gauge 走 BUG-05 同款 runtime gauge 通道。
 * - 节流：3s 快照推送（METRICS_STREAM_INTERVAL_MS 可覆盖）；空闲 15s 写
 *   ": ping" 注释帧保活 nginx proxy_read_timeout（QA3 先例，SSE 规范要求
 *   客户端忽略注释行）。
 * - 快照内容：getSummary（KPI 面共用查询）+ getExecutorStats（热力条概要）
 *   + getSchedulerMetrics（队列深度/调度健康）。任一查询失败不终止流——
 *   发 error 帧降级，下一拍继续（fail-open 观测语义）。
 */
@ApiTags("metrics")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("metrics")
export class MetricsStreamController {
  private readonly logger = new Logger(MetricsStreamController.name);

  constructor(
    private readonly metrics: MetricsService,
    private readonly slots: MetricsStreamSlotService,
    private readonly configService: ConfigService,
  ) {}

  private get intervalMs(): number {
    const raw = this.configService.get<number | string>(
      "metricsStream.intervalMs",
    );
    const n = typeof raw === "string" ? parseInt(raw, 10) : raw;
    return Number.isFinite(n) && n > 0 ? n : 3_000;
  }

  private get idlePingMs(): number {
    const raw = this.configService.get<number | string>(
      "metricsStream.idlePingMs",
    );
    const n = typeof raw === "string" ? parseInt(raw, 10) : raw;
    return Number.isFinite(n) && n > 0 ? n : 15_000;
  }

  @SkipThrottle()
  @Get("stream")
  @ApiOperation({
    summary: "Dashboard summary SSE stream (UI-14 phase 1)",
    description:
      "Server-Sent Events stream pushing a snapshot every ~3s: { summary, executors, scheduler } " +
      "(+ error frames on degraded queries). Auth: JWT bearer header, or ?access_token= fallback. " +
      "Concurrency: METRICS_STREAM_MAX_GLOBAL slots per instance (503 when full).",
  })
  @SkipTimeout()
  async stream(@Req() req: Request, @Res() res: Response): Promise<void> {
    // 在写任何 SSE 头之前占用槽位——超限抛 ServiceUnavailableException
    // 会被全局异常过滤器渲染为真正的 503（logs/stream TASK-008 先例）。
    const releaseSlot = this.slots.acquireSlot();

    try {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
      res.flushHeaders();

      const ac = new AbortController();
      req.on("close", () => ac.abort());

      const write = (chunk: string) => {
        if (res.writableEnded) return;
        res.write(chunk);
      };
      const send = (payload: unknown, event?: string) => {
        write(event ? `event: ${event}\n` : "");
        write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      // QA3 先例：空闲注释帧，客户端按 SSE 规范忽略，反代视为活跃。
      const ping = () => write(": ping\n\n");

      const snapshot = async (): Promise<{
        summary: unknown;
        executors: unknown;
        scheduler: unknown;
        errors: string[];
      }> => {
        const errors: string[] = [];
        const [summary, executors, scheduler] = await Promise.all([
          this.metrics.getSummary().catch((err: unknown) => {
            errors.push("summary");
            this.logQueryFailure("summary", err);
            return null;
          }),
          this.metrics.getExecutorStats().catch((err: unknown) => {
            errors.push("executors");
            this.logQueryFailure("executors", err);
            return null;
          }),
          this.metrics.getSchedulerMetrics().catch((err: unknown) => {
            errors.push("scheduler");
            this.logQueryFailure("scheduler", err);
            return null;
          }),
        ]);
        return { summary, executors, scheduler, errors };
      };

      const interval = this.intervalMs;
      const idlePing = this.idlePingMs;
      let lastWriteAt = Date.now();

      try {
        while (!ac.signal.aborted) {
          const snap = await snapshot();
          if (ac.signal.aborted) break;
          if (snap.errors.length > 0) {
            send(
              { failed: snap.errors, at: new Date().toISOString() },
              "error",
            );
          }
          send(snap);
          lastWriteAt = Date.now();
          // 分片等待：abort 立即唤醒（close 先例：signal abort → resolve）。
          const wake = await this.waitCancellable(ac.signal, interval);
          if (wake) break;
          // idle 保活：整段无任何写出时补注释帧
          if (Date.now() - lastWriteAt >= idlePing) {
            ping();
            lastWriteAt = Date.now();
          }
        }
        if (!res.writableEnded) {
          send({ reason: "stream closed" }, "done");
          res.end();
        }
      } catch {
        write(`event: error\ndata: stream error\n\n`);
        res.end();
      }
    } finally {
      // 双保险释放（acquireSlot release 幂等——logs/stream 同款）
      releaseSlot();
    }
  }

  private logQueryFailure(name: string, err: unknown): void {
    // 观测链 fail-open：单查询失败仅降级该段（帧内 failed 数组透出），不终止流
    this.logger.warn(
      `Metrics stream query ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  /** 可中断等待：signal abort → true（立即退出主循环），自然到期 → false。 */
  private waitCancellable(signal: AbortSignal, ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (signal.aborted) {
        resolve(true);
        return;
      }
      const t = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve(false);
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        resolve(true);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
