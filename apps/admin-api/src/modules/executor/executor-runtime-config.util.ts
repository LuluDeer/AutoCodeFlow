import { EXECUTOR_LIST_LIMIT } from "./executor-constants";

/**
 * 执行器运行期配置的**纯计算**部分（B0 拆分第 4 步）。
 *
 * ## 为什么是纯函数
 *
 * `GET /executors/runtime-config` 回给前端的这组数字里，有一半是**派生值**：
 *
 * - `heartbeatTimeoutMs` = 心跳间隔 × 超时倍数；
 * - `effectiveOfflineAfterMs` = 心跳间隔 × 超时倍数 × 判死确认轮数。
 *
 * 这两个是前端「多久判离线」的**唯一依据**（NETOPT-G P1-7）——前端此前只按
 * `heartbeatTimeoutMs`（90s）展示，与真实窗口（90s × 确认轮数 + 一个扫描周期）
 * 不符，用户看到的数字是错的。
 *
 * 派生公式一旦散落在 service 里被复制（例如别处要算「判死窗口」时再写一遍
 * 乘法），就会出现两套口径 ⇒ UI 显示与真实行为再次脱节。故把公式本身
 * 收进纯函数，**一处定义、两处消费**。
 *
 * ## 行为等价性
 *
 * 三个派生值与原实现**逐字节等价**：
 * - `heartbeatTimeoutMs = heartbeatIntervalMs * heartbeatTimeoutMultiplier`；
 * - `effectiveOfflineAfterMs = heartbeatIntervalMs * heartbeatTimeoutMultiplier *
 *   staleOfflineConfirmations`；
 * - `listLimit` 取 `EXECUTOR_LIST_LIMIT`（与 findAll 的硬上限同源）。
 */

/** 运行期配置的数字面（`getRuntimeConfig` 的返回形状）。 */
export interface ExecutorRuntimeConfigNumbers {
  heartbeatIntervalMs: number;
  heartbeatTimeoutMultiplier: number;
  heartbeatTimeoutMs: number;
  staleOfflineConfirmations: number;
  effectiveOfflineAfterMs: number;
  listLimit: number;
}

/**
 * 由三项基础值派生运行期配置数字面（**纯函数**）。
 *
 * @param heartbeatIntervalMs 心跳间隔（毫秒）
 * @param heartbeatTimeoutMultiplier 心跳超时倍数
 * @param staleOfflineConfirmations 判死迟滞的确认轮数（≥1）
 */
export function deriveExecutorRuntimeConfigNumbers(input: {
  heartbeatIntervalMs: number;
  heartbeatTimeoutMultiplier: number;
  staleOfflineConfirmations: number;
}): ExecutorRuntimeConfigNumbers {
  const { heartbeatIntervalMs, heartbeatTimeoutMultiplier } = input;
  const staleOfflineConfirmations = input.staleOfflineConfirmations;
  return {
    heartbeatIntervalMs,
    heartbeatTimeoutMultiplier,
    heartbeatTimeoutMs: heartbeatIntervalMs * heartbeatTimeoutMultiplier,
    // NETOPT-G P1-7：判死迟滞的确认轮数，以及据此算出的**实际**判死窗口。
    // 前端此前只按 heartbeatTimeoutMs（90s）展示"多久判离线"，而迟滞上线后
    // 真实窗口 = heartbeatTimeoutMs × staleOfflineConfirmations（+ 一个扫描
    // 周期）。不暴露这两项会让 UI 显示与真实行为不符。
    staleOfflineConfirmations,
    effectiveOfflineAfterMs:
      heartbeatIntervalMs *
      heartbeatTimeoutMultiplier *
      staleOfflineConfirmations,
    listLimit: EXECUTOR_LIST_LIMIT,
  };
}

/**
 * 判死迟滞的确认轮数解析（**纯函数**）：非法值回退缺省 2。
 *
 * 与 service 内 `resolveStaleConfirmations()` 同口径（`>= 1` 且为有限数字，
 * 否则回退 2）。
 */
export function resolveStaleConfirmations(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 1) {
    return Math.floor(raw);
  }
  return 2;
}

/**
 * 心跳间隔解析（**纯函数**）：缺省 30000ms。
 *
 * ⚠️ 与 `configService.get<number>("executor.heartbeatInterval") || 30000`
 * **逐字节等价**——注意是 `||` 不是 `??`，所以 `0` 也会回退到 30000
 * （`0` 是 falsy）。这里保持 `||` 语义，不"顺手优化"成 `??`。
 */
export function resolveHeartbeatIntervalMs(raw: number | undefined): number {
  return raw || 30000;
}

/**
 * 心跳超时倍数解析（**纯函数**）：缺省 3。
 *
 * ⚠️ 同上，保持 `||` 语义（`0` 回退 3）。
 */
export function resolveHeartbeatTimeoutMultiplier(
  raw: number | undefined,
): number {
  return raw || 3;
}

/**
 * 接管静默窗解析（**纯函数**）：`executor.addressTakeoverSilenceMs`，
 * 非法值回退缺省（非法 = 非有限数或 < 0）。
 *
 * ⚠️ **注意 `0` 是合法值**（E-8：静默窗退化为零是危险配置但**合法**，判定是
 * `>= 0`），所以这里不能用 `||` 回退——必须显式判类型与范围。
 */
export function resolveAddressTakeoverSilenceMs(
  raw: unknown,
  fallback: number,
): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return raw;
  }
  return fallback;
}

/**
 * Shell 单引号转义（**纯函数**）：`'` → `'\''`。
 *
 * 用于把任意值安全嵌进 shell 单引号串里，防止 word-splitting / 注入。
 * 与既有实现逐字节等价（原为 `getInstallCmd` 内的局部闭包 `q`）。
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * 安装脚本 URL 构造（**纯函数**）：`{adminApiUrl}/api/executors/install.sh`。
 *
 * 尾斜杠被剥掉（`replace(/\/+$/, "")`），避免出现 `https://host//api/...`。
 */
export function buildInstallScriptUrl(adminApiUrl: string): string {
  return `${adminApiUrl.replace(/\/+$/, "")}/api/executors/install.sh`;
}

/**
 * 安装命令构造（**纯函数**）。
 *
 * R4-D P1-3 闭环：后端承载 `GET /api/executors/install.sh`（install-script.content.ts，
 * @Public 纯文本），安装命令从旧的 `npx autoflow-executor` 形式切回 curl|bash 形式。
 * `--api-url` 传 ADMIN_API_URL 原值（不含 /api 前缀，与 executor .env 语义一致），
 * `--secret` 传共享 token；两者经 `shellQuote` 转义防注入。
 */
export function buildInstallCmd(input: {
  adminApiUrl: string;
  sharedToken: string;
}): string {
  const scriptUrl = buildInstallScriptUrl(input.adminApiUrl);
  return `curl -fsSL ${shellQuote(scriptUrl)} | bash -s -- --api-url ${shellQuote(input.adminApiUrl)} --secret ${shellQuote(input.sharedToken)}`;
}
