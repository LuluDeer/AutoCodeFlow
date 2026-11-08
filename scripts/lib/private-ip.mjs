#!/usr/bin/env node
/**
 * 自检用的**宿主私网地址**探测（零依赖，可被多个 .mjs 自检共用）。
 *
 * ## 为什么需要它
 *
 * 契约 `networkPolicy.addresses` 把出站地址分成几类，其中两类的处置**完全不同**：
 *
 *   · `privateIPv4`（RFC1918）—— `allowedUnderPrivateNetwork: true`
 *     ⇒ 私网**默认拒**，`EXECUTOR_ALLOW_PRIVATE_NETWORK=true` /
 *       `EVENT_WEBHOOK_ALLOW_PRIVATE_NETWORK=true` 时**放行**；
 *   · `loopback`（127.0.0.0/8、::1、localhost 系主机名）——
 *     `allowedUnderPrivateNetwork: false`，且契约 `switch.semantics` 逐字写明
 *     「loopback（打自己回环）在**任何**开关状态下都拒」。
 *
 * 于是：**自检若想在真机上起一个「真 HTTP 接收端」并让闸放行**，唯一合规的
 * 做法就是把接收端放在**宿主私网地址**上，而不是 loopback。
 *
 * 这不是"为了让自检绿而放宽闸"——恰恰相反：原自检用 loopback URL，**在契约
 * P1a 收紧后必然被闸恒拒**（实测 `SSRF_HOST_DENIED`），是自检的前提失效了。
 * 改用私网地址后，开关**真正起作用**（这才是这些自检本想验证的形态）。
 *
 * ## 为什么是"探测"而不是"写死 172.17.0.1"
 *
 * 写死 docker0 的地址在「docker 装了但网段被改过」「容器运行时不是 docker」
 * 「宿主只有 192.168/16 没有 172.17」等环境下会失效 ⇒ 自检红在**环境**上，
 * 而不是红在判据上。故按 RFC1918 **枚举**所有非 loopback 的私网 IPv4，
 * docker0 优先（CI 的 ubuntu runner 与常见开发机都有）。
 *
 * 找不到私网地址时返回 `null` ⇒ 调用方**显式 skip**（环境不满足 ≠ 判据失败）。
 */

import { networkInterfaces } from "node:os";

/**
 * 判断一个 IPv4 字面量是否落在 RFC1918 私网段。
 *
 * @param {string} address IPv4 字面量
 * @returns {boolean} 是否 RFC1918（10/8、172.16/12、192.168/16）
 */
export function isRfc1918(address) {
  return (
    /^10\./.test(address) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address) ||
    /^192\.168\./.test(address)
  );
}

/**
 * 枚举宿主上的私网 IPv4 地址。
 *
 * @param {object} [opts]
 * @param {Record<string, import('node:os').NetworkInterfaceInfo[] | undefined>} [opts.interfaces]
 *        网络接口表（默认取 `os.networkInterfaces()`；注入便于自检 fixture）
 * @returns {string[]} 私网 IPv4 字面量（按发现顺序）
 */
export function listPrivateIPv4(opts = {}) {
  const interfaces = opts.interfaces ?? networkInterfaces();
  const out = [];
  for (const list of Object.values(interfaces)) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal && isRfc1918(ni.address)) {
        out.push(ni.address);
      }
    }
  }
  return out;
}

/**
 * 挑一个宿主私网 IPv4 作为「真机自检的接收端地址」。
 *
 * 优先 docker0（`172.17.x.x`）：CI 的 ubuntu runner 与常见开发机都有它，
 * 且该地址在容器内外都稳定。
 *
 * @param {object} [opts] 同 {@link listPrivateIPv4}
 * @returns {string|null} 私网 IPv4；一个都没有 ⇒ null（调用方 skip）
 */
export function pickPrivateIPv4(opts = {}) {
  const all = listPrivateIPv4(opts);
  const docker0 = all.find((a) => a.startsWith("172.17."));
  return docker0 ?? all[0] ?? null;
}
