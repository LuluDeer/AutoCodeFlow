import { Controller, Get, Logger, Req, Res, UseGuards } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
  ApiResponse,
} from "@nestjs/swagger";
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
 *   rt-3：载荷是**摘要型**——不再携带回调原始 logs（≤512KB），只带派生
 *   `logHead`（首行 ≤500 字符）。这一层的成本被乘了两次（跨实例 relay 的
 *   `JSON.stringify` + PUBLISH，以及**每条连接各自** 的 `JSON.stringify`），
 *   所以「载荷里不放数据面内容」不只是 relay 的规矩：viaRelay 补发的载荷
 *   （另一实例经 Redis 转来）与本实例 emit 的载荷形状完全一致、走同一条
 *   `sendEvent` 透传，故任何一端的字段膨胀都会线性放大到全部订阅连接上。
 *   日志全文按需走 GET /tasks/:id/executions/:execId/logs 拉取。
 * - 无快照帧：订阅窗口错过建连前的终态事件属可接受降级——页面列表首屏仍走
 *   GET /tasks/executions/all（query hooks 首次拉取），SSE 只做「终态加速」，
 *   与 metrics/stream 的「快照即数据」语义不同，不引入快照查询。
 * - 保活：1s 粒度扫描 idle ping——事件驱动流无固定数据帧节奏，静默期可能远超
 *   反代 proxy_read_timeout（QA3 先例：": ping" 注释帧，SSE 规范要求客户端忽略）。
 *   P1-1b（nginx-sse）：每帧写出后 res.flush()（typeof 守卫）——此前压缩中间件
 *   把帧吞进 zlib 缓冲，心跳写了但字节到不了反代；压缩豁免（P1-1a）后 flush
 *   为 no-op 兜底，保证空闲流每 idlePingMs 必有字节到达。
 * - @Res() library mode 直写（@Sse()/Observable 会破全局 envelope 拦截器，
 *   logs/stream N8、metrics/stream 同款论述）+ @SkipTimeout()（流挂起时长 =
 *   客户端停留时长）。鉴权回退走 ?ticket= 短时 SSE 票据（POST /auth/sse-ticket，
 *   30s TTL，jwt.strategy 白名单已含 /executions/stream）——A5 已移除
 *   ?access_token= 查询串通道（15 分钟全权 token 进访问日志，不可接受）。
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
  @ApiResponse({
    status: 200,
    description: "Server-Sent Events 流（Res 直传；绕过统一响应包装拦截器）",
    content: { "text/event-stream": { schema: { type: "string" } } },
  })
  @Get("stream")
  @ApiOperation({
    description:
      "Server-Sent Events 流，从进程内领域事件总线转发执行终态事件（execution.completed / execution.failed / execution.killed）。载荷：ExecutionTerminalEventPayload。鉴权：JWT bearer 请求头，或 ?ticket= 短效 SSE 票据（POST /auth/sse-ticket，TTL 30 秒）——EventSource 无法设置请求头。",
    summary: "执行终态 SSE 流（FEAT-16）",
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

      // P1-1b（nginx-sse）：每帧写出后立刻 flush（typeof 守卫）——此前
      // compression 对 text/event-stream 走 gzip，注释帧/事件帧滞留 zlib
      // 缓冲不落 socket，idle ping 写了但到不了反代（根因详见
      // sse-compression.util.ts 头注）。SSE 已按 content-type 豁免压缩
      // （P1-1a），此处 flush 保留为兜底；无 compression 环境/mock res
      // 没有 flush，必须 typeof 守卫。
      const write = (chunk: string) => {
        if (res.writableEnded) return;
        res.write(chunk);
        if (typeof res.flush === "function") res.flush();
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
          // rt-8：有真实帧就重置空闲定时器（与日志流同口径）。
          armIdle();
        };
        this.eventBus.on(eventName, listener);
        return { eventName, listener };
      });

      // rt-8（第 3 轮运行时审计）：空闲保活改成**事件驱动单定时器**。
      //
      // 旧实现每秒醒一次判断「是否该 ping」——250 条 /executions/stream
      // 连接就是 250 次/s 的 Promise + abort listener 成对分配。正确形态是
      // 「一个 idlePingMs 的 setTimeout，每写一帧就重置」：空闲长的连接
      // 每秒零回调，活跃连接重置定时器（开销与帧数同阶）。
      // 同仓 `streamExecutionLogs` 的「有数据即重置基线」是同一口径。
      let idleTimer: NodeJS.Timeout | null = null;
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          ping();
          armIdle();
        }, this.idlePingMs);
        // 不要让空闲保活定时器独自阻止进程退出（SSE 连接本身持有 socket，
        // 但测试/停机场景下 unref 更干净）。
        idleTimer.unref?.();
      };

      try {
        armIdle();
        // 主循环消失：连接的生命周期 = 等 abort（close 事件）。
        await this.waitAbort(ac.signal);
        if (!res.writableEnded) {
          sendEvent("done", { reason: "stream closed" });
          res.end();
        }
      } catch {
        write(`event: error\ndata: stream error\n\n`);
        res.end();
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
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

  /** 等待连接 abort（close 事件）；不分配定时器。 */
  private waitAbort(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
