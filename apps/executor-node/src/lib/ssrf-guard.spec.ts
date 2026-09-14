/**
 * E-04（DEEP_REVIEW 0ef3bbe）：SSRF 防护闸单元测试——验证 fail-closed
 * 拒绝 loopback/私网/link-local/云元数据地址，以及 allowPrivateNetwork
 * 逃生阀。
 */

import { assertSafeHttpUrl } from './ssrf-guard';

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
