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

  it('accepts when allowPrivateNetwork option is true', () => {
    expect(() =>
      assertSafeHttpUrl('http://127.0.0.1:8080/pkg.zip', { allowPrivateNetwork: true }),
    ).not.toThrow();
    expect(() =>
      assertSafeHttpUrl('http://10.0.0.5:8080/pkg.zip', { allowPrivateNetwork: true }),
    ).not.toThrow();
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

  it('allowPrivateNetwork=true 时跳过 DNS 复核（逃生阀）', async () => {
    const spy = jest.spyOn(dns.promises, 'lookup');
    try {
      await assertSafeDnsResolution('http://internal.local/x', { allowPrivateNetwork: true });
      expect(spy).not.toHaveBeenCalled();
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
