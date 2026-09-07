/**
 * OBS-01: W3C Trace Context（traceparent）生成/解析纯函数。
 *
 * 规范：https://www.w3.org/TR/trace-context/ —— traceparent 头格式：
 *   `00-<32 hex trace-id>-<16 hex parent-id>-<2 hex flags>`
 * 本仓库只消费 trace-id（落库 task_executions.traceId + UI 展示/复制 +
 * Jaeger/Tempo 按 trace-id 检索），span-id 仅为格式合法性需要。
 *
 * 零依赖纯函数层（与 execution-callback-token.util 同形态）：admin-api 与
 * 双执行器共享同一算法，双向测试向量钉死。禁止在此引入任何 Nest/框架
 * 依赖 —— TracingService 才是消费方。
 */

/** 当前实现的 version 字节（固定 00）。 */
const VERSION = "00";
/** trace-id：32 个小写 hex（全零非法）。 */
const TRACE_ID_RE = /^[0-9a-f]{32}$/;
/** parent-id / span-id：16 个小写 hex（全零非法）。 */
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
/** flags：2 个 hex。 */
const FLAGS_RE = /^[0-9a-f]{2}$/;

export const TRACEPATTERN_HEADER = "traceparent";

/** 生成随机 hex 字符串（小写）。使用 Node 内置 crypto，无外部依赖。 */
function randomHex(bytes: number): string {
  // 延迟 require 避免模块加载顺序问题（纯函数层保持无状态）。
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { randomBytes } = require("crypto") as typeof import("crypto");
  return randomBytes(bytes).toString("hex");
}

/**
 * 生成一个合法 traceparent 头值：`00-<traceId32>-<spanId16>-01`。
 * flags=01（sampled 位）——本项目无采样决策器，恒采样。
 */
export function generateTraceparent(): string {
  return `${VERSION}-${randomHex(16)}-${randomHex(8)}-01`;
}

/**
 * 从 traceparent 头值提取 trace-id。非严格 W3C 形态（或全零 id）返回 null
 * ——调用方降级为无 trace（fail-open，绝不因追踪头畸形阻断主链）。
 */
export function extractTraceId(traceparent: string | undefined | null): string | null {
  if (typeof traceparent !== "string") return null;
  const parts = traceparent.trim().split("-");
  if (parts.length !== 4) return null;
  const [version, traceId, parentId, flags] = parts;
  if (version !== VERSION) return null;
  if (!TRACE_ID_RE.test(traceId) || traceId === "0".repeat(32)) return null;
  if (!SPAN_ID_RE.test(parentId) || parentId === "0".repeat(16)) return null;
  if (!FLAGS_RE.test(flags)) return null;
  return traceId;
}

/**
 * 由既有 traceId 构造回传/透传用的 traceparent 头值。
 * traceId 非法时返回 null（调用方不带头透传）。span-id 用当前进程的
 * 随机值（回传场景 admin 只消费 trace-id，span-id 仅为格式合法）。
 */
export function buildTraceparent(traceId: string | null | undefined): string | null {
  if (typeof traceId !== "string" || !/^[0-9a-fA-F]{32}$/.test(traceId)) {
    return null;
  }
  return `${VERSION}-${traceId.toLowerCase()}-${randomHex(8)}-01`;
}
