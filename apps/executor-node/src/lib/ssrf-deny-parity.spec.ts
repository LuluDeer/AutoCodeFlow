/**
 * R77：**跨 app 的 SSRF 拒绝矩阵对齐**。
 *
 * 背景：`admin-api` 侧早在 SEC-04 就把 SSRF 判定收敛成一张 `SSRF_DENY_HOST_PATTERNS` 表 +
 * `parseIpv6Groups` 按位求值（`ssrf-deny-matrix.spec.ts` 有 18 条危险地址矩阵）。
 * 而 `executor-node` 侧一直是**同一道闸的第二份实现**，而且是弱版本 —— R74-A1 实测它能把
 * `[::ffff:127.0.0.1]`（WHATWG 规范化为 `[::ffff:7f00:1]`）整条放行，等于 SSRF 闸对一个
 * 能连回环的地址说了 OK。
 *
 * 也就是说：「同一个安全判据被实现了两遍，其中一遍至今没跟上」。这正是本仓反复出现的
 * **「同一修法只落一半」**家族，只不过载体从一个函数的两处调用点，变成两个 app。
 *
 * 本 spec 把 admin-api 的 18 条危险地址**镜像过来**，逐条断言 executor-node 的出站闸默认拒绝
 * （无 `EXECUTOR_ALLOW_PRIVATE_NETWORK` 逃生）。
 *
 * 镜像不会自动同步 —— 由 `scripts/check-ssrf-deny-parity.mjs` 守：admin-api 的矩阵里出现、
 * 而本文件里没有的地址，守卫直接红。**往 admin-api 加危险段时，记得加到这里。**
 */
import { assertSafeHttpUrl } from './ssrf-guard';

/** 与 `apps/admin-api/src/common/utils/__tests__/ssrf-deny-matrix.spec.ts` 的 addr 列一一对应。 */
const DANGER_ADDRESSES: Array<{ name: string; addr: string }> = [
  { name: "IPv4 loopback", addr: "127.0.0.1" },
  { name: "IPv4 RFC1918 10/8", addr: "10.1.2.3" },
  { name: "IPv4 RFC1918 172.16/12", addr: "172.16.0.1" },
  { name: "IPv4 CGNAT lower bound", addr: "100.64.0.1" },
  { name: "IPv4 unspecified", addr: "0.0.0.0" },
  { name: "IPv4 multicast", addr: "224.0.0.1" },
  { name: "IPv4 reserved 240/4", addr: "240.0.0.1" },
  { name: "IPv4 broadcast", addr: "255.255.255.255" },
  { name: "IPv6 loopback", addr: "::1" },
  { name: "IPv6 unspecified", addr: "::" },
  { name: "IPv6 ULA fd00::/8", addr: "fd00::1234" },
  { name: "IPv6 ULA fc00::", addr: "fc00::1" },
  { name: "IPv6 link-local fe80::", addr: "fe80::a1" },
  { name: "IPv6 link-local febf::", addr: "febf::ffff" },
  { name: "IPv6 multicast", addr: "ff02::1" },
  { name: "mapped private", addr: "::ffff:10.0.0.1" },
  { name: "mapped benchmark", addr: "::ffff:198.18.0.1" },
  { name: "mapped CGNAT (hex)", addr: "::ffff:6440:5" },
];

describe('SSRF 拒绝矩阵与 admin-api 对齐（R77）', () => {
  it.each(DANGER_ADDRESSES)('默认拒绝 $name（$addr）', ({ addr }) => {
    const host = addr.includes(':') ? `[${addr}]` : addr;
    expect(() => assertSafeHttpUrl(`http://${host}/pkg.zip`)).toThrow(/受限网络地址/);
  });
});
