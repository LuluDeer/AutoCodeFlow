/**
 * R74：**webhook 出站姿态的纯函数**（无 Nest DI、不读 env、不做 IO）。
 *
 * ## 为什么要有这个文件
 *
 * admin 的出站闸都住在 `safe-http.util.ts`，而那个文件的顶部有 8 个 import
 * （`@nestjs/config` 链路的 `AppError` / `ErrorCode` / `getEnvVar` / `node:http` /
 * `node:https` / `node:dns/promises` …）。⇒ 想让**仓外**的判据（`scripts/` 里的
 * 四向检查）**真跑** admin 的 webhook 姿态，只能：
 *   ① 用 admin-api 自己的 `ts-node/register` 起子进程探针（那是 executor 面
 *      已经在用的做法，见 `scripts/check-protocol-three-way.mjs` 的 admin 探针）；
 *   ② 或把「判定」本身抽成一个**零依赖**的纯函数，让探针只需 require 它。
 *
 * 本文件是 ②：**姿态判定**与「抛哪个错误码」「怎么解析 URL」「怎么做 DNS 钉住」
 * 这些**带基础设施**的事分开。`safe-http.util.ts` 改为**逐字委托**给这里 ⇒
 * 行为零变化；而仓外探针可以直接 require 本文件（**不需要 Nest、不需要 ts-node
 * 的 tsconfig 解析链**），把 webhook 面纳入四向判据。
 *
 * ## 判定语义（契约 `networkPolicy`）
 *
 * 顺序是**三层**，不可调换：
 *   ① **恒拒表**（`metadataAddresses`）—— 任何 posture × 任何开关状态都 DENY，
 *      且**先于**分类（ADR-029 的硬要求 ②）；
 *   ② **风险分类** —— `public` / `private-lan` / `loopback` / `link-local` /
 *      `restricted` / `reserved`（admin 的粗标签体系；见 ADR-033 §2.2）；
 *   ③ **开关** —— 契约 `switch.semantics`：「开关开启 ⇒ 放行 privateIPv4；
 *      其余五类一律仍拒」。⇒ 开关的**唯一**效果是解锁 `private-lan`。
 *
 * 本文件**只管 ②③**（① 需要那张地址表，由调用方以入参传入 ⇒ 本文件零依赖）。
 */

/** admin 侧的粗标签（与 `safe-http.util.ts` 的 `AddressRisk` 逐字一致）。 */
export type OutboundRisk =
  | "public"
  | "private-lan"
  | "loopback"
  | "link-local"
  | "restricted"
  | "reserved"
  // R91（ADR-034 步骤 4）：admin 标签拆细后新增的两值。
  // **判定不受影响**：本函数的 allow-list 只认 `public` / `private-lan`，
  // 其余标签（含这两个）一律 `category_denied` —— 行为零变化。
  | "unspecified"
  | "multicast";

/** 出站姿态（= `safe-http.util.ts` 的 `policy` 入参）。 */
export type OutboundPosture = "webhook" | "executor";

/** 判定结果。 */
export interface OutboundPostureVerdict {
  /** 是否放行。 */
  allowed: boolean;
  /**
   * 该地址的风险类别（`public` 表示不受限）。
   * 调用方可以据此拼「拒绝名单」之类的文案 ⇒ 判定与理由分离。
   */
  risk: OutboundRisk;
  /**
   * **可断言的理由**（稳定枚举，不含文案）：
   *   · `public` —— 不受限；
   *   · `metadata` —— 命中恒拒表（先于分类）；
   *   · `category_denied` —— 该类别在当前姿态/开关下不放行；
   *   · `private_allowed` —— 私网，因开关开启而放行。
   */
  reason: "public" | "metadata" | "category_denied" | "private_allowed";
}

/** 判定输入（全部由调用方提供 ⇒ 本函数不读 env、不做 IO）。 */
export interface OutboundPostureInput {
  /** 目标地址的风险类别（`null` = 不受限/公网）。 */
  risk: OutboundRisk | null;
  /** 是否命中恒拒表（`metadataAddresses`）。 */
  metadata: boolean;
  /** 开关状态（= `EXECUTOR_ALLOW_PRIVATE_NETWORK` / `allowPrivateNetwork`）。 */
  allowPrivateNetwork: boolean;
  /** 姿态：`webhook` 或 `executor`（两者当前同构，见 ADR-033 §3.3）。 */
  posture: OutboundPosture;
}

/**
 * 出站姿态的**唯一**判定。
 *
 * 纯函数：同一输入必然同一输出，无 IO、无 env、无 DI。
 *
 * @param input 判定输入
 * @returns 放行/拒绝 + 类别 + 可断言理由
 */
export function evaluateOutboundPosture(
  input: OutboundPostureInput,
): OutboundPostureVerdict {
  const { risk, metadata, allowPrivateNetwork } = input;
  // `posture` 当前**不参与判定**：webhook 面与 executor 面在 R66 之后逐类同构
  // （ADR-033 §3.3 的跨端全表）。但它**必须留在签名里**：
  //   · 契约的 posture 维度是真实的（`networkPolicy.enforcement` 逐条列 posture），
  //     仓外判据要能表达「这一格是哪个 posture 的结论」；
  //   · 将来任一面若收窄，这里能只改一处。
  // ⇒ 显式消费它（void 读取），避免 lint 报「未使用」而误导后来者以为漏了。
  void input.posture;
  // ① 恒拒表先于分类（ADR-029 硬要求 ②）。
  if (metadata) {
    return { allowed: false, risk: risk ?? "reserved", reason: "metadata" };
  }
  // ② 不受限（公网）⇒ 放行。
  if (risk === null || risk === "public") {
    return { allowed: true, risk: "public", reason: "public" };
  }
  // ③ 私网：开关的**唯一**效果就是解锁它（契约 switch.semantics）。
  if (risk === "private-lan") {
    return allowPrivateNetwork
      ? { allowed: true, risk, reason: "private_allowed" }
      : { allowed: false, risk, reason: "category_denied" };
  }
  // ④ 其余类别（loopback / link-local / restricted / reserved）任何开关状态都拒。
  return { allowed: false, risk, reason: "category_denied" };
}
