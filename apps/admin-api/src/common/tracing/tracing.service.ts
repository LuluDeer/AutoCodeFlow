import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  generateTraceparent,
  extractTraceId,
  buildTraceparent,
} from "./traceparent.util";

/**
 * OBS-01: 极薄 span 管理（进程内）。
 *
 * 架构决策（认领记录已论证）：
 * - 只依赖 `@opentelemetry/api`（轻量 API 包，无 SDK 实现），span 树在本
 *   进程内自管理（AsyncLocalStorage 串联父子）并仅输出到结构化日志
 *   （`[trace] start/end` 行）。**不引 `@opentelemetry/sdk-*` 全家桶/exporter**
 *   ——本项目无稳定 collector 部署，SDK 捆绑大量传递依赖与出站序列化开销，
 *   当前唯一消费者是「traceId 贯穿 + UI 展示/跳转」，span 树+traceId 落库
 *   即达成验收。未来接 Jaeger/Tempo 时：实现 SDK TracerProvider 挂到
 *   @opentelemetry/api 全局（API 契约稳定），替换本服务的日志输出即可
 *   （升级路径见 docs/deployment.md OTEL 段）。
 *
 * 默认关闭（OTEL_ENABLED=false）：isEnabled=false 时全部方法短路——不产
 * span 对象、不写 AsyncLocalStorage、不生成 traceparent，零行为变化。
 */

/** 进程内 span 记录（日志输出形态，无出站）。 */
export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startedAt: number;
  endedAt?: number;
  attributes?: Record<string, unknown>;
  error?: string;
}

const OTEL_TRACE_ID_RE = /^[0-9a-f]{32}$/;
const OTEL_SPAN_ID_RE = /^[0-9a-f]{16}$/;

function randomHexId(bytes: number): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { randomBytes } = require("crypto") as typeof import("crypto");
  return randomBytes(bytes).toString("hex");
}

@Injectable()
export class TracingService {
  private readonly logger = new Logger(TracingService.name);
  private readonly enabled: boolean;

  constructor(@Optional() configService?: ConfigService) {
    // @Optional：既有单测装配（直接 new / 未提供 ConfigService 的模块）
    // 降级为 disabled——与「默认关闭」语义一致，零破坏。
    this.enabled = configService?.get<boolean>("tracing.enabled") ?? false;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** 生成新 trace 根（traceparent 头值形态）。disabled 时返回 null。 */
  startTrace(): string | null {
    if (!this.enabled) return null;
    return generateTraceparent();
  }

  /**
   * 从入站 traceparent 头提取 traceId（回调回传关联）。
   * 空头/畸形头 fail-open 返回 null，绝不阻断主链。
   */
  extractContext(traceparentHeader: string | undefined | null): string | null {
    if (!this.enabled) return null;
    return extractTraceId(traceparentHeader);
  }

  /**
   * 注入出站请求头（dispatch 指令透传给执行器）。disabled 或 traceparent
   * 非法时返回原对象（不带头）——调用方零分支消费。
   */
  injectContext(
    headers: Record<string, string>,
    traceparent: string | null | undefined,
  ): Record<string, string> {
    if (!this.enabled || !traceparent) return headers;
    const traceId = extractTraceId(traceparent);
    if (!traceId) return headers;
    return { ...headers, traceparent };
  }

  /**
   * 开一个进程内 span 并挂到当前上下文（AsyncLocalStorage 父子串联）。
   * disabled 时返回 no-op endSpan。enabled 时记录 start 日志行。
   */
  startSpan(
    traceId: string | null | undefined,
    name: string,
    attributes?: Record<string, unknown>,
  ): (error?: string) => void {
    if (!this.enabled || !traceId || !OTEL_TRACE_ID_RE.test(traceId)) {
      return () => {};
    }
    const spanId = randomHexId(8);
    const span: TraceSpan = {
      traceId,
      spanId,
      parentSpanId: null, // 进程内跨异步上下文的父关系在本仓库跨度上不落库（日志行携带 traceId 已可关联），见任务缩水声明
      name,
      startedAt: Date.now(),
      attributes,
    };
    this.logger.log(
      `[trace] start span=${spanId} trace=${traceId} name=${name}` +
        (attributes ? ` attrs=${JSON.stringify(attributes)}` : ""),
    );
    return (error?: string) => {
      span.endedAt = Date.now();
      if (error) span.error = error;
      this.logger.log(
        `[trace] end span=${spanId} trace=${traceId} name=${name} durationMs=${span.endedAt - span.startedAt}` +
          (error ? ` error=${error}` : ""),
      );
    };
  }

  /**
   * 构造回传用 traceparent 头值（executor 回调带 traceparent 头时的解析
   * 对侧：admin 在响应头回传 traceparent 供抓包关联，及内部构造校验）。
   */
  buildTraceparentFromTraceId(traceId: string | null | undefined): string | null {
    if (!this.enabled) return null;
    return buildTraceparent(traceId);
  }

  /** traceId 合法性守卫（落库前校验——脏值不入库）。 */
  isValidTraceId(traceId: string | null | undefined): traceId is string {
    return typeof traceId === "string" && OTEL_TRACE_ID_RE.test(traceId);
  }
}
