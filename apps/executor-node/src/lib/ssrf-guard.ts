/**
 * E-04（DEEP_REVIEW 0ef3bbe）：SSRF 防护闸——deploy/update-package/download
 * 三条下载链统一调用。execute.ts 原有的内联 privateIpPattern 仅覆盖 RFC1918
 * 点分十进制与 loopback，遗漏云元数据地址 169.254.0.0/16、IPv6 link-local
 * 与十进制/八进制编码 IP。本模块收口为单一 fail-closed 闸：
 *
 * - 默认拒绝 loopback、RFC1918 私网、link-local（含 169.254.169.254 云元数据）、
 *   IPv6 UDA/link-local；
 * - `EXECUTOR_ALLOW_PRIVATE_NETWORK=true`（`1` 亦兼容）显式逃生（容器内联调用 admin-api 本机
 *   等合法内网场景需显式选择）；
 * - redirect 链递归调用 downloadFile 时也经过同一闸。
 */

import { config } from '../config';
import * as dns from 'node:dns';
// R08（2026-11-05，ADR-029）：元数据地址恒拒 —— 地址表来自契约生成物，三端同读。
import { METADATA_ADDRESSES } from '../generated/protocol-metadata-addresses';
// R90（ADR-034 步骤 2）：类别表与「开关可解锁集合」来自**契约生成物**（不再硬编码）。
import { ALLOWED_UNDER_PRIVATE } from '../generated/protocol-categories';

export interface SsrfGuardOptions {
  /** Skip the private-network check (e.g. tests hitting 127.0.0.1). */
  allowPrivateNetwork?: boolean;
}

import {
  categoryAllowed,
  isLoopbackHostname,
  verdictForAddress,
  classifyRestrictedIpv4 as classifyRestrictedIpv4Pure,
  classifyRestrictedIpv6 as classifyRestrictedIpv6Pure,
  isMetadataAddress as isMetadataAddressPure,
  isRestrictedAddressForPolicy as isRestrictedAddressForPolicyPure,
  isRestrictedHost as isRestrictedHostPure,
  isRestrictedIpv4 as isRestrictedIpv4Pure,
  isRestrictedIpv6Address as isRestrictedIpv6AddressPure,
  type RestrictedCategory,
} from './address-category';

/**
 * R77：地址分类与开关表的**唯一实现**已搬到零依赖模块 `./address-category`
 * （仓外探针可直接 require）。这里保留同名包装 + 原签名：包装只做一件事 ——
 * 把契约恒拒表（生成物）作为入参传进去，既有调用方与 spec 无需改动。
 */
export type { RestrictedCategory };
export { categoryAllowed };
export function isMetadataAddress(hostRaw: string): boolean {
  return isMetadataAddressPure(hostRaw, METADATA_ADDRESSES);
}
export function isRestrictedAddressForPolicy(hostRaw: string): RestrictedCategory | null {
  return isRestrictedAddressForPolicyPure(hostRaw, METADATA_ADDRESSES);
}
export function classifyRestrictedIpv4(ip: string): RestrictedCategory | null {
  return classifyRestrictedIpv4Pure(ip, METADATA_ADDRESSES);
}
export function classifyRestrictedIpv6(ipv6Raw: string): RestrictedCategory | null {
  return classifyRestrictedIpv6Pure(ipv6Raw, METADATA_ADDRESSES);
}
export function isRestrictedIpv4(ip: string): boolean {
  return isRestrictedIpv4Pure(ip, METADATA_ADDRESSES);
}
export function isRestrictedIpv6Address(ipv6Raw: string): boolean {
  return isRestrictedIpv6AddressPure(ipv6Raw, METADATA_ADDRESSES);
}
export function isRestrictedHost(hostname: string): boolean {
  return isRestrictedHostPure(hostname, METADATA_ADDRESSES);
}

/**
 * Validate that an http(s) URL does not target a restricted network address.
 * Throws an Error (fail-closed) when the host is loopback/private/link-local
 * and `allowPrivateNetwork` (or `EXECUTOR_ALLOW_PRIVATE_NETWORK`) is not set.
 */
