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
  // ── SEC-THROTTLE-WHITELIST-GAP（2026-10-17 审计补漏）───────────────
  // 以下两条此前**漏登记**，而它们都是执行器机器面端点：executor-node
  // `pull.ts` 的配置热更新（GET /api/executors/config）与 `callback.ts` 的
  // 死信对账（GET /api/executors/:address/terminal-states）都会带
  // `x-executor-address` 头。漏登记的后果不是「少一个桶」——这些请求会
  // 静默退回按出口 IP 计数，多执行器共享 NAT 出口时速率叠加后被限流，
  // 正是本守卫当初要修的 B-2 故障形态（配置热更新被 429 → 热更新失效；
  // 死信对账拉不到 → 回调死信积压无人清理）。
  // 两者均非人操作面：/executors/config 走 per-executor 令牌
  // （pullExecutorConfig 的 validateTokenByAddress），terminal-states 同款
  // （@WriteGuard scope=token），认头不扩大 SEC-THROTTLE-BUCKET 的绕过面。
  /\/executors\/config$/,
  /\/executors\/[^/]+\/terminal-states$/,
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

// ── 运行时漏登记告警（PLAN-SECURITY-HARDENING §1.2 的落地形态）─────────────
//
// 设计取舍（与计划草案不同，理由在此）：
//   · 草案建议「开发环境直接 throw」——不可行。getTracker 跑在每个入站请求
//     的限流路径上，生产环境一旦有新执行器版本先行带头上报（灰度期常态），
//     throw 会把**新执行器版本**变成硬故障；开发环境则会让本地跑旧/新执行
//     器组合时随机 500。漏登记的代价是「退回 IP 计桶」（可用性降级），不是
//     安全漏洞（SEC-THROTTLE-BUCKET 的绕过面已由路由白名单本身关闭），因此
//     只告警、绝不拒绝。
//   · 告警必须节流：getTracker 每请求执行一次，回调面 10k 档位下单进程每秒
//     可达数百次——不节流会把日志打成刷屏风暴，反而掩盖真正的故障信号。
//     按「路径模板 + 地址」聚合，同一形态 10 分钟内最多一条。
const WHITELIST_WARN_INTERVAL_MS = 10 * 60 * 1000;

/**
 * 把具体路径收敛成**可登记的模板**：`/api/executors/RPA5:8002/terminal-states`
 * → `/api/executors/:addr/terminal-states`。日志里直接贴原始路径的话，运维
 * 看到的是几百条各不相同的行，无法一眼看出「要往白名单加哪一条正则」。
 */
export function suggestWhitelistTemplate(normalizedPath: string): string {
  return normalizedPath
    .split("/")
    .map((seg) =>
      // 含 `:`（host:port 形态的执行器地址）、UUID、长 hex、数字 id 的段视为
      // 路径参数。阈值取 8：短数字段（如 `/v2`、`/executions` 里的字面量）
      // 保持原样，避免把真实路由段误抽象成参数模板。
      /:/.test(seg) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg) ||
      /^[0-9a-f]{16,}$/i.test(seg) ||
      /^\d{8,}$/.test(seg)
        ? ":addr"
        : seg,
    )
    .join("/");
}

export class ExecutorAwareThrottlerGuard extends ThrottlerGuard {
  /** 已告警过的模板（`template@address` → 上次告警时间戳）。 */
  private readonly whitelistWarnedAt = new Map<string, number>();

  protected async getTracker(req: Record<string, any>): Promise<string> {
    // SEC-THROTTLE-BUCKET: 先判路由，再判头——人操作面永不读客户端头。
    const path = normalizeThrottlePath(req);
    if (!isExecutorMachinePath(path)) {
      const address = req?.headers?.["x-executor-address"];
      if (typeof address === "string" && address.trim()) {
        // 带机器面头的请求落到了非白名单路由：要么是新机器面端点忘了登记，
        // 要么是有人拿执行器头去打人操作面（SEC-THROTTLE-BUCKET 的攻击形态）。
        // 两种都值得知道，且都在这里被安全地降级为 IP 计桶。
        this.warnUnregisteredMachinePath(path, address.trim());
      }
      return super.getTracker(req);
    }
    const address = req?.headers?.["x-executor-address"];
    if (typeof address === "string" && address.trim()) {
      return `executor:${address.trim()}`;
    }
    return super.getTracker(req);
  }

  /**
   * 节流告警：同一（模板, 地址）10 分钟一条。绝不抛错——见上方设计取舍。
   * 告警文案刻意写成可直接执行的动作（给出应加的正则），而不只是"发现了异常"。
   */
  private warnUnregisteredMachinePath(path: string, address: string): void {
    const template = suggestWhitelistTemplate(path);
    const key = `${template}@${address}`;
    const now = Date.now();
    const last = this.whitelistWarnedAt.get(key);
    if (last !== undefined && now - last < WHITELIST_WARN_INTERVAL_MS) return;
    this.whitelistWarnedAt.set(key, now);
    // Map 无上界 → 攻击者可用任意地址值撑爆内存。超限时整体清空（最简单的
    // 有界策略：最坏只是重新告警一轮，不会漏掉持续存在的形态）。
    if (this.whitelistWarnedAt.size > 1000) this.whitelistWarnedAt.clear();
    this.logger.warn(
      `Executor header on non-whitelisted path "${template}" (from ${address}); ` +
        `falling back to IP-based throttling. If this is a new executor machine ` +
        `surface, register it in EXECUTOR_MACHINE_PATH_PATTERNS ` +
        `(apps/admin-api/src/common/guards/executor-aware-throttler.guard.ts) ` +
        `and in scripts/check-throttler-whitelist.mjs's known-route list.`,
    );
  }
}
