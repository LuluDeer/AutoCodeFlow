/**
 * E-04（DEEP_REVIEW 0ef3bbe）：SSRF 防护闸单元测试——验证 fail-closed
 * 拒绝 loopback/私网/link-local/云元数据地址，以及 allowPrivateNetwork
 * 逃生阀。
 * S-1（audit-r4）：assertSafeDnsResolution 把字面语法闸升级为「解析后 IP 级闸」，
 * 阻断 DNS rebinding（第一次解析公网 IP 通过语法闸、连接时二次解析内网 IP）。
 */

import * as dns from 'node:dns';
import { assertSafeHttpUrl, assertSafeDnsResolution } from './ssrf-guard';

jest.mock('../config', () => ({
  config: { allowPrivateNetwork: false },
}));

describe('assertSafeHttpUrl (E-04 SSRF guard)', () => {
  it('rejects non-http(s) schemes', () => {
    expect(() => assertSafeHttpUrl('file:///etc/passwd')).toThrow(/不允许的 URL 协议/);
    expect(() => assertSafeHttpUrl('ftp://example.com/file')).toThrow(/不允许的 URL 协议/);
  });

  it('rejects loopback addresses', () => {
    expect(() => assertSafeHttpUrl('http://127.0.0.1:8080/pkg.zip')).toThrow(/指向受限网络地址/);
    expect(() => assertSafeHttpUrl('http://127.0.0.2:8080/pkg.zip')).toThrow(/指向受限网络地址/);
    expect(() => assertSafeHttpUrl('http://localhost:8080/pkg.zip')).toThrow(/指向受限网络地址/);
  });

  it('rejects RFC1918 private network addresses', () => {
    expect(() => assertSafeHttpUrl('http://10.0.0.5:8080/pkg.zip')).toThrow(/受限网络地址/);
    expect(() => assertSafeHttpUrl('http://172.16.0.1:8080/pkg.zip')).toThrow(/受限网络地址/);
    expect(() => assertSafeHttpUrl('http://172.31.255.255:8080/pkg.zip')).toThrow(/受限网络地址/);
    expect(() => assertSafeHttpUrl('http://192.168.1.100:8080/pkg.zip')).toThrow(/受限网络地址/);
  });

  it('rejects cloud metadata address 169.254.169.254', () => {
    expect(() => assertSafeHttpUrl('http://169.254.169.254/latest/meta-data/')).toThrow(/受限网络地址/);
    expect(() => assertSafeHttpUrl('http://169.254.1.1/')).toThrow(/受限网络地址/);
  });

  it('rejects IPv6 loopback and link-local', () => {
    expect(() => assertSafeHttpUrl('http://[::1]:8080/pkg.zip')).toThrow(/受限网络地址/);
    expect(() => assertSafeHttpUrl('http://[fe80::1]:8080/pkg.zip')).toThrow(/受限网络地址/);
  });

  it('accepts public internet addresses', () => {
    expect(() => assertSafeHttpUrl('https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz')).not.toThrow();
    expect(() => assertSafeHttpUrl('https://example.com/pkg.zip')).not.toThrow();
  });

  // R63（2026-11-06）：旧用例标题是「accepts when allowPrivateNetwork option is
  // true」并断言 `127.0.0.1` 也被接受 —— 那一条**钉住的正是缺陷**：契约
  // `networkPolicy.addresses.loopback.allowedUnderPrivateNetwork = false`
  // （`docs/UPGRADING.md` §10 同表），开关只能解锁 privateIPv4。
  it('allowPrivateNetwork=true 只放行 privateIPv4；loopback 恒拒', () => {
    expect(() =>
      assertSafeHttpUrl('http://10.0.0.5:8080/pkg.zip', { allowPrivateNetwork: true }),
    ).not.toThrow();
    expect(() =>
      assertSafeHttpUrl('http://192.168.1.100:8080/pkg.zip', { allowPrivateNetwork: true }),
    ).not.toThrow();
    expect(() =>
      assertSafeHttpUrl('http://127.0.0.1:8080/pkg.zip', { allowPrivateNetwork: true }),
    ).toThrow(/受限网络地址/);
    expect(() =>
      assertSafeHttpUrl('http://localhost:8080/pkg.zip', { allowPrivateNetwork: true }),
    ).toThrow(/受限网络地址/);
  });

  it('rejects invalid URLs', () => {
    expect(() => assertSafeHttpUrl('not-a-url')).toThrow(/无效的 URL/);
  });
});