export function assertSafeHttpUrl(url: string, options: SsrfGuardOptions = {}): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`无效的 URL：${url}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`不允许的 URL 协议：${parsed.protocol}。仅允许 http 与 https。`);
  }

  const allow = options.allowPrivateNetwork === true || config.allowPrivateNetwork === true;
  // R84（ADR-034 §9 步骤 2）：**唯一判决入口** —— 恒拒表优先 → 分类 → 开关只放行
  // privateIPv4 这三步由零依赖模块 `verdictForAddress` 一次给出；这里只负责把结论
  // 渲染成既有的**错误文案形状**（保持既有断言不变）。
  const host = parsed.hostname;
  const verdict = verdictForAddress(host, allow, METADATA_ADDRESSES, ALLOWED_UNDER_PRIVATE);
  if (!verdict.allowed) {
    // R08/ADR-029：元数据地址有专门的文案（说明「任何开关都不放行」）。
    if (verdict.metadata) {
      throw new Error(
        `URL 指向受限网络地址（云元数据，契约 networkPolicy.metadataAddresses 恒拒）：${host}。` +
        '任何 EXECUTOR_ALLOW_PRIVATE_NETWORK 取值都不会放行。',
      );
    }
    const category = verdict.category;
    throw new Error(
      allow
        ? `URL 指向受限网络地址：${host}（类别 ${String(category)}）。` +
          'EXECUTOR_ALLOW_PRIVATE_NETWORK 只放行 privateIPv4（契约 networkPolicy.switch）——' +
          'loopback / linkLocal（含云元数据）/ cgnat / unspecified / multicast / reserved ' +
          '在任何开关状态下都拒绝。'
        : `URL 指向受限网络地址：${host}（类别 ${String(category)}）。` +
          '私有/回环/link-local 地址已被阻断。' +
          '如需放行 privateIPv4，请设置 EXECUTOR_ALLOW_PRIVATE_NETWORK=true（或 1）（生产环境不建议）。',
    );
  }
}

/**
 * 闸校验过后交回调用方的**已校验地址表**（R74-A1）。
 * 调用方（download.ts）把它变成 http.request 的 `lookup`，让「校验时解析的
 * 地址」与「连接时用的地址」是同一张表。字面 IP / localhost / 逃生阀路径返回
 * 空表——那几条路径不需要（也不该）钉扎。
 */
export interface SsrfResolvedAddress {
  address: string;
  family: number;
}

/**
 * S-1（audit-r4）：DNS rebinding 加固——把「URL 语法级闸」（assertSafeHttpUrl）
 * 升级为「解析后 IP 级闸」。语法级检查只认字面 IP 与 localhost；攻击者注册的
 * 域名第一次解析返回公网 IP 通过语法闸、连接时二次解析返回内网 IP，即可绕过
 * 字面检查。本函数在**发起连接前**解析主机名，对解析出的**每一个** A/AAAA
 * 地址逐一过受限判定，任一受限即 fail-closed；解析失败同样拒绝（无法证明目标
 * 安全就不连，与闸的 fail-closed 纪律一致）。
 *
 * R74-A1：resolve-then-connect 的 TOCTOU 窗口**已被关闭**——返回的地址表由
 * download.ts 用 http.request 的 `lookup` 选项钉扎，连接期不再发起第二次 DNS
 * 查询（见 download.ts createPinnedLookup）。因此本函数的返回值是安全相关的
 * 承重件，不要为了“少一个返回值”把它改回 void。
 */
export async function assertSafeDnsResolution(
  url: string,
  options: SsrfGuardOptions = {},
): Promise<SsrfResolvedAddress[]> {
  const allow = options.allowPrivateNetwork === true || config.allowPrivateNetwork === true;
  // R63：开关**不再**跳过 DNS 级复核。旧实现 `if (allow) return [];` 在解析之前
  // 返回 ⇒ 攻击者控制的域名把 A 记录指到 `169.254.169.254` 即可绕过恒拒表
  // （恒拒表判的是 URL 里的**主机名**，不是解析结果），开关开启 = 元数据可达。
  // 现在的口径与语法面一致：逐地址分类，只有 privateIPv4 随开关放行。
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`无效的 URL：${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    // 独立调用时的纵深防御：download 链路上游已过 assertSafeHttpUrl，
    // 但本函数不应在未校验 scheme 的情况下对任意协议发起解析。
    throw new Error(`不允许的 URL 协议：${parsed.protocol}。仅允许 http 与 https。`);
  }
  const host = parsed.hostname;
  // R86：**两层纵深**——语法闸（`assertSafeHttpUrl` → `verdictForAddress`）必须能
  // **独立**定性 localhost 系与字面 IP；本 DNS 面只是「不必再查」的执行层，不能
  // 反过来当作判定依据。故这里的跳过集合与语法闸**同一份**
  // （`address-category.isLoopbackHostname`，= admin 同集：localhost /
  // localhost.localdomain / *.localhost，含尾点归一化）。
  if (isLoopbackHostname(host)) return [];
  if (/^[\d.]+$/.test(host) || host.includes(':')) return [];

  let addresses: Array<{ address: string; family: number }>;
  try {
    // dns.promises.lookup 的 all:true 重载返回 LookupAddress[]、all:false 返回
    // LookupAddress——union 在 Array.isArray 收窄时会被推成 never，这里显式
    // 声明并收窄到稳定的「{address,family}」形状。
    const result: unknown = await dns.promises.lookup(host, { all: true, verbatim: true });
    addresses = Array.isArray(result)
      ? (result as Array<{ address: string; family: number }>)
      : [{ address: (result as { address: string; family: number }).address, family: (result as { address: string; family: number }).family }];
  } catch {
    // 解析失败 = 无法证明安全：fail-closed，绝不带病连接。
    throw new Error(
      `URL 主机 ${host} DNS 解析失败；拒绝连接（SSRF 防护）`,
    );
  }
  // 空地址表同样是「无法证明安全」：没有可校验、可钉扎的目标就不能连。
  if (addresses.length === 0) {
    throw new Error(`URL 主机 ${host} 未解析出任何地址；拒绝连接（SSRF 防护）`);
  }
  for (const { address } of addresses) {
    // R84：解析结果同样过**唯一判决入口**（含恒拒表 + 类别表 + 开关）。
    const verdict = verdictForAddress(address, allow, METADATA_ADDRESSES, ALLOWED_UNDER_PRIVATE);
    if (!verdict.allowed) {
      const category = verdict.category;
      throw new Error(
        `URL 主机 ${host} 解析到受限网络地址 ${address}；` +
          `类别 ${String(category)}。疑似 DNS rebinding。` +
          (allow
            ? 'EXECUTOR_ALLOW_PRIVATE_NETWORK 只放行 privateIPv4（契约 networkPolicy.switch）。'
            : '私有/回环/link-local 地址已被阻断。' +
              '如需放行 privateIPv4，请设置 EXECUTOR_ALLOW_PRIVATE_NETWORK=true（或 1）（生产环境不建议）。'),
      );
    }
  }
  // 交回已校验的地址表供连接期钉扎（TOCTOU 收口，见 createPinnedLookup）。
  return addresses.map(({ address, family }) => ({
    address,
    family: address.includes(':') ? 6 : family || 4,
  }));
}

