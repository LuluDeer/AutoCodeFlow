import { createHmac } from "node:crypto";

/**
 * ADR-030 §4（②′）的**确定性令牌派生**（R14 落地）。
 *
 * ## 为什么是确定性派生（而不是随机令牌 + 明文缓存）
 *
 * 跨实例幂等的死结是「失败的那一方拿不到明文」：bcrypt 单向 ⇒ 读库只能得到哈希，
 * 而调用方要的是可用的 bearer。ADR-030 的解法是让**同一组输入派生出同一枚令牌**：
 *
 *   token = HMAC-SHA256(K, identityKey ‖ "\0" ‖ startupEpoch ‖ "\0" ‖ rotationEpoch)
 *
 * 于是并发双方（都读到 epoch=E）算出的是**逐字节相同**的令牌；赢家把 `bcrypt(token)`
 * 落库并把 epoch 推到 E+1，输家拿自己算的 `token` 去 `bcrypt.compare` 库里的新哈希 ——
 * 命中就说明「赢家写的就是这一枚」，直接把**同一枚**令牌返回。**全程没有任何明文落库/落中间件。**
 *
 * ## 输入必须逐字节稳定
 *
 * · `identityKey` —— 现有 `tokenCacheIdentityKey(address, deviceFingerprint)`（定位身份）；
 * · `startupEpoch` —— 该行的 `executorStartupId`（重启会变 ⇒ 令牌随进程生命换代）；
 * · `rotationEpoch` —— `executors.tokenRotationEpoch`（只增；是本函数的版本号）。
 *
 * 分隔符用 `\0`：三段都可含 `.`/`:`/`-`（address、fingerprint、startupId 都可能），
 * 用可打印字符做分隔会有**拼接歧义**（`a|b` + `c` 与 `a` + `b|c` 相撞），`\0` 不会出现在三者中。
 *
 * ## 安全边界（ADR-030 §5.4）
 *
 * 派生密钥泄露 ⇒ 可算出**已知 identity+epoch** 的令牌。但这**不扩大**权限面：
 * 持有共享 `EXECUTOR_SECRET` 的一方今天就能对任意地址调 `POST /executors/token` 直接取明文。
 * 故 `EXECUTOR_TOKEN_DERIVATION_SECRET` 缺省回落 `EXECUTOR_SECRET`（灰度可用），
 * 但换密钥会让**所有派生令牌立即失效**（执行器 401 后自愈，代价是一次全机队轮换）。
 */
export function deriveExecutorToken(input: {
  secret: string;
  identityKey: string;
  startupEpoch: string;
  rotationEpoch: number;
}): string {
  if (!input.secret) {
    // 派生密钥为空 ⇒ 显式失败，绝不静默退化成"空密钥 HMAC"（那会让令牌可被任何人算出）。
    throw new Error("令牌派生失败：派生密钥为空（EXECUTOR_TOKEN_DERIVATION_SECRET / EXECUTOR_SECRET 均未设置）");
  }
  const payload = `${input.identityKey}\u0000${input.startupEpoch}\u0000${input.rotationEpoch}`;
  return createHmac("sha256", input.secret).update(payload, "utf8").digest("hex");
}

/** `EXECUTOR_TOKEN_EPOCH_MODE` 的解析：只有显式 `on`/`true`/`1` 才算开（默认 **off**）。 */
export function isTokenEpochModeOn(raw: string | null | undefined): boolean {
  const v = String(raw ?? "").trim().toLowerCase();
  return v === "on" || v === "true" || v === "1";
}

/** 派生用的 startup 段：缺失（legacy）统一成空串，保证两方一致。 */
export function startupEpochOf(startupId: string | null | undefined): string {
  return String(startupId ?? "").trim();
}
