/**
 * R2-1/P1b · A7：gitRepo 出站地址的 **networkPolicy** 闸（按协议契约实现）。
 *
 * ## 为什么单独一个模块
 *
 * 改前（A7 之前）`routes/execute.ts` 的 accept 段用的是**两条字符串正则**
 * （`privateIpPattern` / `loopbackPattern`），只认 RFC1918 点分十进制与
 * `localhost`/`127.x` ⇒ 下列地址**全部放行**并进入 `git clone`：
 *
 *   · `169.254.169.254` —— **云元数据**（link-local，SSRF 头号目标）
 *   · `fd00:ec2::254`   —— AWS IPv6 元数据（ULA 段）
 *   · `[::1]`           —— IPv6 回环
 *   · `0.0.0.0`         —— 未指定地址（Linux 上「连本机」语义）
 *   · `100.64.0.1`      —— CGNAT 100.64.0.0/10
 *
 * 而 python 侧（`routers/execute.py` 的 `_host_is_restricted`）早已覆盖这些。
 * ⇒ **同一份任务在 python 执行器被拒、在 node 执行器放行**。本模块把 node 侧
 * 对齐到 `packages/executor-protocol/protocol.json` 的 `networkPolicy` 段。
 *
 * ## 与既有 `lib/ssrf-guard.ts` 的关系（**不是重复实现**）
 *
 * `ssrf-guard.ts` 的受限判定本身**已经覆盖全部七类**（见其 `isRestrictedIpv4`
 * / `isRestrictedIpv6Groups`）。它的问题在**开关语义**：
 *
 * ```ts
 * const allow = options.allowPrivateNetwork === true || config.allowPrivateNetwork === true;
 * if (allow) return;          // ← 开关开启 ⇒ **直接放行一切**
 * ```
 *
 * 而契约 `networkPolicy.switch` 明确规定：**开关的唯一效果是放行私网 IPv4**；
 * loopback / link-local / CGNAT / unspecified / multicast / reserved
 * **在任何开关状态下都拒**。
 *
 * ⇒ 本模块不重写受限判定，而是**复用** `ssrf-guard` 的判定并补上**分类**
 * （知道「是哪一类」才能按契约决定开关能不能放行它）。这样：
 *   · 七类地址清单只有一份（ssrf-guard 的按位判定是权威）；
 *   · 开关语义只有一份（契约 `networkPolicy.switch`）；
 *   · 两者的组合规则只在本模块。
 *
 * ## 为什么有 sync + async 两个入口
 *
 * `acceptExecution` 是**同步函数**（HTTP 路由与 pull 循环都同步调用它），
 * 而契约 `networkPolicy.resolution.mode = "dns-resolve"` 要求**真实 DNS 解析**。
 * 二者不可兼得 ⇒ 拆成两步：
 *   · `assertGitRepoNetworkPolicy`（**sync**）：只判 **IP 字面量 + localhost
 *     同义词**（这些不需要解析）。放在 `acceptExecution` 内，保证
 *     「IP 字面量形态在 accept 期同步 400」。
 *   · `assertGitRepoNetworkPolicyResolved`（**async**）：在前者基础上对
 *     **主机名**做 DNS 解析，逐地址判定，解析失败 **fail-closed**。
 *     调用方（HTTP 路由 / pull 循环）在 `acceptExecution` **之前** await 它。
 *
 * 两个入口都属「accept 期」（登记/占容量之前）⇒ 满足契约
 * `enforcement.stage = "accept"`。
 *
 * ## fail-closed 纪律
 *
 * 解析失败、解析出空地址表、任一地址受限 ⇒ **一律拒绝**（无法证明安全就不连）。
 * 与 `ssrf-guard.assertSafeDnsResolution` 同姿态（其注释已声明同一纪律）。
 */
import { config } from './config';
import { categoryAllowed, isRestrictedAddressForPolicy } from './lib/ssrf-guard';

/**
 * 契约 `networksPolicy.addresses` 的七类。
 * 与 `protocol.json` 的键名**逐字对应**（守卫 spec 会比对）。
 */
export type RestrictedCategory =
  | 'loopback'
  | 'privateIPv4'
  | 'linkLocal'
  | 'cgnat'
  | 'unspecified'
  | 'multicast'
  | 'reserved';

/** 提取 gitRepo 三种合法形态里的主机名（空串 = 取不到）。 */
export function gitRepoHost(raw: string): string {
  if (!raw) return '';
  // scp-like：git@host:path（没有 `//` 段，URL 解析器给不出 hostname）
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):/.exec(raw);
  if (scp && !raw.includes('://')) return scp[1].toLowerCase();
  try {
    const u = new URL(raw);
    return (u.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return scp ? scp[1].toLowerCase() : '';
  }
}

/** 该执行器是否允许私网（契约 `networkPolicy.switch.envVar`）。 */
export function privateNetworkAllowed(): boolean {
  return config.allowPrivateNetwork === true;
}

