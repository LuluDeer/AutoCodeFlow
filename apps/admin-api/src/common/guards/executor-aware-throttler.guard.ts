import { ThrottlerGuard } from "@nestjs/throttler";

/**
 * B-2（中台↔执行器深度审查）：回调限流按**执行器维度**计数，替代按出口 IP 计数。
 *
 * 背景：`CALLBACK_THROTTLE` 的 60/min 档位在 @nestjs/throttler 里默认按 IP 计，
 * 而生产环境大量执行器常位于同一出口 IP（NAT / 机房 NAT / 容器同宿主）之后，
 * 回调速率叠加后极易触顶——满批（100 条/请求）单 IP 上限 6000 条/分钟，10k 档
 * 根本达不到；执行器侧有文件级重试（不丢结果，但上报被推迟），可能与 stale sweep
 * 的失败判定赛跑，导致执行被误判 FAILED。
 *
 * 机制：回调请求带 `x-executor-address` 头（executor-node `callback.ts` 与
 * executor-python `routers/execute.py` 均已附带，值与载荷 `executorAddress`
 * 同源、非用户可控）→ 以 `executor:{address}` 为节流键（执行器各自独立计桶）；
 * 其余请求回退到默认 IP 键（super 行为，逐字节不变）。
 *
 * **SEC-THROTTLE-BUCKET（审计 P1-1，2026-10-17）**：该头是客户端可设的，而
 * 本守卫是全局 APP_GUARD——早先的实现让**所有**路由都读它，于是攻击者每次
 * 登录请求换一个 `x-executor-address` 值即可获得无限个独立计桶，把
 * `/auth/login` 的 20/min 与账号锁定彻底绕过（任意速率暴力破解）。
 *
 * 现收紧为「只有执行器机器面路由才认这个头」：命中
 * `EXECUTOR_MACHINE_PATH_PATTERNS` 之外的请求一律走 super 的 IP 键，人操作面
 * （/auth/*、/tasks/*、/users/* 等）的限流不再受任何客户端头影响。
 * 回调端点本身另有 per-executor / per-execution 令牌认证兜底；伪造他人地址
 * 最坏只会挤占对方执行器的计桶（与用 body 里 address 刷回调等价的 DoS 面），
 * 不构成越权。
 */

/**
 * 认 `x-executor-address` 头的路由——**执行器 → 中台的机器面**。
 *
 * 逐条对应 executor-node `callback.ts` / `scheduler.ts` 与 executor-python
 * `routers/execute.py` / `scheduler.py` 的入站调用点；新增机器面端点时必须
 * 同步登记，否则该端点会静默退回按 IP 计数（多执行器同出口 NAT 下误杀）。
 * 模式以 `$` 锚定在归一化路径尾部（query 已剥离），不做前缀匹配。
 */
export const EXECUTOR_MACHINE_PATH_PATTERNS: readonly RegExp[] = [
  /\/executions\/callback$/,
  // RT-LOG 增量日志上报：POST /executions/:id/logs（id 是路径参数，故用
  // 「任意单段 + /logs 结尾」而非固定段——路径参数不含 `/`，不会越权到
  // 别的端点）。
  /\/executions\/[^/]+\/logs$/,
  /\/executors\/register$/,
  /\/executors\/heartbeat$/,
  /\/executors\/pull$/,
  /\/executors\/command-result$/,
  /\/executors\/offline$/,
  /\/executors\/token$/,
];

/**
 * 归一化请求路径：取 `req.path`（Nest 已剥离全局 `api` 前缀）优先，回退
 * `req.originalUrl` / `req.url` 并去掉 query 与尾斜杠。与 jwt-auth.guard 的
 * normalizeApiPath 同源思路，但这里**保留**前导斜杠（模式以 `/` 锚定）。
 */
export function normalizeThrottlePath(req: Record<string, any>): string {
  const raw: unknown = req?.path ?? req?.originalUrl ?? req?.url ?? "";
  if (typeof raw !== "string") return "";
  const noQuery = raw.split("?")[0].replace(/\/+$/, "");
  if (noQuery === "") return "";
  return noQuery.startsWith("/") ? noQuery : `/${noQuery}`;
}

/** True when the request targets an executor machine surface. */
export function isExecutorMachinePath(normalizedPath: string): boolean {
  return EXECUTOR_MACHINE_PATH_PATTERNS.some((re) => re.test(normalizedPath));
}

export class ExecutorAwareThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    // SEC-THROTTLE-BUCKET: 先判路由，再判头——人操作面永不读客户端头。
    if (!isExecutorMachinePath(normalizeThrottlePath(req))) {
      return super.getTracker(req);
    }
    const address = req?.headers?.["x-executor-address"];
    if (typeof address === "string" && address.trim()) {
      return `executor:${address.trim()}`;
    }
    return super.getTracker(req);
  }
}
