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
 * 其余请求（含旧执行器回调、普通用户面）回退到默认 IP 键（super 行为，逐字节
 * 不变）。
 *
 * 注：该头是客户端可设的，但回调端点本身有 per-executor / per-execution 令牌
 * 认证兜底；伪造他人地址最坏只会挤占对方执行器的计桶（与用 body 里 address
 * 刷回调等价的 DoS 面），不构成越权。
 */
export class ExecutorAwareThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const address = req?.headers?.["x-executor-address"];
    if (typeof address === "string" && address.trim()) {
      return `executor:${address.trim()}`;
    }
    return super.getTracker(req);
  }
}