/**
 * 按契约决定「这个分类的地址能否放行」。
 *
 * 契约 `networkPolicy.switch` 的唯一语义：**开关只放行 privateIPv4**；
 * 其余六类在任何开关状态下都拒。
 *
 * R63（2026-11-06）：实现已上收到 `lib/ssrf-guard.ts`，此处**只做再导出** ——
 * 下载面（`assertSafeHttpUrl` / `assertSafeDnsResolution`）与 gitRepo 面从此共用
 * 同一份表。此前下载面走的是 `if (allow) return;`（开关开启 ⇒ 放行一切），
 * 于是同一个 `EXECUTOR_ALLOW_PRIVATE_NETWORK` 在两条出站通道上给出相反结论
 * （`169.254.169.254`：gitRepo 拒 / 下载放行），正是 ADR-032 记录的 python 同族
 * 缺陷。保留本导出名是为了既有调用方与 spec 的稳定引用点。
 */
export { categoryAllowed };

/** 主机名是否是 localhost 同义词（不需要 DNS）。 */
function isLocalhostSynonym(host: string): boolean {
  return (
    host === 'localhost' ||
    host === 'localhost.localdomain' ||
    host.endsWith('.localhost')
  );
}

export interface GitRepoPolicyOptions {
  /** 显式覆盖开关（测试用）；缺省读 `config.allowPrivateNetwork`。 */
  allowPrivateNetwork?: boolean;
}

/**
 * **同步**闸：只判 IP 字面量与 localhost 同义词（不需要 DNS）。
 *
 * 供 `acceptExecution` 内调用 —— 保证「IP 字面量形态在 accept 期同步 400」。
 * 主机名形态在这里**放行**（留待 async 版做 DNS），故调用方**必须**在
 * `acceptExecution` 之前再调 `assertGitRepoNetworkPolicyResolved`。
 *
 * @throws Error（文案与 node 既有 gitRepo 闸同形：「gitRepo URL 指向受限网络地址：<url>」）
 */
export function assertGitRepoNetworkPolicy(
  gitRepo: string,
  options: GitRepoPolicyOptions = {},
): void {
  const host = gitRepoHost(gitRepo);
  if (!host) return; // 主机名都取不到：由上游 URL 形态闸处理
  const allowPrivate =
    options.allowPrivateNetwork ?? privateNetworkAllowed();

  // localhost 同义词：loopback 类，任何开关都拒。
  if (isLocalhostSynonym(host)) {
    throw new Error(`gitRepo URL 指向受限网络地址：${gitRepo}`);
  }
  // 只看**字面 IP**（含 IPv6）；主机名交给 async 版解析。
  const category = isRestrictedAddressForPolicy(host);
  if (category === null) return; // 公网 IP 或不认识的形状（主机名）→ 放行
  if (!categoryAllowed(category, allowPrivate)) {
    throw new Error(`gitRepo URL 指向受限网络地址：${gitRepo}`);
  }
}

/**
 * **异步**闸：在同步闸基础上，对**主机名**做 DNS 解析并逐地址判定。
 *
 * 调用方（HTTP 路由 / pull 循环）必须在 `acceptExecution` **之前** await。
 * 解析失败 ⇒ fail-closed（拒绝）。
 *
 * @throws Error（与同步闸同形文案；DNS 失败另有后缀说明）
 */
export async function assertGitRepoNetworkPolicyResolved(
  gitRepo: string,
  options: GitRepoPolicyOptions = {},
  resolve?: (host: string) => Promise<string[]>,
): Promise<void> {
  // 先跑同步闸（IP 字面量 / localhost 在这里就拒掉）。
  assertGitRepoNetworkPolicy(gitRepo, options);

  const host = gitRepoHost(gitRepo);
  if (!host) return;
  // 字面 IP 已被同步闸处理过，无需解析。
  if (/^[\d.]+$/.test(host) || host.includes(':')) return;
  if (isLocalhostSynonym(host)) return; // 同步闸已拒，走不到这里

  const allowPrivate =
    options.allowPrivateNetwork ?? privateNetworkAllowed();

  // 可注入的解析器（测试用）；生产走 dns.promises.lookup（all:true）。
  let addresses: string[];
  try {
    if (resolve) {
      addresses = await resolve(host);
    } else {
      const dns = await import('node:dns');
      const result = await dns.promises.lookup(host, { all: true, verbatim: true });
      addresses = (Array.isArray(result) ? result : [result]).map(
        (r: { address: string }) => r.address,
      );
    }
  } catch {
    // fail-closed：解析不出来 = 无法证明安全。
    throw new Error(
      `gitRepo URL 指向受限网络地址：${gitRepo}` +
        `（主机 ${host} DNS 解析失败，fail-closed）`,
    );
  }
  if (addresses.length === 0) {
    throw new Error(
      `gitRepo URL 指向受限网络地址：${gitRepo}` +
        `（主机 ${host} 未解析出任何地址，fail-closed）`,
    );
  }
  for (const address of addresses) {
    const category = isRestrictedAddressForPolicy(address);
    if (!categoryAllowed(category, allowPrivate)) {
      throw new Error(
        `gitRepo URL 指向受限网络地址：${gitRepo}` +
          `（主机 ${host} 解析到 ${address}，类别 ${category}）`,
      );
    }
  }
}