describe('assertSafeDnsResolution (S-1 DNS rebinding)', () => {
  it('域名解析到任一受限地址即拒绝（fail-closed，含混合公网/内网多记录）', async () => {
    const spy = jest.spyOn(dns.promises, 'lookup').mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ] as never);
    try {
      await expect(
        assertSafeDnsResolution('http://evil.example.com/pkg.zip'),
      ).rejects.toThrow(/解析到受限网络地址 10\.0\.0\.5/);
    } finally {
      spy.mockRestore();
    }
  });

  it('全部地址公网时放行，并把已校验的地址表交回调用方（供连接期钉扎）', async () => {
    const spy = jest.spyOn(dns.promises, 'lookup').mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '2606:4700::1111', family: 6 },
    ] as never);
    try {
      // R74-A1：返回值从 void 收紧为「已校验地址表」——download 用它做连接期
      // 钉扎（http.get 的 lookup 选项），消灭 resolve-then-connect 的 TOCTOU。
      // 断言从 toBeUndefined 变成逐地址相等，强度只增不减。
      await expect(
        assertSafeDnsResolution('http://public.example.com/pkg.zip'),
      ).resolves.toEqual([
        { address: '8.8.8.8', family: 4 },
        { address: '2606:4700::1111', family: 6 },
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it('DNS 解析失败 fail-closed（无法证明安全就不连）', async () => {
    const spy = jest.spyOn(dns.promises, 'lookup').mockRejectedValue(new Error('ENOTFOUND'));
    try {
      await expect(
        assertSafeDnsResolution('http://nx.example.com/pkg.zip'),
      ).rejects.toThrow(/DNS 解析失败/);
    } finally {
      spy.mockRestore();
    }
  });

  it('字面 IP 与 localhost 不触发 DNS（语法级闸已覆盖）', async () => {
    const spy = jest.spyOn(dns.promises, 'lookup');
    try {
      await assertSafeDnsResolution('http://127.0.0.1:8080/x');
      await assertSafeDnsResolution('http://[::1]:8080/x');
      await assertSafeDnsResolution('http://localhost/x');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  // R63（2026-11-06）：旧用例是「allowPrivateNetwork=true 时跳过 DNS 复核（逃生阀）」，
  // 即 `if (allow) return [];`。那是元数据绕过的入口：恒拒表判的是 URL 里的**主机名**，
  // 主机名解析到 169.254.169.254 只有在解析后才能发现 ⇒ 开关开启不能跳过解析。
  // 现在的口径：开关开启照样解析，只是 privateIPv4 的结论从 DENY 变 ALLOW。
  it('allowPrivateNetwork=true 仍做 DNS 复核；privateIPv4 目标放行', async () => {
    const spy = jest
      .spyOn(dns.promises, 'lookup')
      .mockResolvedValue([{ address: '10.0.0.5', family: 4 }] as never);
    try {
      await expect(
        assertSafeDnsResolution('http://internal.local/x', { allowPrivateNetwork: true }),
      ).resolves.toEqual([{ address: '10.0.0.5', family: 4 }]);
      // 复核确实发生了（不是旧实现的「开关即逃生」）。
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('非 http(s) scheme 直接拒绝，不发起解析', async () => {
    const spy = jest.spyOn(dns.promises, 'lookup');
    try {
      await expect(assertSafeDnsResolution('file:///etc/passwd')).rejects.toThrow(/不允许的 URL 协议/);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * R74-A1（安全面四轴审计·轴 1）：IPv6 的**数字形态**覆盖。
 *
 * 旧实现用字符串前缀黑名单判 IPv6（'fe80:'/'fe81:'/'fe82:'、'fd'/'fc'、
 * '::ffff:' 后接**点分** IPv4），三处都可被规范化后的形态绕过：
 *  - WHATWG URL 把 [::ffff:127.0.0.1] 序列化成 [::ffff:7f00:1]，
 *    '::ffff:' 分支拿到的是 "7f00:1"，按点分解析失败 → 整条回环地址放行；
 *  - link-local 是 fe80::/10（fe80–febf），只黑三个前缀漏 fe90/feb0/febf；
 *  - IPv6 组播 ff00::/8 完全未覆盖。
 * 修法是把地址展开成 8 个 16-bit 分组后按位判定（见 ssrf-guard.ts
 * parseIpv6Groups / isRestrictedIpv6Groups），本组用例是那次修复的红样本。
 */
describe('IPv6 数字形态覆盖（R74-A1 轴 1 加固）', () => {
  it('IPv4-mapped 回环/元数据的十六进制形态必须被拒', () => {
    // 先钉住 Node 的规范化行为——它是这条用例存在的理由：
    expect(new URL('http://[::ffff:127.0.0.1]/x').hostname).toBe('[::ffff:7f00:1]');
    expect(() => assertSafeHttpUrl('http://[::ffff:127.0.0.1]:8080/pkg.zip')).toThrow(/受限网络地址/);
    expect(() => assertSafeHttpUrl('http://[::ffff:7f00:1]:8080/pkg.zip')).toThrow(/受限网络地址/);
    // 0:0:0:0:0:ffff:a9fe:a9fe === 169.254.169.254（云元数据）
    expect(() => assertSafeHttpUrl('http://[0:0:0:0:0:ffff:a9fe:a9fe]/latest/meta-data/')).toThrow(
      /受限网络地址/,
    );
    // RFC1918 的映射形态
    expect(() => assertSafeHttpUrl('http://[::ffff:c0a8:101]/x')).toThrow(/受限网络地址/);
  });

  it('fe80::/10 全域与 IPv6 组播必须被拒（旧实现只黑 fe80/fe81/fe82 前缀）', () => {
    expect(() => assertSafeHttpUrl('http://[fe90::1]/x')).toThrow(/受限网络地址/);
    expect(() => assertSafeHttpUrl('http://[feb0::1]/x')).toThrow(/受限网络地址/);
    expect(() => assertSafeHttpUrl('http://[febf:ffff::1]/x')).toThrow(/受限网络地址/);
    expect(() => assertSafeHttpUrl('http://[ff02::1]/x')).toThrow(/受限网络地址/);
    expect(() => assertSafeHttpUrl('http://[ff05::1:3]/x')).toThrow(/受限网络地址/);
    // ULA（fc00::/7）原有覆盖不得回退
    expect(() => assertSafeHttpUrl('http://[fd12:3456::1]/x')).toThrow(/受限网络地址/);
    expect(() => assertSafeHttpUrl('http://[fc00::1]/x')).toThrow(/受限网络地址/);
  });

  it('公网 IPv6 与公网映射地址仍放行（加固不得变成过度封锁）', () => {
    expect(() => assertSafeHttpUrl('http://[2606:4700:4700::1111]/x')).not.toThrow();
    expect(() => assertSafeHttpUrl('http://[2001:4860:4860::8888]/x')).not.toThrow();
    // ::ffff:8.8.8.8 规范化后是 ::ffff:808:808
    expect(() => assertSafeHttpUrl('http://[::ffff:8.8.8.8]/x')).not.toThrow();
  });

  it('AAAA 记录里的十六进制映射形态同样被 DNS 闸拦下', async () => {
    const spy = jest.spyOn(dns.promises, 'lookup').mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '::ffff:7f00:1', family: 6 },
    ] as never);
    try {
      await expect(assertSafeDnsResolution('http://rebind.example.com/x')).rejects.toThrow(
        /解析到受限网络地址 ::ffff:7f00:1/,
      );
    } finally {
      spy.mockRestore();
    }
  });
});

  // R08（2026-11-05，ADR-029）：元数据地址恒拒 —— **开关开启也拒**。
  // 这是 R07 裁决点：
  // 开关早退（allow 判定）必须发生在元数据判定**之后**，否则元数据会被放行。
  it('R08: metadata address is denied even when allowPrivateNetwork is on', () => {
    for (const addr of ["100.100.100.200"]) {
      expect(() =>
        assertSafeHttpUrl(`http://${addr}/latest/meta-data/`, { allowPrivateNetwork: true }),
      ).toThrow(/元数据|metadata/i);
      expect(() => assertSafeHttpUrl(`http://${addr}/latest/meta-data/`)).toThrow();
    }
  });

  // R09（2026-11-05，ADR-029 §7）：Oracle 元数据 192.0.0.192 修前被判 public ⇒ 四姿态全放行。
  // 判据两条：分类不再是 public + 开关开启也拒。
  it('R09: 192.0.0.192 must not classify as public and must be denied', () => {
    const { classifyRestrictedIpv4 } = require('./ssrf-guard');
    expect(classifyRestrictedIpv4('192.0.0.192')).not.toBeNull();
    expect(classifyRestrictedIpv4('192.0.0.192')).not.toBe('public');
    expect(() =>
      assertSafeHttpUrl('http://192.0.0.192/opc/v2/instance/', { allowPrivateNetwork: true }),
    ).toThrow();
  });

// ---------------------------------------------------------------------------
// R63（2026-11-06）：**开关姿态与契约对齐** —— 下载面。
//
// 契约 `networkPolicy.switch.semantics`（protocol.json）只有一句话：
//   **开关开启 ⇒ 放行 privateIPv4；其余六类（loopback / linkLocal / cgnat /
//   unspecified / multicast / reserved）一律仍拒。**
// 七类的 `allowedUnderPrivateNetwork` 逐类写死，`docs/UPGRADING.md` §10 的
// 行为变更表也是同一张（并明确点名 `assertSafeHttpUrl` 的 `if (allow) return;`
// 是**升级前**的行为）。
//
// 而下载面（本文件测的 ssrf-guard）在 R63 前仍是旧姿态：元数据恒拒表之后
// `if (allow) return;` 直接返回 ⇒ 开关一开，`169.254.169.254`（云元数据）、
// `fd00:ec2::254`（AWS IPv6 元数据）、CGNAT、unspecified、multicast、reserved、
// loopback 全部放行。gitRepo 面（`git-repo-network-policy.categoryAllowed`）
// 却是契约口径 ⇒ **同一个开关、两条出站通道、两种承诺**，与 ADR-032 记录的
// python 缺陷同族（那边是「除 loopback 外全放」）。
//
// 下面两组用例是这次修复的红样本：第一组在旧实现必红（放行 = 不抛），
// 第二组是「不许收成 deny-all」的反证（内网自建 GitLab 是文档化拓扑）。
// ---------------------------------------------------------------------------

describe('R63: 开关开启只解锁 privateIPv4（契约 networkPolicy.switch.semantics）', () => {
  /** 契约 `allowedUnderPrivateNetwork: false` 的六类代表地址（开关开启也必须拒）。 */
  const MUST_STILL_DENY_UNDER_SWITCH: Array<[string, string]> = [
    ['loopback 127.0.0.1', '127.0.0.1'],
    ['loopback localhost', 'localhost'],
    ['IPv6 loopback [::1]', '[::1]'],
    ['云元数据 169.254.169.254', '169.254.169.254'],
    ['linkLocal 非恒拒表成员 169.254.1.1', '169.254.1.1'],
    ['AWS IPv6 元数据 [fd00:ec2::254]', '[fd00:ec2::254]'],
    ['IPv6 link-local [fe80::1]', '[fe80::1]'],
    ['CGNAT 100.64.0.1', '100.64.0.1'],
    ['unspecified 0.0.0.0', '0.0.0.0'],
    ['multicast 224.0.0.1', '224.0.0.1'],
    ['reserved 240.0.0.1', '240.0.0.1'],
    ['Oracle 元数据 192.0.0.192', '192.0.0.192'],
    ['IPv4-mapped 云元数据 [::ffff:169.254.169.254]', '[::ffff:169.254.169.254]'],
  ];

  it.each(MUST_STILL_DENY_UNDER_SWITCH)(
    '开关开启仍拒绝 %s（旧实现放行 ⇒ 本用例红）',
    (_name, host) => {
      expect(() =>
        assertSafeHttpUrl(`http://${host}/pkg.zip`, { allowPrivateNetwork: true }),
      ).toThrow(/受限网络地址|元数据/);
    },
  );

  it('开关开启仍放行 privateIPv4 与公网（不得收成 deny-all）', () => {
    for (const host of ['10.0.0.5', '172.16.0.1', '192.168.1.100', '8.8.8.8', 'registry.npmjs.org']) {
      expect(() =>
        assertSafeHttpUrl(`http://${host}/pkg.zip`, { allowPrivateNetwork: true }),
      ).not.toThrow();
    }
  });

  it('开关**关闭**时 privateIPv4 仍拒（默认安全姿态不回归）', () => {
    expect(() => assertSafeHttpUrl('http://10.0.0.5/pkg.zip')).toThrow(/受限网络地址/);
  });

  it('DNS 闸：开关开启时仍拦「主机名解析到云元数据」，但放行解析到 privateIPv4', async () => {
    // 旧实现 `if (allow) return []` 在解析之前就返回 ⇒ 攻击者控制的域名把 A
    // 记录指到 169.254.169.254 即可绕过恒拒表（元数据判定看的是 URL 里的
    // 主机名，不是解析结果）。开关开启不是「关掉 DNS 级复核」的理由。
    const spy = jest.spyOn(dns.promises, 'lookup').mockResolvedValue([
      { address: '169.254.169.254', family: 4 },
    ] as never);
    try {
      await expect(
        assertSafeDnsResolution('http://rebind.attacker.example/x', { allowPrivateNetwork: true }),
      ).rejects.toThrow(/受限网络地址/);

      // 反证：解析到 RFC1918（内网自建 GitLab 拓扑）在开关开启时仍必须放行。
      spy.mockResolvedValue([{ address: '10.0.0.5', family: 4 }] as never);
      await expect(
        assertSafeDnsResolution('http://gitlab.corp/x', { allowPrivateNetwork: true }),
      ).resolves.toEqual([{ address: '10.0.0.5', family: 4 }]);
    } finally {
      spy.mockRestore();
    }
  });

  it('两条出站通道口径一致：下载面（ssrf-guard）与 gitRepo 面（categoryAllowed）逐类同判', () => {
    const { categoryAllowed } = require('../git-repo-network-policy');
    const { isRestrictedAddressForPolicy } = require('./ssrf-guard');
    const matrix = [
      '127.0.0.1', 'localhost', '169.254.169.254', '169.254.1.1', 'fd00:ec2::254',
      'fe80::1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '240.0.0.1',
      '10.0.0.5', '172.16.0.1', '192.168.1.1', '8.8.8.8',
    ];
    for (const host of matrix) {
      const category = isRestrictedAddressForPolicy(host);
      const expectedPass = categoryAllowed(category, true);
      const url = `http://${host.includes(':') ? `[${host}]` : host}/pkg.zip`;
      const verdict = (() => {
        try {
          assertSafeHttpUrl(url, { allowPrivateNetwork: true });
          return 'pass';
        } catch {
          return 'deny';
        }
      })();
      expect({ host, verdict }).toEqual({ host, verdict: expectedPass ? 'pass' : 'deny' });
    }
  });
});