/**
 * R72（2026-11-06，Lead 裁决方案 A）：**accept 期** DNS 预闸的超时（fail-closed）。
 *
 * 契约 `networkPolicy.resolution.mode = "dns-resolve"` + `onResolutionFailure = "deny"`
 * + `enforcement.stage = "accept"` ⇒ 主机名形态的 `packageUrl` / `gitRepo` 必须在
 * **accept 期**解析并逐地址判定，否则「先接单（占容量槽、admin 记 RUNNING）再异步失败」。
 *
 * 超时值的来源（R72 实测，见 artifacts/autonomy/R72-node/measurement.md）：
 * 公网冷查询 184–210 ms、内网 NXDOMAIN 33 ms、热缓存 <5 ms ⇒ **2 s 留约 10× 余量**；
 * 之所以要超时：`dns.lookup` 走 getaddrinfo，**没有内建短超时**，解析器不响应时可拖到
 * 系统级（秒级），而 accept 在派发关键路径上。
 */
export const ACCEPT_STAGE_DNS_TIMEOUT_MS = 2_000;

/**
 * `assertSafeDnsResolution` 的**有界**版本：超过 `timeoutMs` 未解析完 ⇒ 按 fail-closed 拒绝。
 *
 * 注意：底层 `getaddrinfo` 无法中断，超时只让**调用方**不再等待（迟到的结果被丢弃）；
 * 这不影响安全性——拒绝已经发生，连接永远不会建立。
 */
export async function assertSafeDnsResolutionWithTimeout(
  url: string,
  options: SsrfGuardOptions = {},
  timeoutMs: number = ACCEPT_STAGE_DNS_TIMEOUT_MS,
): Promise<SsrfResolvedAddress[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      assertSafeDnsResolution(url, options),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(`URL 的 DNS 解析超时（>${timeoutMs}ms）；拒绝连接（SSRF 防护）`),
          );
        }, timeoutMs);
        // 不拖住进程退出（服务端常驻进程无影响；单测里保证 jest 能干净退出）。
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
