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
    expect(() => assertSafeHttpUrl('file:///etc/passwd')).toThrow(/scheme not allowed/);
    expect(() => assertSafeHttpUrl('ftp://example.com/file')).toThrow(/scheme not allowed/);
  });

  it('rejects loopback addresses', () => {
    expect(() => assertSafeHttpUrl('http://127.0.0.1:8080/pkg.zip')).toThrow(/restricted network address/);
    expect(() => assertSafeHttpUrl('http://127.0.0.2:8080/pkg.zip')).toThrow(/restricted network address/);
    expect(() => assertSafeHttpUrl('http://localhost:8080/pkg.zip')).toThrow(/restricted network address/);
  });

  it('rejects RFC1918 private network addresses', () => {
    expect(() => assertSafeHttpUrl('http://10.0.0.5:8080/pkg.zip')).toThrow(/restricted/);
    expect(() => assertSafeHttpUrl('http://172.16.0.1:8080/pkg.zip')).toThrow(/restricted/);
    expect(() => assertSafeHttpUrl('http://172.31.255.255:8080/pkg.zip')).toThrow(/restricted/);
    expect(() => assertSafeHttpUrl('http://192.168.1.100:8080/pkg.zip')).toThrow(/restricted/);
  });

  it('rejects cloud metadata address 169.254.169.254', () => {
    expect(() => assertSafeHttpUrl('http://169.254.169.254/latest/meta-data/')).toThrow(/restricted/);
    expect(() => assertSafeHttpUrl('http://169.254.1.1/')).toThrow(/restricted/);
  });

  it('rejects IPv6 loopback and link-local', () => {
    expect(() => assertSafeHttpUrl('http://[::1]:8080/pkg.zip')).toThrow(/restricted/);
    expect(() => assertSafeHttpUrl('http://[fe80::1]:8080/pkg.zip')).toThrow(/restricted/);
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
    expect(() => assertSafeHttpUrl('not-a-url')).toThrow(/Invalid URL/);
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
      ).rejects.toThrow(/resolves to restricted network address 10\.0\.0\.5/);
    } finally {
      spy.mockRestore();
    }
  });

  it('全部地址公网时放行', async () => {
    const spy = jest.spyOn(dns.promises, 'lookup').mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '2606:4700::1111', family: 6 },
    ] as never);
    try {
      await expect(
        assertSafeDnsResolution('http://public.example.com/pkg.zip'),
      ).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('DNS 解析失败 fail-closed（无法证明安全就不连）', async () => {
    const spy = jest.spyOn(dns.promises, 'lookup').mockRejectedValue(new Error('ENOTFOUND'));
    try {
      await expect(
        assertSafeDnsResolution('http://nx.example.com/pkg.zip'),
      ).rejects.toThrow(/failed DNS resolution/);
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
      await expect(assertSafeDnsResolution('file:///etc/passwd')).rejects.toThrow(/scheme not allowed/);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
