/**
 * R15（2026-11-05）：`EXECUTOR_TOKEN_EPOCH_MODE=on` 时的**启动快照告警**。
 *
 * ## 为什么需要（运维债）
 *
 * R14 把 ADR-030 ②′ 落地为「确定性派生 + epoch CAS」，门控默认 `off`。一旦有人把它打开，
 * 有两个**只在运行期才看得出来**的配置错误会让跨实例幂等静默退化：
 *
 *   ① 派生密钥为空（`EXECUTOR_TOKEN_DERIVATION_SECRET` 与 `EXECUTOR_SECRET` 都没设）——
 *      此时 `deriveExecutorToken` 会**显式抛错**（绝不退化空密钥 HMAC），表现为取令牌 500；
 *   ② 派生密钥**回落成 `EXECUTOR_SECRET`**（即没单独设）—— 能跑，但把「执行器共享口令」
 *      复用成「令牌派生密钥」：任何知道共享口令的人都能算出任意已知 identity+epoch 的令牌，
 *      且换共享口令会连带影响派生。
 *
 * 与 R06 的 `executorPostureWarning` 同款形状：**模块顶层纯函数**（无 DI、无 IO），
 * 由 `main.ts` 在 bootstrap 期调用一次——不撑大 bootstrap 逻辑，也便于单测（注入 env）。
 *
 * 文案要求（同 R06）：**点名风险 + 给出可执行动作 + 指向运维手册**（docs/operations.md）。
 */

export const TOKEN_EPOCH_MODE_FLAG = "EXECUTOR_TOKEN_EPOCH_MODE";
export const TOKEN_DERIVATION_SECRET_FLAG = "EXECUTOR_TOKEN_DERIVATION_SECRET";
export const EXECUTOR_SHARED_SECRET_FLAG = "EXECUTOR_SECRET";

/** `EXECUTOR_TOKEN_EPOCH_MODE` 是否开启（只有显式 on/true/1 才算）。 */
function epochModeOn(env: Record<string, string | undefined>): boolean {
  const v = String(env[TOKEN_EPOCH_MODE_FLAG] ?? "").trim().toLowerCase();
  return v === "on" || v === "true" || v === "1";
}

/**
 * 返回**一条**告警文案（`null` = 无需告警）。
 *
 * 顺序：先报「密钥为空」（更严重，直接 500），再报「回落成共享口令」（可跑但违反分层）。
 */
export function tokenDerivationPostureWarning(
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (!epochModeOn(env)) return null;
  const derivation = String(env[TOKEN_DERIVATION_SECRET_FLAG] ?? "").trim();
  const shared = String(env[EXECUTOR_SHARED_SECRET_FLAG] ?? "").trim();
  if (!derivation && !shared) {
    return [
      `${TOKEN_EPOCH_MODE_FLAG}=on 但派生密钥缺失（${TOKEN_DERIVATION_SECRET_FLAG} / ${EXECUTOR_SHARED_SECRET_FLAG} 都为空）`,
      "⇒ 取令牌会直接失败（派生函数显式拒绝空密钥），执行器无法获得 per-executor 令牌",
      `修法：设置 ${TOKEN_DERIVATION_SECRET_FLAG}（≥32 字符随机串），或至少设置 ${EXECUTOR_SHARED_SECRET_FLAG}；`,
      "说明与轮换流程：docs/operations.md「轮换 per-executor 令牌派生密钥」",
    ].join("\n  ");
  }
  if (!derivation) {
    return [
      `${TOKEN_EPOCH_MODE_FLAG}=on 但未单独设置 ${TOKEN_DERIVATION_SECRET_FLAG}，正在回落使用 ${EXECUTOR_SHARED_SECRET_FLAG}`,
      "⇒ 共享口令被复用为派生密钥：知道它的人可算出任意已知 identity+轮换纪元的令牌（不扩大权限面，但违反凭据分层）；换共享口令会连带改变派生结果",
      `修法：单独设置 ${TOKEN_DERIVATION_SECRET_FLAG}（≥32 字符随机串）后滚动重启；**不要与 ${EXECUTOR_SHARED_SECRET_FLAG} 相同**`,
      "轮换流程与失效半径：docs/operations.md「轮换 per-executor 令牌派生密钥」",
    ].join("\n  ");
  }
  return null;
}
