import { Controller, Get, Logger, Req, Res, UseGuards } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Request, Response } from "express";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { SkipTimeout } from "../../common/decorators/skip-timeout.decorator";
// SEC-09: SSE 长连接豁免限流——建连不进计数窗口，防页面自动重连被误杀
// （logs/stream / metrics/stream @SkipThrottle 先例）。
import { SkipThrottle } from "@nestjs/throttler";
import { DomainEventBus } from "../../common/services/domain-event-bus.service";
import {
  DOMAIN_EVENTS,
  ExecutionTerminalEventPayload,
} from "../../common/events/domain-events";
import { MetricsStreamSlotService } from "./metrics-stream-slot.service";

/**
 * FEAT-16：GET /executions/stream —— 执行列表终态推送流（SSE）。
 *
 * 背景：ExecutionsPage 原以 15s 轮询兜底「运行中行何时到终态」。ARCH-21 领域
 * 事件总线已在 handleCallback winner 分支发布 execution.completed/failed、在
 * killExecution 发布 execution.killed（FEAT-18，时机均为条件 UPDATE 落库之后）
 * ——本流把这些进程内事件原样转发为 SSE 帧，执行终态 <3s 推达页面，零 DB 轮询。
 *
 * 实现要点（全部沿用既有先例，零新模式）：
 * - 事件转发语义：DomainEventBus.on 注册的监听器只在本进程 emit 时收到回调
 *   （handleCallback winner / killExecution 落库后发布），载荷为 common 层
 *   ExecutionTerminalEventPayload（全原始类型），JSON 序列化后直接透传，
 *   不做二次解释；SSE event 名 = 领域事件名，客户端 addEventListener 消费。
 * - 无快照帧：订阅窗口错过建连前的终态事件属可接受降级——页面列表首屏仍走
 *   GET /tasks/executions/all（query hooks 首次拉取），SSE 只做「终态加速」，
 *   与 metrics/stream 的「快照即数据」语义不同，不引入快照查询。
 * - 保活：1s 粒度扫描 idle ping——事件驱动流无固定数据帧节奏，静默期可能远超
 *   反代 proxy_read_timeout（QA3 先例：": ping" 注释帧，SSE 规范要求客户端忽略）。
 * - @Res() library mode 直写（@Sse()/Observable 会破全局 envelope 拦截器，
 *   logs/stream N8、metrics/stream 同款论述）+ @SkipTimeout()（流挂起时长 =
 *   客户端停留时长）+ ?access_token= 查询串回退（jwt.strategy 白名单已含
 *   /executions/stream）。
 * - 容量：复用 MetricsStreamSlotService 独立槽位（默认 32）——终态流与汇总流
 *   消费画像相同（每浏览器 Tab 一条），不另建槽位注册表（避过度建设）。
 * - 退避帧：事件长期静默时按 idlePingMs 周期发注释帧；EventSource 断线由
 *   onerror 驱动，注释帧仅保活反代，不承担客户端断线判定。
 */
@ApiTags("metrics")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("executions")
export class ExecutionsStreamController {
  private readonly logger = new Logger(ExecutionsStreamController.name);

  constructor(
    private readonly eventBus: DomainEventBus,
    private readonly slots: MetricsStreamSlotService,
    private readonly configService: ConfigService,
  ) {}

  private get idlePingMs(): number {
    const raw = this.configService.get<number | string>(
      "executionsStream.idlePingMs",
    );
    const n = typeof raw === "string" ? parseInt(raw, 10) : raw;
    return Number.isFinite(n) && n > 0 ? n : 30_000;
  }

  @SkipThrottle()
  @Get("stream")
  @ApiOperation({
    summary: "Execution terminal-state SSE stream (FEAT-16)",
    description:
      "Server-Sent Events stream forwarding execution terminal events " +
      "(execution.completed / execution.failed / execution.killed) from the " +
      "in-process domain event bus. Payload: ExecutionTerminalEventPayload. " +
      "Auth: JWT bearer header, or ?access_token= fallback.",
  })
  @SkipTimeout()
  async stream(@Req() req: Request, @Res() res: Response): Promise<void> {
    // 写 SSE 头之前占槽位（超限 503 由全局异常过滤器渲染——metrics/stream 先例）
    const releaseSlot = this.slots.acquireSlot();

    try {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      const ac = new AbortController();
      req.on("close", () => ac.abort());

      const write = (chunk: string) => {
        if (res.writableEnded) return;
        res.write(chunk);
      };
      const sendEvent = (event: string, payload: unknown) => {
        write(`event: ${event}\n`);
        write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      const ping = () => write(": ping\n\n");

      // 终态事件 → SSE 帧（事件名即 SSE event 名）。监听器抛错由总线
      // fail-open 兜底（记日志不外抛），主循环不受影响。
      const forwarders = [
        DOMAIN_EVENTS.EXECUTION_COMPLETED,
        DOMAIN_EVENTS.EXECUTION_FAILED,
        DOMAIN_EVENTS.EXECUTION_KILLED,
      ].map((eventName) => {
        const listener = (payload: ExecutionTerminalEventPayload) => {
          sendEvent(eventName, payload);
          lastFrameAt = Date.now();
        };
        this.eventBus.on(eventName, listener);
        return { eventName, listener };
      });

      let lastFrameAt = Date.now();

      try {
        while (!ac.signal.aborted) {
          const wake = await this.waitCancellable(ac.signal, 1_000);
          if (wake) break;
          if (Date.now() - lastFrameAt >= this.idlePingMs) {
            ping();
            lastFrameAt = Date.now();
          }
        }
        if (!res.writableEnded) {
          sendEvent("done", { reason: "stream closed" });
          res.end();
        }
      } catch {
        write(`event: error\ndata: stream error\n\n`);
        res.end();
      } finally {
        // 监听器注销：连接关闭后不再向已结束的响应写帧
        for (const { eventName, listener } of forwarders) {
          this.eventBus.off(eventName, listener);
        }
      }
    } finally {
      // 双保险释放（acquireSlot release 幂等——metrics/stream 同款）
      releaseSlot();
    }
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
