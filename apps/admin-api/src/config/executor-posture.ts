/**
 * R06（2026-11-05）：**升级期可操作告警** —— 执行器出站姿态（契约口径）。
 *
 * ## 为什么需要它（R05 改出来的破坏性变更）
 *
 * R05 把 admin 的执行器出站姿态按契约逐格对齐后：
 *   · `privateIPv4.allowedUnderPrivateNetwork = true` ⇒ **内网执行器必须显式开开关**才放行；
 *   · `loopback.allowedUnderPrivateNetwork = false`  ⇒ **同机 `127.0.0.1` 执行器永远被拒**
 *     （契约原话「打自己回环没有合法拓扑」）。
 *
 * 对**已存在的自托管部署**，升级后症状是：注册/心跳正常，但**每次派发都失败**，
 * 执行行 `failureReason=script_error`、`errorMessage` 只有一句
 * 「URL host 10.x.x.x 在拒绝名单内（私有/回环/链路本地/基准测试/CGNAT）— 已拒绝对外请求」——
 * **它说了「为什么」，没说「怎么办」**。启动时不告警 = 静默失败，运维只能靠猜。
 *
 * 所以这里在**启动期**给一条可操作告警（只在开关未开时出现，开了就静默）：
 *   · 点名变量 `EXECUTOR_ALLOW_PRIVATE_NETWORK`；
 *   · 给两条修法（内网 → 开开关；同机回环 → 换内网地址/独立机器，开关救不了回环）；
 *   · 指向升级文档。
 *
 * ## 边界
 *
 * 纯函数、无副作用、可注入 `env`（单测不污染真实环境）。真正的打日志在
 * `main.ts` 的 bootstrap（`Logger.warn`）——那里才有「应用启动」这个时刻。
 * 开关已开（`EXECUTOR_ALLOW_PRIVATE_NETWORK=true`）时返回 `null`，**零噪音**。
 */

/** 开关名（与 `safe-http.util.ts` 的 `getEnvVar("EXECUTOR_ALLOW_PRIVATE_NETWORK")` 同源）。 */
export const EXECUTOR_PRIVATE_NETWORK_FLAG = "EXECUTOR_ALLOW_PRIVATE_NETWORK";

/**
 * 生成启动期告警文案；开关已开时返回 `null`（不吵）。
 *
 * @param env 注入点（默认 `process.env`），便于单测。
 */
export function executorPostureWarning(
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (env[EXECUTOR_PRIVATE_NETWORK_FLAG] === "true") return null;
  return [
    `出站 SSRF 闸（契约口径）：${EXECUTOR_PRIVATE_NETWORK_FLAG} 未开启`,
    "⇒ 内网执行器（10/8、172.16/12、192.168/16）的派发会被拒绝（EXECUTOR_HOST_BLOCKED / 已拒绝对外请求）",
    `修法①（内网执行器）：给 admin-api 设 ${EXECUTOR_PRIVATE_NETWORK_FLAG}=true（compose 默认栈已内置该默认值）`,
    "修法②（同机执行器）：回环地址 127.0.0.1 / ::1 不受该开关影响（契约：回环恒拒），必须改用内网 IP 或独立机器",
    "升级说明见 docs/UPGRADING.md 的「执行器出站姿态（R05 起）」段",
  ].join("；");
}
