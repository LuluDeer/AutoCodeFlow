/**
 * R239：**accept 期 DNS 预闸的可注入解析器** —— 独立模块，让测试结果不再取决于跑它的机器。
 *
 * ## 为什么需要（真实缺陷：同一份代码在不同机器上给出不同结论）
 *
 * `assertGitRepoNetworkPolicyResolved`（`git-repo-network-policy.ts:232`）**本来就接受**
 * 第 3 个参数 `resolve?: (host) => Promise<string[]>`，注释写着「可注入的解析器（测试用）」。
 * 但 `routes/execute.ts` 调用时**没传** ⇒ 生产走真实 `dns.promises.lookup`，**测试也走真实 DNS**。
 *
 * 后果（实测于一台开了代理的机器）：`example.com` 被 fake-IP 解析到 `198.18.1.104`
 * （RFC 2544 保留段，Clash/Surge 等的 fake-IP 常用段）⇒ 12 个用 `example.com` 的用例
 * 全部变 `400`；而它们失败后注册的 `mockImplementationOnce` **不会被消费**
 * （`jest.clearAllMocks()` 不清 Once 队列，R237 已实证）⇒ **泄漏到后面 16 个无关用例**
 * ⇒ 一次出现 **28 个红**，而**全部单跑都绿**。
 *
 * ## 为什么放在独立模块而不是 `execute.ts` 里
 *
 * `execute.ts` 已在体量棘轮上限边缘（「只减不增」）。这段是**纯粹的测试缝**，
 * 与路由逻辑无关，抽出来同时满足：文件回到基线内、缝本身有单一可读入口。
 *
 * ## 生产行为
 *
 * 默认值 = 真实 `dns.promises.lookup`（**逐字节等价于改动前**）。
 * 只有显式调用 `__setGitRepoDnsResolverForTest` 才会改变 —— 而它只在 spec 里被调用。
 */

/** 解析器签名：主机名 → 地址列表。与 `git-repo-network-policy.ts` 的第 3 参数同形。 */
export type DnsResolver = (host: string) => Promise<string[]>;

const realDnsResolver: DnsResolver = async (host: string) => {
  const dns = await import("node:dns");
  const result = await dns.promises.lookup(host, { all: true, verbatim: true });
  return (Array.isArray(result) ? result : [result]).map((r) => r.address);
};

let activeResolver: DnsResolver = realDnsResolver;

/** 当前生效的解析器（生产恒为真实 DNS）。 */
export function gitRepoDnsResolver(host: string): Promise<string[]> {
  return activeResolver(host);
}

/**
 * **仅供测试**：替换解析器。传 `null` 恢复真实 DNS。
 *
 * 约定：spec 的 `beforeEach` 装固定表、`afterEach` 传 `null` 恢复 ——
 * 与 `__resetBwrapPathCacheForTest` 同一纪律（模块级可变状态必须成对复位）。
 */
export function __setGitRepoDnsResolverForTest(next: DnsResolver | null): void {
  activeResolver = next ?? realDnsResolver;
}