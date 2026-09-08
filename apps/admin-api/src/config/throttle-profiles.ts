/**
 * SEC-09: 限流分域的装饰器求值期档位常量。
 *
 * 背景：@Throttle() 的参数在装饰器求值期（模块首次进入 import graph 时）
 * 固化，早于 ConfigModule 生命周期应用 .env —— 即 W-22 前科现场（见
 * auth.controller LOGIN_THROTTLE_LIMIT 先例与 src/config/env.ts 头注）。
 * main.ts 已在 import app.module 前预载 .env（src/__tests__/main-env-preload.spec.ts
 * 守护），本文件经 getEnvVar() 统一收口读取，是 ARCH-27 审计后的显式豁免
 * （与 auth.controller LOGIN_THROTTLE_LIMIT 同款双轨：值同步注册到
 * configuration.ts throttle 节 + app.module Joi，供运行时一致性与文档化）。
 *
 * 分域矩阵（SEC-09，端点 × 档位，tracker 一律 req.ip，TRUST_PROXY=false 防 XFF 伪造）：
 *  - 严格档 AUTH_THROTTLE（默认 10/min/IP）：POST /auth/refresh、
 *    /auth/totp/setup|enable|disable|verify（防爆破，与 account lockout 互补；
 *    /auth/login 保留既有 LOGIN_THROTTLE_LIMIT=20 契约不变）。
 *  - 中档 OPS_THROTTLE（默认 30/min/IP）：触发/执行干预写面 ——
 *    tasks trigger/kill/rollback/pause/resume、batch trigger、
 *    tasks-batch trigger、app-deployments deploy/approve/reject/cancel/
 *    upgrade/stop、applications upgrade-all/rollback。
 *  - 宽松档（默认）：其余全部读/写路由走全局 THROTTLE_LIMIT=60/min 不变。
 *  - SSE 豁免档：task logs/stream、metrics stream @SkipThrottle()
 *    （长连接建连不进计数窗口，防 Dashboard 自动重连被误杀）。
 *  - 全局旁路：THROTTLE_ENABLED=false → app.module ThrottlerModule 顶层
 *    skipIf 全域跳过（运行期 ConfigService 读取，非本文件）。
 *
 * 命名保留单 default 域（而非 named throttlers）：@nestjs/throttler@6.5.0 的
 * named throttler 对未标注路由会 fallback 到自身 limit（guard canActivate
 * 的 `routeOrClassLimit || namedThrottler.limit`），会让 strict 档误杀全部
 * 未标注路由；per-route default-key 覆盖是仓库既有用法（F-5/N16 先例），
 * guard 全局 APP_GUARD 挂载形态不变。
 */
import { getEnvVar } from "./env";

/** 正整数 env 解析：非法/缺省回退 fallback（与 parseInt(...) || N 既有风格一致）。 */
function positiveInt(name: string, fallback: number): number {
  const raw = getEnvVar(name);
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export interface ThrottleProfile {
  ttl: number;
  limit: number;
}

/** 严格档：auth 敏写面（默认 10 次 / 60s）。 */
export const AUTH_THROTTLE: ThrottleProfile = {
  ttl: positiveInt("THROTTLE_AUTH_TTL", 60_000),
  limit: positiveInt("THROTTLE_AUTH_LIMIT", 10),
};

/** 中档：触发/执行干预写面（默认 30 次 / 60s）。 */
export const OPS_THROTTLE: ThrottleProfile = {
  ttl: positiveInt("THROTTLE_OPS_TTL", 60_000),
  limit: positiveInt("THROTTLE_OPS_LIMIT", 30),
};
